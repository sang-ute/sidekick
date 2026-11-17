//! Bridge to the locally installed Claude Code CLI, using the user's own Claude login.
//! One long-lived `claude -p` process per conversation, talking newline-delimited JSON
//! over stdin/stdout. If it dies, the next message resumes the session (`--resume`).

use crate::config::{Config, McpServer};
use crate::proc;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Connector {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// What the session reports to the core.
#[derive(Debug)]
pub enum ClaudeEvent {
    Status { state: &'static str, model: Option<String>, connectors: Option<Vec<Connector>> },
    Delta(String),
    Tool(String),
    Note(String),
    Done,
    Error(String),
}

fn style(s: &str) -> &'static str {
    match s {
        "brief" => "Keep replies to one to three short lines unless the user asks for more.",
        "detailed" => {
            "Give complete answers: explain your reasoning and list steps when useful, still using simple formatting."
        }
        _ => "Be brief by default: a few short lines, with more detail only when it helps.",
    }
}

/// The system prompt, built from what the user has switched on in settings.
pub fn system_prompt(cfg: &Config) -> String {
    let on = &cfg.integrations;
    let mut tools = vec![
        "- Reminders: create_reminder / list_reminders / delete_reminder. They fire as desktop notifications at the exact time. Resolve relative times (\"in 20 minutes\", \"Friday morning\") against the [now: ...] tag and confirm the exact date and time.".to_string(),
        "- Task board: add_task / list_tasks / complete_task / delete_task. The board is pinned in the app. Use it for things the user needs to act on.".to_string(),
    ];
    if on.github {
        tools.push("- GitHub: github_inbox (read-only, via the user's gh login).".into());
    }
    if on.youtube {
        tools.push("- YouTube: youtube_latest, youtube_follow.".into());
    }
    let google: Vec<&str> =
        [(on.gmail, "Gmail"), (on.calendar, "Google Calendar")].iter().filter(|x| x.0).map(|x| x.1).collect();
    if !google.is_empty() {
        tools.push(format!("- {}: claude.ai connectors, when the user has connected them. If a connector's tools aren't available, say it needs connecting at claude.ai → Settings → Connectors (or in Sidekick settings → Connections).", google.join(" / ")));
    }
    if on.web {
        tools.push("- Web search and page reading for fresh information.".into());
    }
    if !cfg.mcp_servers.is_empty() {
        tools.push(format!(
            "- The user's own MCP servers: {}.",
            cfg.mcp_servers.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    let mut sync = vec!["1. list_tasks first so you don't add duplicates.".to_string()];
    if on.github {
        sync.push("- github_inbox: add a task for each PR waiting for their review and each assigned issue (source github, with link). Notifications can be stale (a failed CI run may already be fixed by a later run), so mention them as \"worth a look\", not as emergencies.".into());
    }
    if on.gmail {
        sync.push("- Gmail (if connected): search recent unread mail in the inbox; add a task only for mail that needs a reply or action (source gmail, with link if you have one). Skip newsletters, promotions and notifications.".into());
    }
    if on.calendar {
        sync.push("- Google Calendar (if connected): note today's and tomorrow's events; add a task only when something needs preparing (source calendar).".into());
    }
    if on.youtube {
        sync.push("- youtube_latest: add one task per new video worth watching (source youtube, with link).".into());
    }
    sync.push("- Finish with a 2-4 line summary: what's new and the most important thing to do first.".into());
    let lang = if cfg.language.is_empty() {
        "Reply in the language the user writes in.".to_string()
    } else {
        format!("Always reply in {}.", cfg.language)
    };
    [
        vec![
            "You are Sidekick, a small personal assistant who lives on the user's Windows desktop as a little blue mascot, running on Claude Code.".to_string(),
            format!("Replies show in a small chat panel, so use simple formatting. {}", style(&cfg.response_style)),
            lang,
            String::new(),
            "Your tools:".into(),
        ],
        tools,
        vec![String::new(), "When asked to sync or check what's new:".into()],
        sync,
        vec![
            String::new(),
            "Never send, delete, archive or modify emails, issues or anything else on the user's behalf unless they ask in this chat. Drafts are fine when asked.".into(),
            "Every user message starts with a [now: ...] tag added by the app, not typed by the user. Never mention the tag.".into(),
        ],
    ]
    .concat()
    .join("\n")
}

fn now_tag() -> String {
    let now = chrono::Local::now();
    let off = now.offset().local_minus_utc() / 60;
    let sign = if off >= 0 { '+' } else { '-' };
    format!("[now: {}, UTC{sign}{:02}:{:02}]", now.format("%A %-d %B %Y at %H:%M"), off.abs() / 60, off.abs() % 60)
}

struct Inner {
    config: Config,
    stdin_tx: Option<mpsc::UnboundedSender<String>>,
    kill_tx: Option<oneshot::Sender<()>>,
    generation: u64,
    session_id: Option<String>,
    busy: bool,
}

/// Arguments for a long-lived `claude -p` session with these settings.
fn claude_args(cfg: &Config, mcp_file: &Path, session_id: Option<&str>) -> Vec<String> {
    let on = &cfg.integrations;
    // claude.ai connectors only work once connected on claude.ai. The system prompt
    // forbids sending/deleting anything unless the user asks in the chat.
    let connectors = [(on.gmail, "mcp__claude_ai_Gmail"), (on.calendar, "mcp__claude_ai_Google_Calendar")];
    let mut allowed: Vec<String> = vec!["mcp__sidekick".into()];
    if on.web {
        allowed.extend(["WebSearch".into(), "WebFetch".into()]);
    }
    allowed.extend(connectors.iter().filter(|c| c.0).map(|c| c.1.to_string()));
    allowed.extend(cfg.extra_allowed_tools.iter().cloned());
    let blocked: Vec<&str> = connectors.iter().filter(|c| !c.0).map(|c| c.1).collect();
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--append-system-prompt",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(system_prompt(cfg));
    args.extend(["--mcp-config".into(), mcp_file.to_string_lossy().to_string()]);
    // never shell or file editing from the mascot
    args.extend(["--tools".into(), if on.web { "WebSearch,WebFetch".into() } else { String::new() }]);
    args.extend(["--allowedTools".into(), allowed.join(",")]);
    args.extend(["--effort".into(), cfg.effort.clone()]);
    if !blocked.is_empty() {
        args.extend(["--disallowedTools".into(), blocked.join(",")]);
    }
    if let Some(m) = &cfg.model {
        args.extend(["--model".into(), m.clone()]);
    }
    if let Some(id) = session_id {
        args.extend(["--resume".into(), id.to_string()]);
    }
    args
}

pub struct ClaudeSession {
    pub claude_path: Option<PathBuf>,
    pub work_dir: PathBuf,
    data_dir: PathBuf,
    mcp_file: PathBuf,
    /// The executable that serves Sidekick's MCP tools (`--mcp`). None = this one.
    mcp_exe: Option<PathBuf>,
    inner: Mutex<Inner>,
    events: mpsc::UnboundedSender<ClaudeEvent>,
}

impl ClaudeSession {
    pub fn new(data_dir: &Path, config: Config, events: mpsc::UnboundedSender<ClaudeEvent>) -> Arc<Self> {
        Self::with_paths(data_dir, config, events, proc::find_claude(), None)
    }

    /// Like `new`, with an explicit `claude` executable and MCP server executable (tests).
    pub fn with_paths(
        data_dir: &Path,
        config: Config,
        events: mpsc::UnboundedSender<ClaudeEvent>,
        claude_path: Option<PathBuf>,
        mcp_exe: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(ClaudeSession {
            claude_path,
            work_dir: data_dir.join("workspace"), // empty folder: no project files or CLAUDE.md
            data_dir: data_dir.to_path_buf(),
            mcp_file: data_dir.join("mcp.json"),
            mcp_exe,
            inner: Mutex::new(Inner {
                config,
                stdin_tx: None,
                kill_tx: None,
                generation: 0,
                session_id: None,
                busy: false,
            }),
            events,
        })
    }

    pub fn ready(&self) -> bool {
        self.claude_path.is_some()
    }
    pub fn busy(&self) -> bool {
        self.inner.lock().unwrap().busy
    }
    pub fn set_config(&self, config: Config) {
        self.inner.lock().unwrap().config = config;
    }

    fn emit(&self, e: ClaudeEvent) {
        let _ = self.events.send(e);
    }

    fn write_mcp_config(&self, cfg: &Config) -> std::io::Result<()> {
        let on = &cfg.integrations;
        let disabled: Vec<&str> =
            [(on.github, "github"), (on.youtube, "youtube")].iter().filter(|x| !x.0).map(|x| x.1).collect();
        let exe = match &self.mcp_exe {
            Some(p) => p.clone(),
            None => std::env::current_exe()?,
        };
        let mut servers = serde_json::Map::new();
        // Sidekick's own tools: this same executable in MCP mode.
        servers.insert(
            "sidekick".into(),
            json!({
                "command": exe.to_string_lossy(),
                "args": ["--mcp"],
                "env": { "SIDEKICK_DATA": self.data_dir.to_string_lossy(), "SIDEKICK_DISABLED": disabled.join(",") }
            }),
        );
        for (name, s) in &cfg.mcp_servers {
            let v = match s {
                McpServer::Http { url, headers } => json!({ "type": "http", "url": url, "headers": headers }),
                McpServer::Stdio { command, args, env } => {
                    json!({ "type": "stdio", "command": command, "args": args, "env": env })
                }
            };
            servers.insert(name.clone(), v);
        }
        std::fs::create_dir_all(&self.work_dir)?;
        std::fs::write(&self.mcp_file, serde_json::to_vec_pretty(&json!({ "mcpServers": servers }))?)
    }

    /// Start the Claude Code process if it isn't running.
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.stdin_tx.is_some() {
            return Ok(());
        }
        let path = self.claude_path.clone().ok_or("Claude Code isn't installed (couldn't find `claude`).")?;
        let cfg = inner.config.clone();
        self.write_mcp_config(&cfg).map_err(|e| format!("Couldn't write the MCP config: {e}"))?;
        let args = claude_args(&cfg, &self.mcp_file, inner.session_id.as_deref());

        self.emit(ClaudeEvent::Status { state: "starting", model: None, connectors: None });
        let mut cmd = proc::command(&path);
        cmd.args(&args).current_dir(&self.work_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                inner.busy = false;
                drop(inner);
                self.emit(ClaudeEvent::Error(format!("Couldn't start Claude Code: {e}")));
                return Ok(());
            }
        };
        inner.generation += 1;
        let gen = inner.generation;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        inner.stdin_tx = Some(stdin_tx);
        inner.kill_tx = Some(kill_tx);
        drop(inner);
        // Claude Code only reports its model once a message arrives; show "ready" now.
        self.emit(ClaudeEvent::Status { state: "ready", model: None, connectors: None });

        // stdin writer: closing the channel closes Claude Code's stdin.
        tauri::async_runtime::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        // stdout reader
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    me.handle(gen, &v);
                }
            }
        });
        // stderr tail (kept for error messages)
        let tail = Arc::new(Mutex::new(String::new()));
        let tail_w = Arc::clone(&tail);
        tauri::async_runtime::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut t = tail_w.lock().unwrap();
                t.push_str(&String::from_utf8_lossy(&buf[..n]));
                let len = t.chars().count();
                if len > 2000 {
                    *t = t.chars().skip(len - 2000).collect();
                }
            }
        });
        // exit watcher
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill_rx => {
                    // asked to stop: give it a moment to exit on its own (stdin closed), then kill
                    tokio::select! {
                        s = child.wait() => s.ok(),
                        _ = tokio::time::sleep(std::time::Duration::from_millis(1500)) => { let _ = child.kill().await; None }
                    }
                }
            };
            me.on_exit(gen, status.and_then(|s| s.code()), &tail.lock().unwrap().clone());
        });
        Ok(())
    }

    fn on_exit(&self, gen: u64, code: Option<i32>, stderr: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != gen {
            return; // an old process we already replaced or stopped on purpose
        }
        inner.stdin_tx = None;
        inner.kill_tx = None;
        let was_busy = inner.busy;
        inner.busy = false;
        let lower = stderr.to_lowercase();
        let lost_session = lower.contains("resume") || lower.contains("session");
        if was_busy && lost_session {
            inner.session_id = None;
        }
        drop(inner);
        self.emit(ClaudeEvent::Status { state: "stopped", model: None, connectors: None });
        if was_busy {
            let hint = if lost_session { " (old session couldn't be resumed, starting fresh)" } else { "" };
            let last = stderr.trim().lines().last().unwrap_or("");
            let code = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            self.emit(ClaudeEvent::Error(
                format!("Claude Code stopped (exit {code}){hint}. {last}").trim().to_string(),
            ));
        }
    }

    fn handle(&self, gen: u64, m: &Value) {
        if self.inner.lock().unwrap().generation != gen {
            return;
        }
        let ty = m["type"].as_str().unwrap_or("");
        if ty == "system" && m["subtype"] == "init" {
            self.inner.lock().unwrap().session_id = m["session_id"].as_str().map(String::from);
            let connectors = m["mcp_servers"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|s| Connector {
                            name: s["name"].as_str().unwrap_or("").into(),
                            status: s["status"].as_str().unwrap_or("").into(),
                            source: None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            self.emit(ClaudeEvent::Status {
                state: "ready",
                model: m["model"].as_str().map(String::from),
                connectors: Some(connectors),
            });
            return;
        }
        if ty == "stream_event" && m["parent_tool_use_id"].is_null() {
            let e = &m["event"];
            if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                if let Some(t) = e["delta"]["text"].as_str() {
                    self.emit(ClaudeEvent::Delta(t.to_string()));
                }
            }
            if e["type"] == "content_block_start"
                && e["content_block"]["type"].as_str().is_some_and(|t| t.ends_with("tool_use"))
            {
                if let Some(n) = e["content_block"]["name"].as_str() {
                    self.emit(ClaudeEvent::Tool(n.to_string()));
                }
            }
            return;
        }
        if ty == "result" {
            self.inner.lock().unwrap().busy = false;
            let mut denied: Vec<String> = m["permission_denials"]
                .as_array()
                .map(|a| a.iter().filter_map(|d| d["tool_name"].as_str().map(String::from)).collect())
                .unwrap_or_default();
            denied.dedup();
            if !denied.is_empty() {
                self.emit(ClaudeEvent::Note(format!(
                    "Not allowed to use: {}. You can allow it in Settings → Connections → Auto-approved tools.",
                    denied.join(", ")
                )));
            }
            if m["is_error"].as_bool().unwrap_or(false) {
                let msg = m["result"]
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| format!("Claude Code error ({})", m["subtype"].as_str().unwrap_or("")));
                self.emit(ClaudeEvent::Error(msg));
            } else {
                self.emit(ClaudeEvent::Done);
            }
        }
    }

    /// Send a user message (starts Claude Code if needed).
    pub fn send(self: &Arc<Self>, text: &str) {
        if self.busy() {
            self.emit(ClaudeEvent::Error("Still working on the last message…".into()));
            return;
        }
        if let Err(e) = self.start() {
            self.emit(ClaudeEvent::Error(e));
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        let Some(tx) = inner.stdin_tx.clone() else { return }; // failed to start; error already sent
        inner.busy = true;
        drop(inner);
        let msg =
            json!({ "type": "user", "message": { "role": "user", "content": format!("{}\n{}", now_tag(), text) } });
        let _ = tx.send(format!("{msg}\n"));
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation += 1; // ignore whatever the old process still says
        inner.busy = false;
        inner.stdin_tx = None; // closes stdin
        if let Some(k) = inner.kill_tx.take() {
            let _ = k.send(());
        }
    }

    pub fn reset(&self) {
        self.stop();
        self.inner.lock().unwrap().session_id = None;
    }

    /// Apply new settings: restart Claude Code, keeping the conversation (`--resume`).
    pub fn restart(self: &Arc<Self>, config: Option<Config>) {
        let was_busy = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(c) = config {
                inner.config = c;
            }
            inner.busy
        };
        self.stop();
        if was_busy {
            self.emit(ClaudeEvent::Error(
                "Restarted Claude Code with your new settings. Please send that again.".into(),
            ));
        }
        if self.ready() {
            let _ = self.start();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Integrations;

    const MCP_EXE: &str = r"C:\Sidekick\sidekick.exe";

    fn session(dir: &Path, cfg: Config) -> (Arc<ClaudeSession>, mpsc::UnboundedReceiver<ClaudeEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (ClaudeSession::with_paths(dir, cfg, tx, None, Some(PathBuf::from(MCP_EXE))), rx)
    }
    fn drain(rx: &mut mpsc::UnboundedReceiver<ClaudeEvent>) -> Vec<ClaudeEvent> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }
    fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    #[test]
    fn prompt_lists_only_what_is_switched_on() {
        let mut cfg = Config::default();
        let p = system_prompt(&cfg);
        for want in
            ["create_reminder", "add_task", "github_inbox", "youtube_latest", "Gmail / Google Calendar", "Web search"]
        {
            assert!(p.contains(want), "default prompt should mention {want}");
        }
        assert!(p.contains("Reply in the language the user writes in."));
        assert!(p.contains("Never send, delete, archive or modify emails"));

        cfg.integrations = Integrations { github: false, youtube: false, gmail: false, calendar: true, web: false };
        cfg.language = "Vietnamese".into();
        cfg.response_style = "brief".into();
        cfg.mcp_servers
            .insert("fs".into(), McpServer::Stdio { command: "npx".into(), args: vec![], env: Default::default() });
        let p = system_prompt(&cfg);
        for gone in ["github_inbox", "youtube_latest", "Web search", "Gmail"] {
            assert!(!p.contains(gone), "{gone} is switched off");
        }
        assert!(p.contains("- Google Calendar: claude.ai connectors"));
        assert!(p.contains("Always reply in Vietnamese."));
        assert!(p.contains("one to three short lines"));
        assert!(p.contains("The user's own MCP servers: fs."));
        assert!(p.contains("create_reminder") && p.contains("add_task"), "reminders and tasks are always available");
    }

    #[test]
    fn now_tag_has_date_time_and_utc_offset() {
        let re = regex::Regex::new(
            r"^\[now: [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2}, UTC[+-]\d{2}:\d{2}\]$",
        )
        .unwrap();
        let tag = now_tag();
        assert!(re.is_match(&tag), "{tag}");
    }

    #[test]
    fn args_follow_the_settings() {
        let mcp = Path::new(r"C:\data\mcp.json");
        let a = claude_args(&Config::default(), mcp, None);
        assert_eq!(&a[..2], ["-p", "--input-format"]);
        assert_eq!(value_of(&a, "--output-format"), Some("stream-json"));
        assert_eq!(value_of(&a, "--mcp-config"), Some(r"C:\data\mcp.json"));
        assert_eq!(value_of(&a, "--tools"), Some("WebSearch,WebFetch"), "only web tools: no shell, no file edits");
        assert_eq!(
            value_of(&a, "--allowedTools"),
            Some("mcp__sidekick,WebSearch,WebFetch,mcp__claude_ai_Gmail,mcp__claude_ai_Google_Calendar")
        );
        assert_eq!(value_of(&a, "--effort"), Some("low"));
        assert!(value_of(&a, "--append-system-prompt").unwrap().starts_with("You are Sidekick"));
        for absent in ["--disallowedTools", "--model", "--resume"] {
            assert!(!a.iter().any(|x| x == absent), "{absent} should not be passed");
        }

        let mut cfg = Config::default();
        cfg.integrations.web = false;
        cfg.integrations.gmail = false;
        cfg.model = Some("claude-haiku-5-5".into());
        cfg.effort = "high".into();
        cfg.extra_allowed_tools = vec!["mcp__fs__read".into()];
        let a = claude_args(&cfg, mcp, Some("abc-123"));
        assert_eq!(value_of(&a, "--tools"), Some(""), "no built-in tools at all with web off");
        assert_eq!(value_of(&a, "--allowedTools"), Some("mcp__sidekick,mcp__claude_ai_Google_Calendar,mcp__fs__read"));
        assert_eq!(value_of(&a, "--disallowedTools"), Some("mcp__claude_ai_Gmail"));
        assert_eq!(value_of(&a, "--model"), Some("claude-haiku-5-5"));
        assert_eq!(value_of(&a, "--effort"), Some("high"));
        assert_eq!(value_of(&a, "--resume"), Some("abc-123"));
    }

    #[test]
    fn mcp_config_points_at_sidekick_and_the_users_servers() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::default();
        cfg.integrations.github = false;
        cfg.mcp_servers.insert(
            "notes".into(),
            McpServer::Http { url: "https://example.com/mcp".into(), headers: [("X-Key".into(), "1".into())].into() },
        );
        cfg.mcp_servers.insert(
            "fs".into(),
            McpServer::Stdio { command: "npx".into(), args: vec!["-y".into(), "fs".into()], env: Default::default() },
        );
        let (s, _rx) = session(dir.path(), cfg.clone());
        s.write_mcp_config(&cfg).unwrap();
        let v: Value = serde_json::from_slice(&std::fs::read(dir.path().join("mcp.json")).unwrap()).unwrap();
        let sk = &v["mcpServers"]["sidekick"];
        assert_eq!(sk["command"], MCP_EXE);
        assert_eq!(sk["args"], json!(["--mcp"]));
        assert_eq!(sk["env"]["SIDEKICK_DATA"], dir.path().to_string_lossy().as_ref());
        assert_eq!(sk["env"]["SIDEKICK_DISABLED"], "github");
        assert_eq!(
            v["mcpServers"]["notes"],
            json!({ "type": "http", "url": "https://example.com/mcp", "headers": { "X-Key": "1" } })
        );
        assert_eq!(v["mcpServers"]["fs"]["type"], "stdio");
        assert_eq!(v["mcpServers"]["fs"]["args"], json!(["-y", "fs"]));
        assert!(dir.path().join("workspace").is_dir(), "Claude Code runs in an empty workspace folder");
    }

    #[test]
    fn stream_messages_become_events() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = session(dir.path(), Config::default());
        s.handle(
            0,
            &json!({ "type": "system", "subtype": "init", "session_id": "s-1", "model": "claude-opus-5-5",
                "mcp_servers": [{ "name": "sidekick", "status": "connected" }, { "name": "claude.ai Gmail", "status": "needs-auth" }] }),
        );
        s.handle(
            0,
            &json!({ "type": "stream_event", "parent_tool_use_id": null,
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Hel" } } }),
        );
        s.handle(
            0,
            &json!({ "type": "stream_event", "parent_tool_use_id": null,
                "event": { "type": "content_block_start", "content_block": { "type": "tool_use", "name": "mcp__sidekick__add_task" } } }),
        );
        // A subagent's stream (parent_tool_use_id set) is not shown in the chat.
        s.handle(
            0,
            &json!({ "type": "stream_event", "parent_tool_use_id": "toolu_1",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "hidden" } } }),
        );
        // The full assistant message repeats the streamed text; it isn't shown twice.
        s.handle(0, &json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Hello" }] } }));
        s.inner.lock().unwrap().busy = true;
        s.handle(
            0,
            &json!({ "type": "result", "subtype": "success", "is_error": false,
                "permission_denials": [{ "tool_name": "WebFetch" }, { "tool_name": "WebFetch" }] }),
        );

        let ev = drain(&mut rx);
        assert!(matches!(&ev[0], ClaudeEvent::Status { state: "ready", model: Some(m), connectors: Some(c) }
            if m == "claude-opus-5-5" && c.len() == 2 && c[1].status == "needs-auth"));
        assert!(matches!(&ev[1], ClaudeEvent::Delta(t) if t == "Hel"));
        assert!(matches!(&ev[2], ClaudeEvent::Tool(n) if n == "mcp__sidekick__add_task"));
        assert!(matches!(&ev[3], ClaudeEvent::Note(n) if n.contains("Not allowed to use: WebFetch.")));
        assert!(matches!(&ev[4], ClaudeEvent::Done));
        assert_eq!(ev.len(), 5);
        assert_eq!(s.inner.lock().unwrap().session_id.as_deref(), Some("s-1"), "kept for --resume");
        assert!(!s.busy(), "a result ends the turn");
    }

    #[test]
    fn error_results_and_stale_processes() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = session(dir.path(), Config::default());
        s.handle(
            0,
            &json!({ "type": "result", "subtype": "error_max_turns", "is_error": true, "result": "Too many steps" }),
        );
        s.handle(0, &json!({ "type": "result", "subtype": "error_during_execution", "is_error": true }));
        // Output from a process that was already replaced (older generation) is ignored.
        s.handle(7, &json!({ "type": "result", "subtype": "success", "is_error": false }));
        let ev = drain(&mut rx);
        assert!(matches!(&ev[0], ClaudeEvent::Error(m) if m == "Too many steps"));
        assert!(matches!(&ev[1], ClaudeEvent::Error(m) if m == "Claude Code error (error_during_execution)"));
        assert_eq!(ev.len(), 2);
    }

    #[test]
    fn sending_without_claude_code_explains_why() {
        let dir = tempfile::tempdir().unwrap();
        let (s, mut rx) = session(dir.path(), Config::default());
        assert!(!s.ready());
        s.send("hello");
        let ev = drain(&mut rx);
        assert!(matches!(&ev[..], [ClaudeEvent::Error(m)] if m.contains("isn't installed")), "{ev:?}");
        assert!(!s.busy());
    }
}
