//! Integration tests for the Claude Code bridge: the real `ClaudeSession` talking to the
//! fake Claude Code (feature `test-support`), which in turn calls Sidekick's real MCP
//! server. Covers streaming, tools, resuming, errors and crashes without a Claude login.
#![cfg(feature = "test-support")]

mod common;

use common::SIDEKICK;
use sidekick_lib::claude::{ClaudeEvent, ClaudeSession};
use sidekick_lib::config::Config;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

fn session(dir: &Path, cfg: Config) -> (Arc<ClaudeSession>, UnboundedReceiver<ClaudeEvent>) {
    // Children inherit this: the Sidekick executable then acts as `claude`.
    std::env::set_var("SIDEKICK_FAKE_CLAUDE", "1");
    let (tx, rx) = unbounded_channel();
    let s = ClaudeSession::with_paths(dir, cfg, tx, Some(PathBuf::from(SIDEKICK)), Some(PathBuf::from(SIDEKICK)));
    (s, rx)
}

/// Events until the turn ends (Done or Error). Fails after 20 s.
async fn turn(rx: &mut UnboundedReceiver<ClaudeEvent>) -> Vec<ClaudeEvent> {
    let mut out = vec![];
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(20), rx.recv())
            .await
            .expect("the turn finished in time")
            .expect("the session is alive");
        let end = matches!(ev, ClaudeEvent::Done | ClaudeEvent::Error(_));
        out.push(ev);
        if end {
            return out;
        }
    }
}

fn text(events: &[ClaudeEvent]) -> String {
    events.iter().filter_map(|e| if let ClaudeEvent::Delta(t) = e { Some(t.as_str()) } else { None }).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_streams_in_and_ends_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config { model: Some("claude-test-model".into()), ..Default::default() };
    let (s, mut rx) = session(dir.path(), cfg);
    assert!(s.ready());
    s.send("hello there");
    assert!(s.busy());
    let ev = turn(&mut rx).await;
    assert!(matches!(ev[0], ClaudeEvent::Status { state: "starting", .. }));
    assert!(
        ev.iter().any(|e| matches!(e, ClaudeEvent::Status { state: "ready", model: Some(m), connectors: Some(c) }
            if m == "claude-test-model" && c.iter().any(|c| c.name == "sidekick" && c.status == "connected"))),
        "the init message reports the model and Sidekick's tools: {ev:?}"
    );
    assert_eq!(text(&ev), "**Echo:** hello there");
    assert!(ev.iter().filter(|e| matches!(e, ClaudeEvent::Delta(_))).count() > 1, "streamed in pieces");
    assert!(matches!(ev.last(), Some(ClaudeEvent::Done)));
    assert!(!s.busy());
    s.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_calls_reach_the_real_task_board_and_reminders() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = session(dir.path(), Config::default());

    s.send("add task: Buy oat milk");
    let ev = turn(&mut rx).await;
    assert!(ev.iter().any(|e| matches!(e, ClaudeEvent::Tool(n) if n == "mcp__sidekick__add_task")), "{ev:?}");
    assert!(matches!(ev.last(), Some(ClaudeEvent::Done)), "{ev:?}");
    assert!(text(&ev).contains("Buy oat milk"));
    let tasks = sidekick_lib::store::load_tasks(dir.path());
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "Buy oat milk");

    s.send("remind me in 120s: stretch");
    let ev = turn(&mut rx).await;
    assert!(ev.iter().any(|e| matches!(e, ClaudeEvent::Tool(n) if n == "mcp__sidekick__create_reminder")));
    let reminders = sidekick_lib::store::load_reminders(dir.path());
    assert_eq!(reminders.len(), 1);
    let due = sidekick_lib::files::parse_ms(&reminders[0].due_at).unwrap();
    let in_secs = (due - chrono::Utc::now().timestamp_millis()) / 1000;
    assert!((100..=121).contains(&in_secs), "due in about two minutes, got {in_secs}s");
    s.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_conversation_resumes_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = session(dir.path(), Config::default());
    s.send("session?");
    let first = text(&turn(&mut rx).await);
    assert!(first.ends_with("resumed: false"), "{first}");
    let id = first.trim_start_matches("Session ").split(',').next().unwrap().to_string();

    // New settings restart Claude Code; the next message continues the same session.
    s.restart(None);
    s.send("session?");
    let second = text(&turn(&mut rx).await);
    assert_eq!(second, format!("Session {id}, resumed: true"));

    // A new chat starts a fresh session.
    s.reset();
    s.send("session?");
    let third = text(&turn(&mut rx).await);
    assert!(third.ends_with("resumed: false") && !third.contains(&id), "{third}");
    s.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_and_denied_tools_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = session(dir.path(), Config::default());
    s.send("fail please");
    let ev = turn(&mut rx).await;
    assert!(matches!(ev.last(), Some(ClaudeEvent::Error(m)) if m == "The fake model had a problem."), "{ev:?}");
    assert!(!s.busy());

    s.send("deny please");
    let ev = turn(&mut rx).await;
    assert!(ev.iter().any(|e| matches!(e, ClaudeEvent::Note(n) if n.contains("Not allowed to use: WebSearch"))));
    assert!(matches!(ev.last(), Some(ClaudeEvent::Done)));
    s.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_is_reported_and_the_next_message_works() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = session(dir.path(), Config::default());
    s.send("crash please");
    let ev = turn(&mut rx).await;
    assert!(ev.iter().any(|e| matches!(e, ClaudeEvent::Status { state: "stopped", .. })), "{ev:?}");
    assert!(matches!(ev.last(), Some(ClaudeEvent::Error(m)) if m.contains("Claude Code stopped (exit 3)")), "{ev:?}");
    assert!(!s.busy());

    s.send("still there?");
    assert_eq!(text(&turn(&mut rx).await), "**Echo:** still there?");
    s.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_message_at_a_time() {
    let dir = tempfile::tempdir().unwrap();
    let (s, mut rx) = session(dir.path(), Config::default());
    s.send("slow 700: first");
    s.send("second");
    let ev = turn(&mut rx).await;
    assert!(matches!(&ev.last(), Some(ClaudeEvent::Error(m)) if m.contains("Still working")), "{ev:?}");
    let ev = turn(&mut rx).await;
    assert_eq!(text(&ev), "**Echo:** first");
    s.stop();
}
