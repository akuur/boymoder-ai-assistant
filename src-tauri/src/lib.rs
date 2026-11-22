mod commands;
#[cfg(target_os = "linux")]
mod layer_shell;
mod state;

use state::AppState;
use std::sync::atomic::Ordering;
#[cfg(not(target_os = "linux"))]
use std::time::Duration;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(not(target_os = "linux"))]
const HITBOX_PADDING_LOGICAL: f64 = 8.0;

#[cfg(not(target_os = "linux"))]
fn start_cursor_hitbox_loop(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(50));

            let app_state = app_handle.state::<AppState>();
            if !app_state.overlay_visible.load(Ordering::Relaxed) {
                continue;
            }
            if app_state.force_interactive.load(Ordering::Relaxed) {
                continue;
            }

            let Some(overlay) = app_handle.get_webview_window("overlay") else {
                continue;
            };
            if !overlay.is_visible().unwrap_or(false) {
                continue;
            }

            let Ok(cursor) = overlay.cursor_position() else {
                continue;
            };
            let Ok(win_pos) = overlay.inner_position() else {
                continue;
            };
            let scale = overlay.scale_factor().unwrap_or(1.0).max(1.0);

            let lx = (cursor.x - win_pos.x as f64) / scale;
            let ly = (cursor.y - win_pos.y as f64) / scale;

            let hit = if let Ok(rects) = app_state.hitboxes.lock() {
                rects.iter().any(|r| {
                    lx >= (r.x - HITBOX_PADDING_LOGICAL)
                        && lx <= (r.x + r.width + HITBOX_PADDING_LOGICAL)
                        && ly >= (r.y - HITBOX_PADDING_LOGICAL)
                        && ly <= (r.y + r.height + HITBOX_PADDING_LOGICAL)
                })
            } else {
                false
            };

            let should_ignore = !hit;
            let prev_ignored = app_state.cursor_ignored.load(Ordering::Relaxed);
            if should_ignore != prev_ignored {
                if overlay.set_ignore_cursor_events(should_ignore).is_ok() {
                    app_state.cursor_ignored.store(should_ignore, Ordering::Relaxed);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::set_overlay_ignore_cursor_events,
            commands::set_overlay_force_interactive,
            commands::set_overlay_drag_capture,
            commands::set_overlay_always_on_top,
            commands::update_overlay_hitboxes,
            commands::set_window_mode,
            commands::scan_pet_sprites,
            commands::spawn_opencode_serve,
            commands::stop_opencode_serve,
            commands::check_agent_cli_availability,
            commands::spawn_agent_cli,
            commands::kill_agent_cli,
            commands::git_is_repo,
            commands::git_worktree_create,
            commands::git_worktree_remove,
            commands::git_worktree_diff_summary,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = window.app_handle();
                if window.label() == "main" {
                    app_handle.exit(0);
                } else if window.label() == "overlay" {
                    api.prevent_close();
                    let state = app_handle.state::<AppState>();
                    state.overlay_visible.store(false, Ordering::Relaxed);
                    state.cursor_ignored.store(false, Ordering::Relaxed);
                    #[cfg(not(target_os = "linux"))]
                    let _ = window.set_ignore_cursor_events(false);
                    let _ = window.hide();
                    if let Some(main_win) = app_handle.get_webview_window("main") {
                        let _ = main_win.show();
                        let _ = main_win.unminimize();
                        let _ = main_win.set_focus();
                    }
                }
            }
        })
        .setup(|app| {
            #[cfg(not(target_os = "linux"))]
            start_cursor_hitbox_loop(app.handle().clone());
            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::GtkWindowExt as _;
                if let Some(main_win) = app.get_webview_window("main") {
                    if let Ok(gtk_win) = main_win.gtk_window() {
                        gtk_win.set_icon_name(Some("boymoder-ai-assistant"));
                    }
                }
                if let Some(overlay) = app.get_webview_window("overlay") {
                    if let Ok(gtk_win) = overlay.gtk_window() {
                        crate::layer_shell::init_overlay_layer(&gtk_win);
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let (child_opt, agent_clis_arc) = {
                let state = app_handle.state::<AppState>();
                let opencode = state
                    .opencode_child
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.take());
                (opencode, std::sync::Arc::clone(&state.agent_clis))
            };
            if let Some(mut child) = child_opt {
                let _ = child.kill();
                let _ = child.wait();
            }
            commands::kill_all_agent_clis_in_map(&agent_clis_arc);
        }
    });
}
