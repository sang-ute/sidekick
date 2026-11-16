//! The desktop side: mascot, chat and settings windows, click-through, eye tracking,
//! dragging, tray icon and menus, global shortcut, autostart, theme, system notifications.

use crate::config::Config;
use crate::core::Core;
use crate::files::{is_test_run, read_json, write_json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const PANEL: (f64, f64) = (380.0, 580.0);
const SETTINGS: (f64, f64) = (820.0, 600.0);

/// A rectangle in the mascot window (CSS pixels) that should catch the mouse.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Default)]
pub struct Shell {
    dragging: bool,
    drag_origin: Option<(f64, f64)>,
    rects: Vec<Rect>,
    ignoring: Option<bool>,
    last_eyes: (i64, i64),
    shortcut: Option<String>,
    applied: Option<Config>,
}

type ShellState = Mutex<Shell>;

fn shell(app: &AppHandle) -> std::sync::MutexGuard<'_, Shell> {
    app.state::<ShellState>().inner().lock().unwrap()
}
fn cfg(app: &AppHandle) -> Config {
    app.state::<Arc<Core>>().config()
}
fn win(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

// ---------- mascot geometry ----------
fn pet_size(c: &Config) -> (f64, f64) {
    (340.0, 300.0 + (130.0 * c.mascot_scale()).round()) // notifier card + room for its shadow, pet below
}

fn shell_file(app: &AppHandle) -> std::path::PathBuf {
    app.state::<Arc<Core>>().dir.join("shell.json")
}

/// Logical work area of the monitor at a point (or the primary one).
fn work_area(app: &AppHandle, at: Option<(f64, f64)>) -> (f64, f64, f64, f64) {
    let m = at
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match m {
        Some(m) => {
            let s = m.scale_factor();
            let wa = m.work_area();
            (wa.position.x as f64 / s, wa.position.y as f64 / s, wa.size.width as f64 / s, wa.size.height as f64 / s)
        }
        None => (0.0, 0.0, 1280.0, 720.0),
    }
}

/// Where the pet's feet are: `(center x, bottom)` in logical pixels.
fn pet_anchor(app: &AppHandle) -> (f64, f64) {
    let saved: Option<Value> = read_json(&shell_file(app));
    if let Some(a) = saved.as_ref().and_then(|v| v.get("petAnchor")).filter(|a| a.is_object()) {
        if let (Some(cx), Some(bottom)) = (a["cx"].as_f64(), a["bottom"].as_f64()) {
            let (x, y, w, h) = work_area(app, Some((cx, bottom - 50.0)));
            if cx > x && cx < x + w && bottom > y + 100.0 && bottom <= y + h + 20.0 {
                return (cx, bottom);
            }
        }
    }
    let (x, y, w, h) = work_area(app, None);
    (x + w - 170.0, y + h)
}

fn place_pet(app: &AppHandle, pet: &WebviewWindow, anchor: (f64, f64)) {
    let (w, h) = pet_size(&cfg(app));
    let _ = pet.set_size(LogicalSize::new(w, h));
    let _ = pet.set_position(LogicalPosition::new((anchor.0 - w / 2.0).round(), (anchor.1 - h).round()));
}

/// The pet window's bounds in logical pixels.
fn pet_bounds(pet: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let s = pet.scale_factor().ok()?;
    let p = pet.outer_position().ok()?;
    let z = pet.outer_size().ok()?;
    Some((p.x as f64 / s, p.y as f64 / s, z.width as f64 / s, z.height as f64 / s))
}

// ---------- windows ----------
/// Test runs only: expose the WebView2 DevTools port (SIDEKICK_DEVTOOLS_PORT) so automated
/// checks can drive the real UI. All windows share one WebView2 process, so all get the
/// same arguments (Tauri's defaults plus the port).
fn test_args(b: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    match std::env::var("SIDEKICK_DEVTOOLS_PORT") {
        Ok(p) if is_test_run() && !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            b.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={p}"))
        }
        _ => b,
    }
}

fn theme_of(c: &Config) -> Option<Theme> {
    match c.theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let c = cfg(app);
    let (w, h) = pet_size(&c);
    let anchor = pet_anchor(app);
    // For screenshots: force a mascot mood or the notifier with sample data.
    let demo = std::env::var("SIDEKICK_MASCOT_DEMO").ok().filter(|d| d.chars().all(|ch| ch.is_ascii_lowercase()));
    let init = format!("window.__SIDEKICK_DEMO__ = {};", serde_json::to_string(&demo).unwrap_or("null".into()));
    let pet = test_args(WebviewWindowBuilder::new(app, "mascot", WebviewUrl::App("mascot.html".into())))
        .title("Sidekick")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .theme(theme_of(&c))
        .inner_size(w, h)
        .position((anchor.0 - w / 2.0).round(), (anchor.1 - h).round())
        .initialization_script(&init)
        .visible(c.mascot_visible)
        .build()?;
    let _ = pet.set_ignore_cursor_events(true); // clicks pass through except on the pet and notifier
    shell(app).ignoring = Some(true);

    test_args(WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("index.html".into())))
        .title("Sidekick")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .theme(theme_of(&c))
        .inner_size(PANEL.0, PANEL.1)
        .visible(false)
        .build()?;

    build_tray(app)?;
    spawn_pointer_loop(app.clone());
    apply_config(app, &c);

    // Test runs only: open windows at startup (SIDEKICK_OPEN=panel,settings) for screenshots.
    if is_test_run() {
        let open = std::env::var("SIDEKICK_OPEN").unwrap_or_default();
        if open.split(',').any(|w| w == "panel") {
            open_panel(app);
        }
        if open.split(',').any(|w| w == "settings") {
            open_settings(app);
        }
    }
    Ok(())
}

fn emit_panel_state(app: &AppHandle, open: bool) {
    for l in ["mascot", "panel"] {
        let _ = app.emit_to(l, "panel-state", open);
    }
}

fn place_panel(app: &AppHandle) {
    let (Some(pet), Some(panel)) = (win(app, "mascot"), win(app, "panel")) else { return };
    let Some((bx, by, bw, bh)) = pet_bounds(&pet) else { return };
    let (wx, wy, ww, wh) = work_area(app, Some((bx + bw / 2.0, by + bh / 2.0)));
    let mut x = bx + bw / 2.0 - PANEL.0 - 50.0;
    if x < wx {
        x = bx + bw / 2.0 + 50.0;
    }
    x = x.max(wx).min(wx + ww - PANEL.0);
    let y = (by + bh - PANEL.1).min(wy + wh - PANEL.1).max(wy);
    let _ = panel.set_position(LogicalPosition::new(x.round(), y.round()));
}

pub fn open_panel(app: &AppHandle) {
    if let Some(pet) = win(app, "mascot") {
        if cfg(app).mascot_visible && !pet.is_visible().unwrap_or(true) {
            let _ = pet.show();
        }
    }
    place_panel(app);
    if let Some(panel) = win(app, "panel") {
        let _ = panel.show();
        let _ = panel.set_focus();
    }
    emit_panel_state(app, true);
}

pub fn close_panel(app: &AppHandle) {
    if let Some(panel) = win(app, "panel") {
        let _ = panel.hide();
    }
    emit_panel_state(app, false);
}

pub fn toggle_panel(app: &AppHandle) {
    let open = win(app, "panel").and_then(|p| p.is_visible().ok()).unwrap_or(false);
    if open {
        close_panel(app)
    } else {
        open_panel(app)
    }
}

pub fn open_settings(app: &AppHandle) {
    if let Some(w) = win(app, "settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let c = cfg(app);
    let built = test_args(WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into())))
        .title("Sidekick settings")
        .decorations(false)
        .resizable(true)
        .theme(theme_of(&c))
        .inner_size(SETTINGS.0, SETTINGS.1)
        .min_inner_size(520.0, 420.0)
        .center()
        .build();
    if let Ok(w) = built {
        let _ = w.set_focus();
    }
}

pub fn close_settings(app: &AppHandle) {
    if let Some(w) = win(app, "settings") {
        let _ = w.close();
    }
}

// ---------- dragging & hit-testing ----------
pub fn drag_start(app: &AppHandle) {
    let bounds = win(app, "mascot").and_then(|p| pet_bounds(&p));
    let mut s = shell(app);
    s.dragging = true;
    s.drag_origin = bounds.map(|b| (b.0, b.1));
}

pub fn drag_move(app: &AppHandle, dx: f64, dy: f64) {
    if !dx.is_finite() || !dy.is_finite() {
        return;
    }
    let Some(origin) = shell(app).drag_origin else { return };
    if let Some(pet) = win(app, "mascot") {
        let _ = pet.set_position(LogicalPosition::new((origin.0 + dx).round(), (origin.1 + dy).round()));
    }
    if win(app, "panel").and_then(|p| p.is_visible().ok()).unwrap_or(false) {
        place_panel(app);
    }
}

pub fn drag_end(app: &AppHandle) {
    {
        let mut s = shell(app);
        s.dragging = false;
        s.drag_origin = None;
    }
    if let Some((x, y, w, h)) = win(app, "mascot").and_then(|p| pet_bounds(&p)) {
        let mut st: Value = read_json(&shell_file(app)).unwrap_or(json!({}));
        st["petAnchor"] = json!({ "cx": x + w / 2.0, "bottom": y + h });
        st["petPos"] = Value::Null;
        let _ = write_json(&shell_file(app), &st);
    }
}

pub fn set_hit_rects(app: &AppHandle, rects: Vec<Rect>) {
    shell(app).rects = rects.into_iter().take(16).collect();
}

/// Every 40 ms: make the mascot window clickable only over the pet/notifier, and send
/// the cursor offset for the eyes (~12 times a second).
fn spawn_pointer_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            tick = tick.wrapping_add(1);
            let Some(pet) = win(&app, "mascot") else { continue };
            if !pet.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(cur), Ok(pos), Ok(size), Ok(scale)) = (app.cursor_position(), pet.outer_position(), pet.outer_size(), pet.scale_factor()) else {
                continue;
            };
            let lx = (cur.x - pos.x as f64) / scale;
            let ly = (cur.y - pos.y as f64) / scale;
            let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
            let pet_scale = cfg(&app).mascot_scale();
            let (want_ignore, eyes_changed, eyes) = {
                let mut s = shell(&app);
                let inside = lx >= 0.0 && ly >= 0.0 && lx < w && ly < h && s.rects.iter().any(|r| lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
                let want_ignore = !(inside || s.dragging);
                let eyes = ((lx - w / 2.0).round() as i64, (ly - (h - 66.0 * pet_scale)).round() as i64);
                let changed = tick % 2 == 0 && eyes != s.last_eyes;
                if changed {
                    s.last_eyes = eyes;
                }
                let apply = s.ignoring != Some(want_ignore);
                if apply {
                    s.ignoring = Some(want_ignore);
                }
                (apply.then_some(want_ignore), changed, eyes)
            };
            if let Some(ignore) = want_ignore {
                let _ = pet.set_ignore_cursor_events(ignore);
            }
            if eyes_changed {
                let _ = app.emit_to("mascot", "pet-cursor", json!({ "dx": eyes.0, "dy": eyes.1 }));
            }
        }
    });
}

// ---------- menus & tray ----------
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let c = cfg(app);
    let none: Option<&str> = None;
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "chat", "Chat", true, none)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, none)?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "show_mascot", "Show mascot", true, c.mascot_visible, none)?,
            &MenuItem::with_id(app, "reset_position", "Reset mascot position", true, none)?,
            &CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, c.open_at_login, none)?,
            &MenuItem::with_id(app, "data_folder", "Open data folder", true, none)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Sidekick", true, none)?,
        ],
    )
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut tray = TrayIconBuilder::with_id("main").tooltip("Sidekick").menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(
        |tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_panel(tray.app_handle());
            }
        },
    );
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn show_pet_menu(app: &AppHandle) {
    if let (Some(pet), Ok(menu)) = (win(app, "mascot"), build_menu(app)) {
        let _ = pet.popup_menu(&menu);
    }
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let core = app.state::<Arc<Core>>().inner().clone();
    match event.id().as_ref() {
        "chat" => open_panel(app),
        "settings" => open_settings(app),
        "show_mascot" => {
            let _ = core.patch_settings(&json!({ "mascotVisible": !cfg(app).mascot_visible }));
        }
        "autostart" => {
            let _ = core.patch_settings(&json!({ "openAtLogin": !cfg(app).open_at_login }));
        }
        "reset_position" => {
            let mut st: Value = read_json(&shell_file(app)).unwrap_or(json!({}));
            st["petAnchor"] = Value::Null;
            st["petPos"] = Value::Null;
            let _ = write_json(&shell_file(app), &st);
            if let Some(pet) = win(app, "mascot") {
                place_pet(app, &pet, pet_anchor(app));
            }
        }
        "data_folder" => {
            let _ = app.opener().open_path(core.dir.to_string_lossy(), None::<&str>);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

// ---------- applying settings ----------
/// Electron-style accelerator → the global-hotkey format ("Meta" → "Super", "Plus" → "=").
fn accelerator(s: &str) -> String {
    s.split('+')
        .map(|p| match p.trim().to_ascii_lowercase().as_str() {
            "meta" => "Super".to_string(),
            "plus" => "=".to_string(),
            _ => p.trim().to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

pub fn apply_config(app: &AppHandle, c: &Config) {
    let prev = shell(app).applied.clone();
    let theme = theme_of(c);
    for l in ["mascot", "panel", "settings"] {
        if let Some(w) = win(app, l) {
            let _ = w.set_theme(theme);
        }
    }

    if !is_test_run() && prev.as_ref().map(|p| p.open_at_login) != Some(c.open_at_login) {
        let al = app.autolaunch();
        let _ = if c.open_at_login { al.enable() } else { al.disable() };
    }

    if let Some(pet) = win(app, "mascot") {
        if prev.as_ref().is_some_and(|p| p.mascot_size != c.mascot_size) {
            if let Some((x, y, w, h)) = pet_bounds(&pet) {
                place_pet(app, &pet, (x + w / 2.0, y + h));
            }
            if win(app, "panel").and_then(|p| p.is_visible().ok()).unwrap_or(false) {
                place_panel(app);
            }
        }
        let visible = pet.is_visible().unwrap_or(false);
        if c.mascot_visible && !visible {
            let _ = pet.show();
        }
        if !c.mascot_visible && visible {
            let _ = pet.hide();
            close_panel(app);
        }
    }

    let want = accelerator(&c.shortcut);
    let current = shell(app).shortcut.clone();
    if current.as_deref() != Some(want.as_str()) {
        let gs = app.global_shortcut();
        if let Some(old) = current {
            let _ = gs.unregister(old.as_str());
        }
        let ok = gs.register(want.as_str()).is_ok();
        shell(app).shortcut = ok.then_some(want.clone());
    }

    let tip = if shell(app).shortcut.is_some() { format!("Sidekick ({})", c.shortcut) } else { "Sidekick".into() };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tip));
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    shell(app).applied = Some(c.clone());
}

pub fn system_notification(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
