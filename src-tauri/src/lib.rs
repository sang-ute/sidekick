//! Sidekick: a desktop mascot that runs on your own Claude Code.

mod claude;
mod commands;
mod config;
mod core;
mod files;
mod integrations;
pub mod mcp;
mod proc;
mod shell;
mod store;

use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent};
use tauri_plugin_global_shortcut::ShortcutState;

pub fn run() {
    let mut builder = tauri::Builder::default();
    // One Sidekick at a time; a second launch opens the chat. (Test runs skip this so
    // they can run next to the real app.)
    if !files::is_test_run() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::open_panel(app)));
    }
    let app = builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        shell::toggle_panel(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(shell::Shell::default()))
        .setup(|app| {
            let core = core::Core::new(app.handle().clone(), files::data_dir());
            app.manage(Arc::clone(&core));
            shell::setup(app.handle())?;
            // Test runs only: send a chat message a few seconds after start.
            if files::is_test_run() {
                if let Ok(msg) = std::env::var("SIDEKICK_TEST_CHAT") {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                        let _ = core.chat(&msg);
                    });
                }
            }
            Ok(())
        })
        .on_menu_event(shell::on_menu_event)
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::chat,
            commands::reset,
            commands::sync,
            commands::tasks_list,
            commands::task_add,
            commands::task_update,
            commands::task_delete,
            commands::reminders_list,
            commands::reminder_delete,
            commands::notifications_clear,
            commands::notification_delete,
            commands::settings_get,
            commands::settings_patch,
            commands::info,
            commands::skin,
            commands::claude_login,
            commands::claude_logout,
            commands::claude_restart,
            commands::github_login,
            commands::mcp_login,
            commands::open_target,
            commands::open_url,
            commands::toggle_panel,
            commands::open_panel,
            commands::close_panel,
            commands::open_settings,
            commands::close_settings,
            commands::pet_drag_start,
            commands::pet_drag_move,
            commands::pet_drag_end,
            commands::pet_hit_rects,
            commands::pet_menu,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sidekick");

    app.run(|app, event| match event {
        // Keep living in the tray when windows close; only "Quit" (exit code set) ends the app.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(core) = app.try_state::<Arc<core::Core>>() {
                core.shutdown();
            }
        }
        _ => {}
    });
}
