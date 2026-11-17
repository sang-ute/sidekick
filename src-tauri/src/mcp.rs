//! Sidekick's tools for Claude Code, as an MCP server over stdio (JSON-RPC, one message
//! per line). Claude Code starts this same executable with `--mcp`; `SIDEKICK_DATA`
//! points at the data folder the app uses.

use crate::config;
use crate::files::{data_dir, parse_ms};
use crate::integrations;
use crate::store::{self, NewTask};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::Path;

const PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn tools(disabled: &HashSet<String>) -> Vec<Value> {
    let mut t = vec![
        json!({
            "name": "create_reminder",
            "description": "Schedule a desktop notification. due_at is an ISO 8601 datetime WITH the user's UTC offset, e.g. 2026-11-16T17:30:00+07:00.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "minLength": 1, "description": "Notification text, phrased as the reminder itself" },
                    "due_at": { "type": "string", "description": "ISO 8601 datetime with offset" },
                    "repeat": { "type": "string", "enum": ["none", "daily", "weekly"] }
                },
                "required": ["text", "due_at"]
            }
        }),
        json!({ "name": "list_reminders", "description": "List upcoming reminders with their ids.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({
            "name": "delete_reminder", "description": "Delete a reminder by id.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
        json!({
            "name": "add_task",
            "description": "Pin a to-do on the user's task board. Use for anything they need to act on. Always pass the link when the task comes from an email, PR, issue or video; tasks with the same link are not added twice.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "description": "Short, action-first, e.g. 'Review PR #12 in portfolio'" },
                    "source": { "type": "string", "enum": store::SOURCES, "description": "Where it came from" },
                    "link": { "type": "string", "description": "URL to open the item" },
                    "notes": { "type": "string", "description": "One line of context" },
                    "due": { "type": "string", "description": "ISO 8601 datetime if there is a deadline" }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "list_tasks", "description": "List the task board. Check it before adding tasks to avoid duplicates.",
            "inputSchema": { "type": "object", "properties": { "include_done": { "type": "boolean" } } }
        }),
        json!({
            "name": "complete_task", "description": "Mark a task done (or not done with done=false).",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "done": { "type": "boolean" } }, "required": ["id"] }
        }),
        json!({
            "name": "delete_task", "description": "Remove a task from the board.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
    ];
    if !disabled.contains("github") {
        t.push(json!({
            "name": "github_inbox",
            "description": "The user's GitHub to-dos: PRs waiting for their review, issues assigned to them, their open PRs, unread notifications. Read-only.",
            "inputSchema": { "type": "object", "properties": {} }
        }));
    }
    if !disabled.contains("youtube") {
        t.push(json!({
            "name": "youtube_latest", "description": "New videos from the channels the user follows in Sidekick.",
            "inputSchema": { "type": "object", "properties": { "since_days": { "type": "number", "minimum": 1, "maximum": 30 } } }
        }));
        t.push(json!({
            "name": "youtube_follow", "description": "Follow (or unfollow) a YouTube channel by @handle, channel URL or channel id.",
            "inputSchema": { "type": "object", "properties": { "channel": { "type": "string" }, "unfollow": { "type": "boolean" } }, "required": ["channel"] }
        }));
    }
    t
}

fn ok(v: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": v.to_string() }] })
}
fn fail(msg: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": json!({ "error": msg }).to_string() }], "isError": true })
}
fn s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str)
}

async fn call(dir: &Path, disabled: &HashSet<String>, name: &str, a: &Value) -> Value {
    match name {
        "create_reminder" => {
            let (Some(text), Some(due)) = (s(a, "text").filter(|t| !t.trim().is_empty()), s(a, "due_at")) else {
                return fail("text and due_at are required");
            };
            if parse_ms(due).is_none() {
                return fail("due_at is not a valid datetime");
            }
            match store::add_reminder(dir, text, due, s(a, "repeat")) {
                Some(r) => ok(json!({ "reminder": r })),
                None => fail("due_at is not a valid datetime"),
            }
        }
        "list_reminders" => ok(json!({ "reminders": store::load_reminders(dir) })),
        "delete_reminder" => match s(a, "id") {
            Some(id) => ok(json!({ "deleted": store::remove_reminder(dir, id) })),
            None => fail("id is required"),
        },
        "add_task" => {
            let Some(title) = s(a, "title").filter(|t| !t.trim().is_empty()) else { return fail("title is required") };
            let (task, duplicate) = store::add_task(
                dir,
                NewTask {
                    title: title.into(),
                    notes: s(a, "notes").map(String::from),
                    source: s(a, "source").map(String::from),
                    link: s(a, "link").map(String::from),
                    due: s(a, "due").map(String::from),
                },
            );
            ok(json!({ "task": task, "duplicate": duplicate }))
        }
        "list_tasks" => {
            let all = a.get("include_done").and_then(Value::as_bool).unwrap_or(false);
            let tasks: Vec<_> = store::load_tasks(dir).into_iter().filter(|t| all || !t.done).collect();
            ok(json!({ "tasks": tasks }))
        }
        "complete_task" => {
            let Some(id) = s(a, "id") else { return fail("id is required") };
            let done = a.get("done").and_then(Value::as_bool).unwrap_or(true);
            match store::update_task(dir, id, Some(done), None) {
                Some(t) => ok(json!({ "task": t })),
                None => fail("no such task"),
            }
        }
        "delete_task" => match s(a, "id") {
            Some(id) => ok(json!({ "deleted": store::remove_task(dir, id) })),
            None => fail("id is required"),
        },
        "github_inbox" if !disabled.contains("github") => match integrations::github_inbox().await {
            Ok(v) => ok(v),
            Err(e) => fail(&e),
        },
        "youtube_latest" if !disabled.contains("youtube") => {
            let days = a.get("since_days").and_then(Value::as_f64).unwrap_or(2.0).clamp(1.0, 30.0);
            ok(integrations::youtube_latest(dir, &config::load(dir).youtube_channels, days).await)
        }
        "youtube_follow" if !disabled.contains("youtube") => {
            let Some(channel) = s(a, "channel").map(str::trim).filter(|c| !c.is_empty()) else {
                return fail("channel is required");
            };
            let mut cfg = config::load(dir);
            if a.get("unfollow").and_then(Value::as_bool).unwrap_or(false) {
                cfg.youtube_channels.retain(|c| !c.eq_ignore_ascii_case(channel));
            } else {
                if let Err(e) = integrations::resolve_channel(dir, channel).await {
                    return fail(&e);
                }
                if !cfg.youtube_channels.iter().any(|c| c.eq_ignore_ascii_case(channel)) {
                    cfg.youtube_channels.push(channel.to_string());
                }
            }
            config::save(dir, &cfg);
            ok(json!({ "following": cfg.youtube_channels }))
        }
        _ => fail(&format!("Unknown tool {name}")),
    }
}

/// Handle one JSON-RPC message; returns the response to write, if any.
async fn handle(dir: &Path, disabled: &HashSet<String>, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => {
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "sidekick", "version": env!("CARGO_PKG_VERSION") }
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools(disabled) }),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("");
            let args = msg["params"].get("arguments").cloned().unwrap_or(json!({}));
            call(dir, disabled, name, &args).await
        }
        _ if id.is_none() => return None, // notifications (e.g. notifications/initialized)
        _ => {
            return Some(
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } }),
            );
        }
    };
    id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

pub fn run() {
    let dir = data_dir();
    let disabled: HashSet<String> = std::env::var("SIDEKICK_DISABLED")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(line) {
            Ok(msg) => rt.block_on(handle(&dir, &disabled, &msg)),
            Err(_) => {
                Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }))
            }
        };
        if let Some(r) = reply {
            if writeln!(out, "{r}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
}
