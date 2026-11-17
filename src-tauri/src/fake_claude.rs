//! A stand-in for the Claude Code CLI, for tests only (Cargo feature `test-support`;
//! release builds never include it). When `SIDEKICK_FAKE_CLAUDE` is set, the Sidekick
//! executable started with Claude Code's arguments behaves like `claude`:
//!
//! - `--version`, `auth status|login|logout` and `mcp list|login` print canned answers.
//! - `-p --input-format stream-json …` speaks Claude Code's stream-json protocol and calls
//!   Sidekick's real MCP server (from `--mcp-config`) for tool requests, so integration and
//!   end-to-end tests run the whole chain without a Claude login or network.
//!
//! Scripted replies, matched on the message after the app's `[now: …]` line:
//!
//! | Message                     | Reply                                        |
//! |-----------------------------|----------------------------------------------|
//! | `add task: <title>`         | calls `add_task`, then confirms              |
//! | `remind me in <N>s: <text>` | calls `create_reminder`, due in N seconds    |
//! | `session?`                  | says which session it is and if it resumed   |
//! | `deny please`               | a result that lists a denied tool            |
//! | `fail please`               | an error result                              |
//! | `crash please`              | exits with code 3 in the middle of the turn  |
//! | `slow <ms>: <text>`         | waits, then echoes                           |
//! | anything else               | streams back `**Echo:** <text>`              |

use crate::proc;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::Duration;

pub const VERSION: &str = "9.9.9 (Claude Code)";

const MCP_LIST: &str = "Checking MCP server health…\n\n\
claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✓ Connected\n\
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication\n";

/// Whether this process should act as the fake `claude` (set by the tests).
pub fn is_requested() -> bool {
    std::env::var_os("SIDEKICK_FAKE_CLAUDE").is_some_and(|v| !v.is_empty())
}

/// Run as `claude <args>`; returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["--version", ..] | ["-v", ..] => {
            println!("{VERSION}");
            0
        }
        ["auth", "status", ..] => {
            let status = json!({
                "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
                "subscriptionType": "max", "email": "e2e@example.com", "orgName": null
            });
            println!("{status}");
            0
        }
        ["auth", ..] | ["mcp", "login", ..] => {
            println!("ok");
            0
        }
        ["mcp", "list", ..] => {
            print!("{MCP_LIST}");
            0
        }
        _ if a.contains(&"-p") => stream(&a),
        _ => {
            eprintln!("fake claude: unsupported arguments {a:?}");
            2
        }
    }
}

fn flag<'a>(a: &[&'a str], name: &str) -> Option<&'a str> {
    a.iter().position(|x| *x == name).and_then(|i| a.get(i + 1)).copied()
}

/// The text of a stream-json user message, without the app's `[now: …]` line.
fn user_text(content: &Value) -> String {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    match text.split_once('\n') {
        Some((first, rest)) if first.starts_with("[now:") => rest.to_string(),
        _ => text,
    }
}

fn stream(a: &[&str]) -> i32 {
    let resumed = flag(a, "--resume").is_some();
    let session = flag(a, "--resume").map(String::from).unwrap_or_else(|| format!("fake-{}", std::process::id()));
    let model = flag(a, "--model").unwrap_or("claude-fake-1").to_string();
    let out = Out { session };
    let mut mcp = McpClient { config: flag(a, "--mcp-config").map(String::from), conn: None };
    let mut started = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if msg["type"] != "user" {
            continue;
        }
        if !started {
            started = true;
            out.send(json!({
                "type": "system", "subtype": "init", "session_id": out.session, "model": model, "tools": [],
                "mcp_servers": [{ "name": "sidekick", "status": "connected" }]
            }));
        }
        let text = user_text(&msg["message"]["content"]);
        if let Some(code) = respond(&out, &mut mcp, text.trim(), resumed) {
            return code;
        }
    }
    0
}

fn respond(out: &Out, mcp: &mut McpClient, t: &str, resumed: bool) -> Option<i32> {
    if let Some(title) = t.strip_prefix("add task: ") {
        out.tool("mcp__sidekick__add_task");
        // Like a sync, not like the user's own note: the app announces it in the notifier.
        match mcp.call("add_task", json!({ "title": title, "source": "other" })) {
            Ok(_) => out.reply(&format!("Pinned **{title}** to your board.")),
            Err(e) => out.result(&format!("add_task failed: {e}"), true, &[]),
        }
    } else if let Some(rest) = t.strip_prefix("remind me in ") {
        let (secs, what) =
            rest.split_once("s: ").and_then(|(n, w)| Some((n.trim().parse::<i64>().ok()?, w))).unwrap_or((60, rest));
        let due = (chrono::Local::now() + chrono::TimeDelta::seconds(secs)).to_rfc3339();
        out.tool("mcp__sidekick__create_reminder");
        match mcp.call("create_reminder", json!({ "text": what, "due_at": due })) {
            Ok(_) => out.reply(&format!("Okay, I'll remind you to {what} in {secs} seconds.")),
            Err(e) => out.result(&format!("create_reminder failed: {e}"), true, &[]),
        }
    } else if t == "session?" {
        out.reply(&format!("Session {}, resumed: {resumed}", out.session));
    } else if t == "deny please" {
        out.text("I wasn't allowed to search the web.");
        out.result("I wasn't allowed to search the web.", false, &["WebSearch"]);
    } else if t == "fail please" {
        out.result("The fake model had a problem.", true, &[]);
    } else if t == "crash please" {
        out.text("Going down…");
        eprintln!("fake claude: crashing on purpose");
        return Some(3);
    } else if let Some(rest) = t.strip_prefix("slow ") {
        let (ms, what) = rest.split_once(": ").unwrap_or(("1000", rest));
        std::thread::sleep(Duration::from_millis(ms.trim().parse().unwrap_or(1000)));
        out.reply(&format!("**Echo:** {what}"));
    } else {
        out.reply(&format!("**Echo:** {t}"));
    }
    None
}

/// Writes stream-json events to stdout.
struct Out {
    session: String,
}

impl Out {
    fn send(&self, v: Value) {
        let mut o = std::io::stdout().lock();
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    }
    fn event(&self, event: Value) {
        self.send(
            json!({ "type": "stream_event", "session_id": self.session, "parent_tool_use_id": null, "event": event }),
        );
    }
    fn text(&self, chunk: &str) {
        self.event(
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": chunk } }),
        );
    }
    fn tool(&self, name: &str) {
        self.event(json!({
            "type": "content_block_start", "index": 0,
            "content_block": { "type": "tool_use", "id": "toolu_fake", "name": name, "input": {} }
        }));
    }
    /// Streams a reply in a few chunks, then the full message and the result, like the real CLI.
    fn reply(&self, text: &str) {
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(chars.len().div_ceil(3).max(1)) {
            self.text(&chunk.iter().collect::<String>());
            std::thread::sleep(Duration::from_millis(15));
        }
        self.send(json!({
            "type": "assistant", "session_id": self.session, "parent_tool_use_id": null,
            "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }
        }));
        self.result(text, false, &[]);
    }
    fn result(&self, text: &str, is_error: bool, denied: &[&str]) {
        self.send(json!({
            "type": "result", "subtype": if is_error { "error_during_execution" } else { "success" },
            "is_error": is_error, "result": text, "session_id": self.session, "num_turns": 1,
            "usage": { "input_tokens": 42, "output_tokens": text.len() / 4 + 1 },
            "permission_denials": denied.iter().map(|t| json!({ "tool_name": t })).collect::<Vec<_>>()
        }));
    }
}

/// A minimal MCP client for Sidekick's own server, started from the `--mcp-config` file.
struct McpClient {
    config: Option<String>,
    conn: Option<McpConn>,
}

struct McpConn {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Drop for McpConn {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl McpConn {
    fn write(&mut self, msg: Value) -> Result<(), String> {
        writeln!(self.stdin, "{msg}").and_then(|_| self.stdin.flush()).map_err(|e| e.to_string())
    }
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let mut line = String::new();
        loop {
            line.clear();
            if self.stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("the MCP server closed".into());
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["id"] == id {
                return match v.get("error") {
                    Some(e) => Err(e["message"].as_str().unwrap_or("MCP error").to_string()),
                    None => Ok(v["result"].clone()),
                };
            }
        }
    }
}

impl McpClient {
    fn connect(&mut self) -> Result<&mut McpConn, String> {
        if self.conn.is_none() {
            let path = self.config.as_deref().ok_or("no --mcp-config")?;
            let cfg: Value = serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let s = &cfg["mcpServers"]["sidekick"];
            let command = s["command"].as_str().ok_or("no sidekick server in the MCP config")?;
            let mut cmd = proc::std_command(command);
            if let Some(args) = s["args"].as_array() {
                cmd.args(args.iter().filter_map(Value::as_str));
            }
            if let Some(env) = s["env"].as_object() {
                cmd.envs(env.iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v))));
            }
            let mut child = cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("couldn't start the MCP server: {e}"))?;
            let stdin = child.stdin.take().ok_or("no stdin")?;
            let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
            let mut conn = McpConn { child, stdin, stdout, next_id: 0 };
            conn.request(
                "initialize",
                json!({ "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "fake-claude", "version": VERSION } }),
            )?;
            conn.write(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
            self.conn = Some(conn);
        }
        Ok(self.conn.as_mut().expect("connected"))
    }

    /// Calls a tool; returns its JSON result, or the tool's error message.
    fn call(&mut self, tool: &str, args: Value) -> Result<Value, String> {
        let result = self.connect()?.request("tools/call", json!({ "name": tool, "arguments": args }))?;
        let text = result["content"][0]["text"].as_str().unwrap_or("null");
        let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        if result["isError"].as_bool().unwrap_or(false) {
            return Err(v["error"].as_str().unwrap_or(text).to_string());
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_text_drops_the_now_tag() {
        assert_eq!(
            user_text(&json!("[now: Monday 16 November 2026 at 09:00, UTC+07:00]\nhello\nthere")),
            "hello\nthere"
        );
        assert_eq!(user_text(&json!("no tag")), "no tag");
        assert_eq!(user_text(&json!([{ "type": "text", "text": "[now: x]\nhi" }])), "hi");
    }

    #[test]
    fn flags_are_read_by_name() {
        let a = ["-p", "--resume", "abc", "--model", "m"];
        assert_eq!(flag(&a, "--resume"), Some("abc"));
        assert_eq!(flag(&a, "--model"), Some("m"));
        assert_eq!(flag(&a, "--mcp-config"), None);
    }
}
