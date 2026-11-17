//! Integration tests for Sidekick's MCP server: the real `sidekick --mcp` executable,
//! spoken to over stdio exactly as Claude Code does.

mod common;

use common::Mcp;
use serde_json::{json, Value};

const CORE_TOOLS: [&str; 7] =
    ["create_reminder", "list_reminders", "delete_reminder", "add_task", "list_tasks", "complete_task", "delete_task"];

fn tool_names(m: &mut Mcp) -> Vec<String> {
    let r = m.request("tools/list", json!({}));
    r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
}

#[test]
fn initialize_negotiates_the_protocol_version() {
    let mut m = Mcp::start("github,youtube");
    let r = m.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }));
    assert_eq!(r["result"]["protocolVersion"], "2025-06-18", "a version the server knows is kept");
    assert_eq!(r["result"]["serverInfo"]["name"], "sidekick");
    assert_eq!(r["result"]["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(r["result"]["capabilities"]["tools"].is_object());

    let r = m.request("initialize", json!({ "protocolVersion": "1999-01-01" }));
    assert_eq!(r["result"]["protocolVersion"], "2025-11-25", "unknown versions get the newest one");
    assert_eq!(m.request("ping", json!({}))["result"], json!({}));
}

#[test]
fn tools_follow_the_switched_off_integrations() {
    let mut m = Mcp::start("github,youtube");
    m.initialize();
    assert_eq!(tool_names(&mut m), CORE_TOOLS);

    let mut all = Mcp::start("");
    all.initialize();
    let names = tool_names(&mut all);
    for extra in ["github_inbox", "youtube_latest", "youtube_follow"] {
        assert!(names.iter().any(|n| n == extra), "{extra} is on");
    }
    let r = all.request("tools/list", json!({}));
    for t in r["result"]["tools"].as_array().unwrap() {
        assert!(t["description"].as_str().is_some_and(|d| d.len() > 10), "{} has a description", t["name"]);
        assert_eq!(t["inputSchema"]["type"], "object", "{} has an object schema", t["name"]);
    }
    // A switched-off tool can't be called either.
    assert!(m.err("github_inbox", json!({})).contains("Unknown tool github_inbox"));
}

#[test]
fn reminders_round_trip() {
    let mut m = Mcp::start("github,youtube");
    m.initialize();
    let created = m.ok(
        "create_reminder",
        json!({ "text": "Stand up and stretch", "due_at": "2999-01-01T09:00:00+07:00", "repeat": "daily" }),
    );
    let r = &created["reminder"];
    let id = r["id"].as_str().unwrap().to_string();
    assert_eq!(r["text"], "Stand up and stretch");
    assert_eq!(r["dueAt"], "2999-01-01T02:00:00.000Z", "stored in UTC");
    assert_eq!(r["repeat"], "daily");
    assert!(m.dir.path().join("reminders.json").exists());

    let list = m.ok("list_reminders", json!({}));
    assert_eq!(list["reminders"].as_array().unwrap().len(), 1);
    assert!(m.err("create_reminder", json!({ "text": "x", "due_at": "tomorrow morning" })).contains("valid datetime"));
    assert!(m.err("create_reminder", json!({ "text": "  ", "due_at": "2999-01-01T09:00:00Z" })).contains("required"));
    assert!(m.err("delete_reminder", json!({})).contains("id is required"));

    assert_eq!(m.ok("delete_reminder", json!({ "id": id }))["deleted"], true);
    assert_eq!(m.ok("delete_reminder", json!({ "id": id }))["deleted"], false);
    assert_eq!(m.ok("list_reminders", json!({}))["reminders"], json!([]));
}

#[test]
fn tasks_round_trip() {
    let mut m = Mcp::start("github,youtube");
    m.initialize();
    let pr = json!({ "title": "Review PR #12", "source": "github", "link": "https://github.com/me/app/pull/12", "notes": "small" });
    let a = m.ok("add_task", pr.clone());
    assert_eq!(a["duplicate"], false);
    let id = a["task"]["id"].as_str().unwrap().to_string();
    assert_eq!(a["task"]["source"], "github");

    let again = m.ok("add_task", pr);
    assert_eq!(again["duplicate"], true, "same link, same task: daily syncs don't pile up");
    assert_eq!(again["task"]["id"], id.as_str());

    m.ok("add_task", json!({ "title": "Email professor", "source": "gmail" }));
    assert!(m.err("add_task", json!({ "title": "" })).contains("title is required"));
    assert_eq!(m.ok("list_tasks", json!({}))["tasks"].as_array().unwrap().len(), 2);

    let done = m.ok("complete_task", json!({ "id": id }));
    assert_eq!(done["task"]["done"], true);
    assert_eq!(m.ok("list_tasks", json!({}))["tasks"].as_array().unwrap().len(), 1, "done tasks are hidden");
    assert_eq!(m.ok("list_tasks", json!({ "include_done": true }))["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(m.ok("complete_task", json!({ "id": id, "done": false }))["task"]["done"], false);
    assert!(m.err("complete_task", json!({ "id": "nope" })).contains("no such task"));

    assert_eq!(m.ok("delete_task", json!({ "id": id }))["deleted"], true);
    assert_eq!(m.ok("list_tasks", json!({ "include_done": true }))["tasks"].as_array().unwrap().len(), 1);
}

#[test]
fn protocol_errors_are_answered_properly() {
    let mut m = Mcp::start("github,youtube");
    m.initialize();
    let r = m.request("resources/list", json!({}));
    assert_eq!(r["error"]["code"], -32601);

    // Notifications get no reply: the next message is the ping's answer.
    m.send_raw(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}"#);
    assert!(m.silent_for(300));
    assert_eq!(m.request("ping", json!({}))["result"], json!({}));

    m.send_raw("{ this is not json");
    let e = m.read();
    assert_eq!(e["error"]["code"], -32700);
    assert!(e["id"].is_null());

    m.send_raw(""); // blank lines are ignored
    assert!(m.err("no_such_tool", json!({})).contains("Unknown tool no_such_tool"));
}

#[test]
fn the_app_and_the_server_share_the_same_files() {
    let dir = tempfile::tempdir().unwrap();
    // A task board written by Sidekick 0.x / the app…
    std::fs::write(
        dir.path().join("tasks.json"),
        r#"[{"id":"a1","title":"From 0.x","notes":"","source":"gmail","link":"","due":null,"done":false,"createdAt":"2026-11-15T17:24:58.872Z","doneAt":null}]"#,
    )
    .unwrap();
    let path = dir.path().to_path_buf();
    let mut m = Mcp::start_in(dir, "github,youtube");
    m.initialize();
    // …is what Claude sees…
    let tasks = m.ok("list_tasks", json!({}));
    assert_eq!(tasks["tasks"][0]["title"], "From 0.x");
    // …and what Claude adds is what the app's task board loads.
    m.ok("add_task", json!({ "title": "Added by Claude" }));
    let titles: Vec<String> = sidekick_lib::store::load_tasks(&path).into_iter().map(|t| t.title).collect();
    assert_eq!(titles.len(), 2);
    assert!(titles.contains(&"Added by Claude".to_string()));
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(path.join("tasks.json")).unwrap()).unwrap();
    assert!(raw[0].get("createdAt").is_some(), "files keep the camelCase 0.x shape");
}
