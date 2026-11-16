//! The Sidekick core: chat history, the notification feed, sync, the scheduler
//! (reminders + daily sync), file watching, settings and the info for the settings window.
//! UI windows get updates through one Tauri event, `sidekick`, carrying `{ type, data }`.

use crate::claude::{ClaudeEvent, ClaudeSession, Connector};
use crate::config::{self, Config};
use crate::files::{hex_id, is_test_run, now_iso, read_json, write_json};
use crate::proc;
use crate::store::{self, NewTask, Reminder, Task};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub kind: String, // reminder | sync | task | error | info
    pub title: String,
    pub body: String,
    pub link: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub state: String,
    pub model: Option<String>,
    pub connectors: Vec<Connector>,
}

struct State {
    config: Config,
    status: Status,
    history: Vec<Value>, // replay buffer so a newly opened window sees the current chat
    notifications: Vec<Notification>,
    reply: String,           // text of the answer being streamed
    syncing: Option<usize>,  // new tasks seen during the running sync
    known_task_ids: HashSet<String>,
    mcp_cache: Option<(Instant, Vec<Connector>)>,
}

pub struct Core {
    pub dir: PathBuf,
    app: AppHandle,
    pub claude: Arc<ClaudeSession>,
    state: Mutex<State>,
}

fn chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

impl Core {
    pub fn new(app: AppHandle, dir: PathBuf) -> Arc<Core> {
        let _ = std::fs::create_dir_all(&dir);
        let config = config::load(&dir);
        config::save(&dir, &config); // writes defaults so they're visible in the file
        let (tx, rx) = mpsc::unbounded_channel();
        let claude = ClaudeSession::new(&dir, config.clone(), tx);
        let status = Status { state: if claude.ready() { "idle".into() } else { "missing".into() }, model: None, connectors: vec![] };
        store::prune_tasks(&dir);
        let known_task_ids = store::load_tasks(&dir).into_iter().map(|t| t.id).collect();
        let notifications = read_json(&dir.join("notifications.json")).unwrap_or_default();
        let core = Arc::new(Core {
            dir,
            app,
            claude,
            state: Mutex::new(State { config, status, history: vec![], notifications, reply: String::new(), syncing: None, known_task_ids, mcp_cache: None }),
        });
        core.spawn_claude_listener(rx);
        core.spawn_scheduler();
        core.spawn_file_watcher();
        if core.claude.ready() {
            let _ = core.claude.start(); // warm up so the first message is fast
        }
        core
    }

    pub fn config(&self) -> Config {
        self.state.lock().unwrap().config.clone()
    }

    // ---------- event stream ----------
    fn emit(&self, ty: &str, data: Value) {
        if is_test_run() && std::env::var("SIDEKICK_LOG").is_ok() {
            let text: String = data.to_string().chars().take(160).collect();
            eprintln!("[event] {ty} {text}");
        }
        let _ = self.app.emit("sidekick", json!({ "type": ty, "data": data }));
    }
    fn record(&self, ty: &str, data: Value) {
        {
            let mut s = self.state.lock().unwrap();
            s.history.push(json!({ "type": ty, "data": data }));
            let len = s.history.len();
            if len > 2000 {
                s.history.drain(..len - 2000);
            }
        }
        self.emit(ty, data);
    }

    pub fn hello(&self) -> Value {
        let s = self.state.lock().unwrap();
        json!({
            "status": s.status,
            "history": s.history,
            "config": s.config,
            "tasks": store::load_tasks(&self.dir),
            "reminders": store::load_reminders(&self.dir),
            "notifications": s.notifications,
            "skin": self.skin_file().is_some(),
        })
    }

    // ---------- notifications (the mascot's notifier) ----------
    fn save_notifications(&self, list: &[Notification]) {
        let _ = write_json(&self.dir.join("notifications.json"), list);
    }
    pub fn notify(&self, kind: &str, title: &str, body: &str, link: &str) {
        let n = Notification {
            id: hex_id(),
            kind: kind.into(),
            title: chars(title, 160),
            body: chars(body, 400),
            link: if link.starts_with("http://") || link.starts_with("https://") { link.into() } else { String::new() },
            at: now_iso(),
        };
        {
            let mut s = self.state.lock().unwrap();
            s.notifications.insert(0, n.clone()); // newest first
            s.notifications.truncate(50);
            self.save_notifications(&s.notifications);
        }
        self.emit("notify", json!(n));
    }
    pub fn clear_notifications(&self) {
        let mut s = self.state.lock().unwrap();
        s.notifications.clear();
        self.save_notifications(&s.notifications);
        drop(s);
        self.emit("notifications", json!([]));
    }
    pub fn remove_notification(&self, id: &str) -> bool {
        let mut s = self.state.lock().unwrap();
        let before = s.notifications.len();
        s.notifications.retain(|n| n.id != id);
        let removed = s.notifications.len() != before;
        self.save_notifications(&s.notifications);
        let list = json!(s.notifications);
        drop(s);
        self.emit("notifications", list);
        removed
    }

    // ---------- Claude Code ----------
    fn spawn_claude_listener(self: &Arc<Self>, mut rx: mpsc::UnboundedReceiver<ClaudeEvent>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = rx.recv().await {
                me.on_claude(ev);
            }
        });
    }

    fn on_claude(&self, ev: ClaudeEvent) {
        match ev {
            ClaudeEvent::Status { state, model, connectors } => {
                let status = {
                    let mut s = self.state.lock().unwrap();
                    s.status.state = state.into();
                    if model.is_some() {
                        s.status.model = model;
                    }
                    if let Some(c) = connectors {
                        s.status.connectors = c;
                    }
                    s.status.clone()
                };
                self.emit("status", json!(status));
            }
            ClaudeEvent::Delta(t) => {
                self.state.lock().unwrap().reply.push_str(&t);
                self.record("delta", json!(t));
            }
            ClaudeEvent::Tool(n) => self.record("tool", json!(n)),
            ClaudeEvent::Note(n) => self.record("note", json!(n)),
            ClaudeEvent::Done => {
                self.record("done", Value::Null);
                let (syncing, reply) = {
                    let mut s = self.state.lock().unwrap();
                    (s.syncing.take(), s.reply.trim().to_string())
                };
                if let Some(n) = syncing {
                    let title = match n {
                        0 => "Sync finished · nothing new".to_string(),
                        1 => "Sync finished · 1 new task".to_string(),
                        n => format!("Sync finished · {n} new tasks"),
                    };
                    self.notify("sync", &title, &reply, "");
                }
            }
            ClaudeEvent::Error(e) => {
                self.record("failure", json!(e));
                let syncing = self.state.lock().unwrap().syncing.take();
                if syncing.is_some() {
                    self.notify("error", "Sync didn't finish", &e, "");
                } else if !e.starts_with("Still working") {
                    self.notify("error", "Something went wrong", &e, "");
                }
            }
        }
    }

    pub fn chat(self: &Arc<Self>, text: &str) -> Result<(), String> {
        let t = text.trim();
        if t.is_empty() {
            return Err("empty message".into());
        }
        self.state.lock().unwrap().reply.clear();
        self.record("user", json!(t));
        self.claude.send(t);
        Ok(())
    }

    pub fn reset(&self) {
        self.claude.reset();
        self.state.lock().unwrap().history.clear();
        self.emit("reset", Value::Null);
    }

    fn sync_prompt(&self) -> String {
        let on = self.config().integrations;
        let parts: Vec<&str> = [
            (on.github, "my GitHub inbox"),
            (on.gmail, "my Gmail if it's connected"),
            (on.calendar, "my Google Calendar if it's connected"),
            (on.youtube, "new videos from the YouTube channels I follow"),
        ]
        .iter()
        .filter(|p| p.0)
        .map(|p| p.1)
        .collect();
        let what = if parts.is_empty() { "my task board".to_string() } else { parts.join(", ") };
        format!("Sync now: check {what}. Put what I need to act on onto the task board (skip anything already there), then give me a short summary.")
    }

    fn today() -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }
    fn state_file(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    /// Start a sync; false when Claude Code is busy or missing.
    pub fn sync(self: &Arc<Self>, daily: bool) -> bool {
        if self.claude.busy() || !self.claude.ready() {
            return false;
        }
        let mut st: BTreeMap<String, Value> = read_json(&self.state_file()).unwrap_or_default();
        st.insert("lastSync".into(), json!(Self::today()));
        let _ = write_json(&self.state_file(), &st);
        {
            let mut s = self.state.lock().unwrap();
            s.syncing = Some(0);
            s.reply.clear();
        }
        self.record("user", json!(if daily { "🗞 Daily sync…" } else { "🔄 Sync…" }));
        self.claude.send(&self.sync_prompt());
        true
    }

    // ---------- scheduler ----------
    fn spawn_scheduler(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await; // give Claude Code a moment before a catch-up sync
            loop {
                me.tick();
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }

    fn tick(self: &Arc<Self>) {
        for r in store::take_due_reminders(&self.dir, chrono::Utc::now().timestamp_millis()) {
            self.record("reminder", json!(r));
            let body = if r.repeat != "none" { format!("Repeats {}", r.repeat) } else { "Reminder".into() };
            self.notify("reminder", &r.text, &body, "");
            crate::shell::system_notification(&self.app, "Sidekick reminder", &r.text);
        }
        let at = self.config().daily_sync_time;
        if let Some(at) = at {
            let last: Option<String> = read_json::<BTreeMap<String, Value>>(&self.state_file())
                .and_then(|m| m.get("lastSync").and_then(|v| v.as_str().map(String::from)));
            let now = chrono::Local::now().format("%H:%M").to_string();
            // Also catches up right after boot if the PC was off at sync time.
            if !is_test_run() && last.as_deref() != Some(&Self::today()) && now >= at {
                self.sync(true);
            }
        }
    }

    // ---------- files the MCP process changes (Claude edits them) ----------
    fn spawn_file_watcher(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let stamp = |name: &str| -> Option<(SystemTime, u64)> {
                let m = std::fs::metadata(me.dir.join(name)).ok()?;
                Some((m.modified().ok()?, m.len()))
            };
            let names = ["tasks.json", "reminders.json", "config.json"];
            let mut last: Vec<_> = names.iter().map(|n| stamp(n)).collect();
            loop {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                for (i, n) in names.iter().enumerate() {
                    let now = stamp(n);
                    if now == last[i] {
                        continue;
                    }
                    last[i] = now;
                    match *n {
                        "tasks.json" => me.push_tasks(),
                        "reminders.json" => me.emit("reminders", json!(store::load_reminders(&me.dir))),
                        _ => {
                            let fresh = config::load(&me.dir);
                            if fresh != me.config() {
                                me.apply_config(fresh);
                            }
                        }
                    }
                }
            }
        });
    }

    fn push_tasks(&self) {
        let list = store::load_tasks(&self.dir);
        let mut fresh: Vec<Task> = vec![];
        {
            let mut s = self.state.lock().unwrap();
            for t in &list {
                if s.known_task_ids.contains(&t.id) || t.source == "me" {
                    continue;
                }
                match s.syncing.as_mut() {
                    Some(n) => *n += 1, // summed up in the sync notification
                    None => fresh.push(t.clone()),
                }
            }
            s.known_task_ids = list.iter().map(|t| t.id.clone()).collect();
        }
        for t in fresh {
            self.notify("task", &format!("New task: {}", t.title), &t.notes, &t.link);
        }
        self.emit("tasks", json!(list));
    }

    // ---------- tasks & reminders from the UI ----------
    pub fn tasks(&self) -> Vec<Task> {
        store::load_tasks(&self.dir)
    }
    pub fn add_task(&self, title: &str) -> Result<Value, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("empty task".into());
        }
        let (task, duplicate) = store::add_task(&self.dir, NewTask { title: title.into(), source: Some("me".into()), ..Default::default() });
        self.push_tasks();
        Ok(json!({ "task": task, "duplicate": duplicate }))
    }
    pub fn update_task(&self, id: &str, done: Option<bool>, title: Option<String>) -> Result<Task, String> {
        let t = store::update_task(&self.dir, id, done, title.as_deref());
        self.push_tasks();
        t.ok_or_else(|| "no such task".into())
    }
    pub fn remove_task(&self, id: &str) -> bool {
        let r = store::remove_task(&self.dir, id);
        self.push_tasks();
        r
    }
    pub fn reminders(&self) -> Vec<Reminder> {
        store::load_reminders(&self.dir)
    }
    pub fn remove_reminder(&self, id: &str) -> bool {
        let r = store::remove_reminder(&self.dir, id);
        self.emit("reminders", json!(store::load_reminders(&self.dir)));
        r
    }

    // ---------- settings ----------
    pub fn settings(&self) -> Value {
        json!({ "config": self.config(), "defaults": Config::default(), "options": config::options() })
    }
    pub fn patch_settings(self: &Arc<Self>, patch: &Value) -> Result<Config, String> {
        let current = config::load(&self.dir); // fresh: Claude may have changed it (youtube_follow)
        let next = config::validate_patch(patch, &current)?;
        config::save(&self.dir, &next);
        self.apply_config(next.clone());
        Ok(next)
    }
    fn apply_config(self: &Arc<Self>, next: Config) {
        let ai_changed = {
            let mut s = self.state.lock().unwrap();
            let changed = s.config.ai_differs(&next);
            s.config = next.clone();
            changed
        };
        self.emit("config", json!(next));
        if ai_changed {
            self.claude.restart(Some(next.clone()));
        } else {
            self.claude.set_config(next.clone());
        }
        crate::shell::apply_config(&self.app, &next);
    }

    // ---------- info for the settings window ----------
    async fn mcp_list(&self) -> Vec<Connector> {
        if let Some((at, list)) = &self.state.lock().unwrap().mcp_cache {
            if at.elapsed() < Duration::from_secs(60) {
                return list.clone();
            }
        }
        let Some(cp) = self.claude.claude_path.clone() else { return vec![] };
        let r = proc::run(&cp, &["mcp", "list"], 45, Some(&self.claude.work_dir)).await;
        let line_re = regex::Regex::new(r"^(.+?): (\S.*) - (.+)$").unwrap();
        let list: Vec<Connector> = r
            .stdout
            .lines()
            .filter_map(|line| {
                let m = line_re.captures(line.trim_end())?;
                let s = m[3].to_lowercase();
                let status = if s.contains("connected") && !s.contains("fail") && !s.contains("not") {
                    "connected"
                } else if s.contains("auth") {
                    "needs-auth"
                } else if s.contains("pending") {
                    "pending"
                } else {
                    "failed"
                };
                let name = m[1].trim().to_string();
                let source = if name.starts_with("claude.ai ") { "claudeai" } else { "user" };
                Some(Connector { name, status: status.into(), source: Some(source.into()) })
            })
            .collect();
        self.state.lock().unwrap().mcp_cache = Some((Instant::now(), list.clone()));
        list
    }

    pub async fn info(&self) -> Value {
        let cp = self.claude.claude_path.clone();
        let (ver, auth, gh, mcp) = tokio::join!(
            async {
                match &cp {
                    Some(p) => Some(proc::run(p, &["--version"], 15, None).await),
                    None => None,
                }
            },
            async {
                match &cp {
                    Some(p) => Some(proc::run(p, &["auth", "status"], 15, None).await),
                    None => None,
                }
            },
            proc::run("gh", &["auth", "status"], 15, None),
            self.mcp_list(),
        );
        let auth_info = auth.and_then(|a| serde_json::from_str::<Value>(&a.stdout).ok()).map(|a| {
            json!({
                "loggedIn": a["loggedIn"].as_bool().unwrap_or(false),
                "authMethod": a["authMethod"], "apiProvider": a["apiProvider"],
                "subscriptionType": a["subscriptionType"], "email": a["email"], "orgName": a["orgName"],
            })
        });
        let gh_text = format!("{}{}", gh.stdout, gh.stderr);
        let gh_user = regex::Regex::new(r"account (\S+)").unwrap().captures(&gh_text).map(|c| c[1].to_string());
        // Live status from the running session wins over `claude mcp list`.
        let mut by_name: Vec<Connector> = mcp;
        let live = self.state.lock().unwrap().status.connectors.clone();
        for c in live {
            let source = if c.name == "sidekick" {
                "sidekick".to_string()
            } else {
                by_name.iter().find(|x| x.name == c.name).and_then(|x| x.source.clone()).unwrap_or_else(|| {
                    if c.name.starts_with("claude.ai ") { "claudeai".into() } else { "user".into() }
                })
            };
            by_name.retain(|x| x.name != c.name);
            by_name.push(Connector { name: c.name, status: c.status, source: Some(source) });
        }
        if !by_name.iter().any(|c| c.name == "sidekick") {
            by_name.push(Connector {
                name: "sidekick".into(),
                status: if self.claude.ready() { "connected".into() } else { "failed".into() },
                source: Some("sidekick".into()),
            });
        }
        let version = ver.filter(|v| v.ok).map(|v| v.stdout.split_whitespace().next().unwrap_or("").to_string());
        json!({
            "app": {
                "name": "Sidekick",
                "version": self.app.package_info().version.to_string(),
                "tauri": tauri::VERSION,
                "webview": tauri::webview_version().ok(),
                "platform": format!("Windows {}", os_version()),
                "arch": std::env::consts::ARCH,
            },
            "dataDir": self.dir.to_string_lossy(),
            "claude": {
                "found": cp.is_some(),
                "path": cp.as_ref().map(|p| p.to_string_lossy().to_string()),
                "version": version,
                "auth": auth_info,
            },
            "github": { "installed": !gh.missing, "loggedIn": gh_text.contains("Logged in to"), "user": gh_user },
            "connectors": by_name,
        })
    }

    // ---------- account & connections ----------
    pub fn claude_login(&self, method: &str) -> Result<(), String> {
        let cp = self.claude.claude_path.clone().ok_or("Claude Code isn't installed")?;
        if method != "claudeai" && method != "console" {
            return Err("method must be claudeai or console".into());
        }
        proc::open_terminal(&[&cp.to_string_lossy(), "auth", "login", &format!("--{method}")])?;
        self.state.lock().unwrap().mcp_cache = None;
        Ok(())
    }
    pub async fn claude_logout(self: &Arc<Self>) -> Result<Value, String> {
        let cp = self.claude.claude_path.clone().ok_or("Claude Code isn't installed")?;
        let r = proc::run(&cp, &["auth", "logout"], 20, None).await;
        self.claude.restart(None);
        if !r.ok {
            let msg = format!("{}{}", r.stderr, r.stdout);
            return Err(if msg.trim().is_empty() { "Sign-out failed".into() } else { msg.trim().into() });
        }
        let a = proc::run(&cp, &["auth", "status"], 15, None).await;
        Ok(serde_json::from_str(&a.stdout).unwrap_or(Value::Null))
    }
    pub fn restart_claude(self: &Arc<Self>) {
        self.claude.restart(None);
    }
    pub fn github_login(&self) -> Result<(), String> {
        proc::open_terminal(&["gh", "auth", "login"])
    }
    pub async fn mcp_login(&self, name: &str) -> Result<(), String> {
        let mut known: Vec<String> = self.mcp_list().await.into_iter().map(|c| c.name).collect();
        known.extend(self.state.lock().unwrap().status.connectors.iter().map(|c| c.name.clone()));
        let safe = regex::Regex::new(r"^[\w .-]{1,80}$").unwrap().is_match(name);
        if !known.iter().any(|k| k == name) || !safe {
            return Err("Unknown MCP server".into());
        }
        let cp = self.claude.claude_path.clone().ok_or("Claude Code isn't installed")?;
        proc::open_terminal(&[&cp.to_string_lossy(), "mcp", "login", name])?;
        self.state.lock().unwrap().mcp_cache = None;
        Ok(())
    }

    // ---------- custom mascot image ----------
    fn skin_file(&self) -> Option<(PathBuf, &'static str)> {
        [("png", "image/png"), ("gif", "image/gif"), ("webp", "image/webp")]
            .into_iter()
            .map(|(ext, ty)| (self.dir.join(format!("mascot.{ext}")), ty))
            .find(|(p, _)| p.exists())
    }
    /// The custom mascot image as a data: URL, if there is one (max 5 MB).
    pub fn skin(&self) -> Option<String> {
        use base64::Engine;
        let (path, ty) = self.skin_file()?;
        let bytes = std::fs::read(path).ok().filter(|b| b.len() <= 5 * 1024 * 1024)?;
        Some(format!("data:{ty};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    pub fn shutdown(&self) {
        self.claude.stop();
    }
}

fn os_version() -> String {
    // e.g. "10.0.26200" from the `ver` output; good enough for the About tab.
    let out = std::process::Command::new("cmd").args(["/c", "ver"]).output();
    #[cfg(windows)]
    let _ = ();
    out.ok()
        .and_then(|o| {
            let t = String::from_utf8_lossy(&o.stdout).to_string();
            regex::Regex::new(r"(\d+\.\d+\.\d+)").unwrap().captures(&t).map(|c| c[1].to_string())
        })
        .unwrap_or_default()
}
