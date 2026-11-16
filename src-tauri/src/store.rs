//! Task board and reminders, stored as JSON in the data folder. Shared by the app
//! (UI, scheduler) and the MCP mode (Claude), which run as different processes.

use crate::files::{iso_from_ms, new_id, now_iso, parse_ms, read_json, write_json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SOURCES: [&str; 6] = ["me", "gmail", "github", "youtube", "calendar", "other"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "me")]
    pub source: String,
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub done_at: Option<String>,
}
fn me() -> String {
    "me".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub text: String,
    pub due_at: String,
    #[serde(default = "none")]
    pub repeat: String,
    #[serde(default)]
    pub created_at: String,
}
fn none() -> String {
    "none".into()
}

fn tasks_file(dir: &Path) -> PathBuf {
    dir.join("tasks.json")
}
fn reminders_file(dir: &Path) -> PathBuf {
    dir.join("reminders.json")
}
fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn is_http(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

// ---------- tasks ----------
pub fn load_tasks(dir: &Path) -> Vec<Task> {
    read_json(&tasks_file(dir)).unwrap_or_default()
}

#[derive(Default)]
pub struct NewTask {
    pub title: String,
    pub notes: Option<String>,
    pub source: Option<String>,
    pub link: Option<String>,
    pub due: Option<String>,
}

/// Adds a task, unless an open task with the same link is already there (syncs run daily).
pub fn add_task(dir: &Path, input: NewTask) -> (Task, bool) {
    let mut list = load_tasks(dir);
    let link = input.link.unwrap_or_default();
    if !link.is_empty() {
        if let Some(dup) = list.iter().find(|t| t.link == link && !t.done) {
            return (dup.clone(), true);
        }
    }
    let source = input.source.unwrap_or_else(me);
    let task = Task {
        id: new_id(6),
        title: trunc(&input.title, 200),
        notes: trunc(&input.notes.unwrap_or_default(), 500),
        source: if SOURCES.contains(&source.as_str()) { source } else { "other".into() },
        link: if is_http(&link) { link } else { String::new() },
        due: input.due.as_deref().and_then(parse_ms).map(iso_from_ms),
        done: false,
        created_at: now_iso(),
        done_at: None,
    };
    list.push(task.clone());
    let _ = write_json(&tasks_file(dir), &list);
    (task, false)
}

pub fn update_task(dir: &Path, id: &str, done: Option<bool>, title: Option<&str>) -> Option<Task> {
    let mut list = load_tasks(dir);
    let t = list.iter_mut().find(|t| t.id == id)?;
    if let Some(d) = done {
        t.done = d;
        t.done_at = if d { Some(now_iso()) } else { None };
    }
    if let Some(title) = title.map(str::trim).filter(|s| !s.is_empty()) {
        t.title = trunc(title, 200);
    }
    let out = t.clone();
    let _ = write_json(&tasks_file(dir), &list);
    Some(out)
}

pub fn remove_task(dir: &Path, id: &str) -> bool {
    let list = load_tasks(dir);
    let next: Vec<Task> = list.iter().filter(|t| t.id != id).cloned().collect();
    let _ = write_json(&tasks_file(dir), &next);
    next.len() != list.len()
}

/// Drop finished tasks older than a week so the board stays small.
pub fn prune_tasks(dir: &Path) {
    let cutoff = chrono::Utc::now().timestamp_millis() - 7 * 86_400_000;
    let list = load_tasks(dir);
    let next: Vec<Task> = list
        .iter()
        .filter(|t| !t.done || t.done_at.as_deref().and_then(parse_ms).unwrap_or(0) > cutoff)
        .cloned()
        .collect();
    if next.len() != list.len() {
        let _ = write_json(&tasks_file(dir), &next);
    }
}

// ---------- reminders ----------
pub fn load_reminders(dir: &Path) -> Vec<Reminder> {
    read_json(&reminders_file(dir)).unwrap_or_default()
}

pub fn add_reminder(dir: &Path, text: &str, due_at: &str, repeat: Option<&str>) -> Option<Reminder> {
    let due = parse_ms(due_at)?;
    let mut list = load_reminders(dir);
    let r = Reminder {
        id: new_id(6),
        text: text.to_string(),
        due_at: iso_from_ms(due),
        repeat: match repeat {
            Some("daily") => "daily".into(),
            Some("weekly") => "weekly".into(),
            _ => "none".into(),
        },
        created_at: now_iso(),
    };
    list.push(r.clone());
    let _ = write_json(&reminders_file(dir), &list);
    Some(r)
}

pub fn remove_reminder(dir: &Path, id: &str) -> bool {
    let list = load_reminders(dir);
    let next: Vec<Reminder> = list.iter().filter(|r| r.id != id).cloned().collect();
    let _ = write_json(&reminders_file(dir), &next);
    next.len() != list.len()
}

/// Reminders due now. Repeating ones move to their next time (skipping ones missed while
/// the PC was off); one-off ones are removed.
pub fn take_due_reminders(dir: &Path, now_ms: i64) -> Vec<Reminder> {
    let list = load_reminders(dir);
    let mut due = vec![];
    let mut keep = vec![];
    for r in list {
        let at = parse_ms(&r.due_at).unwrap_or(i64::MAX);
        if at > now_ms {
            keep.push(r);
            continue;
        }
        due.push(r.clone());
        let step = match r.repeat.as_str() {
            "daily" => 86_400_000,
            "weekly" => 7 * 86_400_000,
            _ => continue,
        };
        let mut next = at;
        while next <= now_ms {
            next += step;
        }
        keep.push(Reminder { due_at: iso_from_ms(next), ..r });
    }
    if !due.is_empty() {
        let _ = write_json(&reminders_file(dir), &keep);
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sidekick-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tasks_dedupe_by_link_and_update() {
        let d = tmp("tasks");
        let (a, dup) = add_task(&d, NewTask { title: "Review PR".into(), source: Some("github".into()), link: Some("https://x/1".into()), ..Default::default() });
        assert!(!dup);
        let (b, dup2) = add_task(&d, NewTask { title: "again".into(), link: Some("https://x/1".into()), ..Default::default() });
        assert!(dup2);
        assert_eq!(a.id, b.id);
        let (c, _) = add_task(&d, NewTask { title: "odd".into(), source: Some("weird".into()), link: Some("javascript:x".into()), ..Default::default() });
        assert_eq!(c.source, "other");
        assert_eq!(c.link, "");
        assert!(update_task(&d, &a.id, Some(true), None).unwrap().done);
        assert!(remove_task(&d, &c.id));
        assert_eq!(load_tasks(&d).len(), 1);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn reminders_fire_and_repeat() {
        let d = tmp("rem");
        let now = chrono::Utc::now().timestamp_millis();
        add_reminder(&d, "once", &iso_from_ms(now - 1000), None).unwrap();
        add_reminder(&d, "daily", &iso_from_ms(now - 3 * 86_400_000 - 1000), Some("daily")).unwrap();
        add_reminder(&d, "later", "2999-01-01T00:00:00+07:00", None).unwrap();
        assert!(add_reminder(&d, "bad", "tomorrow-ish", None).is_none());
        let due = take_due_reminders(&d, now);
        assert_eq!(due.len(), 2);
        let left = load_reminders(&d);
        assert_eq!(left.len(), 2);
        let daily = left.iter().find(|r| r.text == "daily").unwrap();
        assert!(parse_ms(&daily.due_at).unwrap() > now);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn reads_0x_files() {
        let d = tmp("compat");
        std::fs::write(d.join("tasks.json"), r#"[{"id":"a1","title":"T","notes":"","source":"gmail","link":"","due":null,"done":false,"createdAt":"2026-11-15T17:24:58.872Z","doneAt":null}]"#).unwrap();
        assert_eq!(load_tasks(&d)[0].source, "gmail");
        let _ = std::fs::remove_dir_all(d);
    }
}
