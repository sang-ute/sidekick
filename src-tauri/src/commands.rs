//! Commands the UI calls with `invoke(...)`. One per action of the old HTTP API.

use crate::config::Config;
use crate::core::Core;
use crate::shell::{self, Rect};
use crate::store::{Reminder, Task};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

type C<'a> = State<'a, Arc<Core>>;

// ---------- chat ----------
#[tauri::command]
pub fn hello(core: C) -> Value {
    core.hello()
}
#[tauri::command]
pub fn chat(core: C, text: String) -> Result<(), String> {
    core.inner().chat(&text)
}
#[tauri::command]
pub fn reset(core: C) {
    core.reset()
}
#[tauri::command]
pub fn sync(core: C) -> Result<(), String> {
    if core.inner().sync(false) {
        Ok(())
    } else {
        Err("Busy, try again in a moment".into())
    }
}

// ---------- tasks & reminders ----------
#[tauri::command]
pub fn tasks_list(core: C) -> Vec<Task> {
    core.tasks()
}
#[tauri::command]
pub fn task_add(core: C, title: String) -> Result<Value, String> {
    core.add_task(&title)
}
#[tauri::command]
pub fn task_update(core: C, id: String, done: Option<bool>, title: Option<String>) -> Result<Task, String> {
    core.update_task(&id, done, title)
}
#[tauri::command]
pub fn task_delete(core: C, id: String) -> bool {
    core.remove_task(&id)
}
#[tauri::command]
pub fn reminders_list(core: C) -> Vec<Reminder> {
    core.reminders()
}
#[tauri::command]
pub fn reminder_delete(core: C, id: String) -> bool {
    core.remove_reminder(&id)
}

// ---------- notifications ----------
#[tauri::command]
pub fn notifications_clear(core: C) {
    core.clear_notifications()
}
#[tauri::command]
pub fn notification_delete(core: C, id: String) -> bool {
    core.remove_notification(&id)
}

// ---------- settings & info ----------
#[tauri::command]
pub fn settings_get(core: C) -> Value {
    core.settings()
}
#[tauri::command]
pub fn settings_patch(core: C, patch: Value) -> Result<Config, String> {
    core.inner().patch_settings(&patch)
}
#[tauri::command]
pub async fn info(core: C<'_>) -> Result<Value, String> {
    Ok(core.info().await)
}
#[tauri::command]
pub fn skin(core: C) -> Option<String> {
    core.skin()
}

// ---------- account & connections ----------
#[tauri::command]
pub fn claude_login(core: C, method: String) -> Result<(), String> {
    core.claude_login(&method)
}
#[tauri::command]
pub async fn claude_logout(core: C<'_>) -> Result<Value, String> {
    core.inner().claude_logout().await
}
#[tauri::command]
pub fn claude_restart(core: C) {
    core.inner().restart_claude()
}
#[tauri::command]
pub fn github_login(core: C) -> Result<(), String> {
    core.github_login()
}
#[tauri::command]
pub async fn mcp_login(core: C<'_>, name: String) -> Result<(), String> {
    core.mcp_login(&name).await
}
#[tauri::command]
pub fn open_target(app: AppHandle, core: C, target: String) -> Result<(), String> {
    match target.as_str() {
        "connectors" => {
            app.opener().open_url("https://claude.ai/settings/connectors", None::<&str>).map_err(|e| e.to_string())
        }
        "dataFolder" => app.opener().open_path(core.dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string()),
        _ => Err("Unknown target".into()),
    }
}
/// Links in chat replies, tasks and notifications open in the real browser.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------- windows ----------
// Async on purpose: creating or changing windows from a synchronous command can deadlock
// on Windows (the command would block the thread the window needs).
#[tauri::command]
pub async fn toggle_panel(app: AppHandle) {
    shell::toggle_panel(&app)
}
#[tauri::command]
pub async fn open_panel(app: AppHandle) {
    shell::open_panel(&app)
}
#[tauri::command]
pub async fn close_panel(app: AppHandle) {
    shell::close_panel(&app)
}
#[tauri::command]
pub async fn open_settings(app: AppHandle) {
    shell::open_settings(&app)
}
#[tauri::command]
pub async fn close_settings(app: AppHandle) {
    shell::close_settings(&app)
}
#[tauri::command]
pub async fn pet_drag_start(app: AppHandle) {
    shell::drag_start(&app)
}
#[tauri::command]
pub async fn pet_drag_move(app: AppHandle, dx: f64, dy: f64) {
    shell::drag_move(&app, dx, dy)
}
#[tauri::command]
pub async fn pet_drag_end(app: AppHandle) {
    shell::drag_end(&app)
}
#[tauri::command]
pub async fn pet_hit_rects(app: AppHandle, rects: Vec<Rect>) {
    shell::set_hit_rects(&app, rects)
}
#[tauri::command]
pub async fn pet_menu(app: AppHandle) {
    shell::show_pet_menu(&app)
}
