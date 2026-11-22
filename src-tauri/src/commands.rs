use crate::state::{AppState, HitboxRect};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "linux")]
use gtk::prelude::{GtkWindowExt as _, WidgetExt as _};

const MAX_SPRITE_BYTES: u64 = 5 * 1024 * 1024;
static WORKTREE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSpritePack {
    pub root_path: String,
    pub orchestrator: HashMap<String, String>,
    pub subagents: HashMap<String, HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnServeResult {
    pub started: bool,
    pub pid: Option<u32>,
    pub url: String,
    pub password: Option<String>,
    pub message: String,
}

#[cfg(target_os = "linux")]
pub fn apply_linux_input_region(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app_clone.state::<AppState>();
        if !state.overlay_visible.load(Ordering::Relaxed) {
            return;
        }
        let Some(overlay) = app_clone.get_webview_window("overlay") else {
            return;
        };
        let Ok(gtk_win) = overlay.gtk_window() else {
            return;
        };
        let Some(gdk_win) = gtk_win.window() else {
            return;
        };

        if state.force_interactive.load(Ordering::Relaxed) {
            gtk_win.input_shape_combine_region(None);
            state.cursor_ignored.store(false, Ordering::Relaxed);
            return;
        }

        let region = cairo::Region::create();
        if let Ok(rects) = state.hitboxes.lock() {
            for r in rects.iter() {
                let pad = 8;
                let x = (r.x.floor() as i32 - pad).max(0);
                let y = (r.y.floor() as i32 - pad).max(0);
                let w = (r.width.ceil() as i32 + pad * 2).max(1);
                let h = (r.height.ceil() as i32 + pad * 2).max(1);
                let rect = cairo::RectangleInt::new(x, y, w, h);
                let _ = region.union_rectangle(&rect);
            }
        }
        gdk_win.input_shape_combine_region(&region, 0, 0);
        state.cursor_ignored.store(true, Ordering::Relaxed);
    });
}

#[tauri::command]
pub fn set_overlay_ignore_cursor_events(
    app: AppHandle,
    state: State<'_, AppState>,
    ignore: bool,
) -> Result<(), String> {
    if state.force_interactive.load(Ordering::Relaxed) && ignore {
        return Ok(());
    }
    if !state.overlay_visible.load(Ordering::Relaxed) {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if !ignore {
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(overlay) = app_clone.get_webview_window("overlay") {
                    if let Ok(gtk_win) = overlay.gtk_window() {
                        gtk_win.input_shape_combine_region(None);
                    }
                }
            });
            state.cursor_ignored.store(false, Ordering::Relaxed);
        } else {
            apply_linux_input_region(&app);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let overlay = app
            .get_webview_window("overlay")
            .ok_or_else(|| "Overlay window not found".to_string())?;
        overlay
            .set_ignore_cursor_events(ignore)
            .map_err(|e| format!("Failed to update cursor ignore state: {e}"))?;
        state.cursor_ignored.store(ignore, Ordering::Relaxed);
        Ok(())
    }
}

#[tauri::command]
pub fn set_overlay_force_interactive(
    app: AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> Result<(), String> {
    state.force_interactive.store(force, Ordering::Relaxed);
    #[cfg(target_os = "linux")]
    {
        apply_linux_input_region(&app);
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        if state.overlay_visible.load(Ordering::Relaxed) {
            if let Some(overlay) = app.get_webview_window("overlay") {
                let ignore = !force;
                let _ = overlay.set_ignore_cursor_events(ignore);
                state.cursor_ignored.store(ignore, Ordering::Relaxed);
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub fn update_overlay_hitboxes(
    app: AppHandle,
    state: State<'_, AppState>,
    rects: Vec<HitboxRect>,
) -> Result<(), String> {
    {
        let mut guard = state
            .hitboxes
            .lock()
            .map_err(|_| "Failed to lock hitbox state".to_string())?;
        *guard = rects;
    }
    #[cfg(target_os = "linux")]
    {
        if state.overlay_visible.load(Ordering::Relaxed) {
            apply_linux_input_region(&app);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn set_overlay_drag_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    dragging: bool,
) -> Result<(), String> {
    if !state.overlay_visible.load(Ordering::Relaxed) {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if dragging {
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(overlay) = app_clone.get_webview_window("overlay") {
                    if let Ok(gtk_win) = overlay.gtk_window() {
                        gtk_win.input_shape_combine_region(None);
                    }
                }
            });
            state.cursor_ignored.store(false, Ordering::Relaxed);
        } else {
            apply_linux_input_region(&app);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.set_ignore_cursor_events(!dragging);
            state.cursor_ignored.store(!dragging, Ordering::Relaxed);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn set_overlay_always_on_top(app: AppHandle, always_on_top: bool) -> Result<(), String> {
    let overlay = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    let _ = overlay.set_always_on_top(always_on_top);
    #[cfg(target_os = "linux")]
    {
        let app_clone = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(ov) = app_clone.get_webview_window("overlay") {
                if let Ok(gtk_win) = ov.gtk_window() {
                    if !crate::layer_shell::set_overlay_layer_top(&gtk_win, always_on_top) {
                        gtk_win.set_keep_above(always_on_top);
                    }
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn set_window_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    free_roam: bool,
) -> Result<(), String> {
    let main_win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let overlay = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;

    if free_roam {
        let mut using_layer_shell = false;
        #[cfg(target_os = "linux")]
        {
            if let Ok(gtk_win) = overlay.gtk_window() {
                using_layer_shell = crate::layer_shell::is_layer_active(&gtk_win);
            }
        }

        if !using_layer_shell {
            let monitor = main_win
                .primary_monitor()
                .ok()
                .flatten()
                .or_else(|| main_win.current_monitor().ok().flatten())
                .or_else(|| {
                    main_win
                        .available_monitors()
                        .ok()
                        .and_then(|list| list.into_iter().next())
                });

            if let Some(monitor) = monitor {
                let scale = monitor.scale_factor().max(1.0);
                // work_area ends at the top edge of a visible taskbar, and spans to screen bottom when taskbar is hidden.
                let work = monitor.work_area();
                let target_w = work.size.width.max((640.0 * scale) as u32);
                let target_h = work.size.height.max((320.0 * scale) as u32);
                let target_x = work.position.x;
                let target_y = work.position.y;

                let _ = overlay.set_size(PhysicalSize::new(target_w, target_h));
                let _ = overlay.set_position(PhysicalPosition::new(target_x, target_y));
            }
        }

        let _ = overlay.set_always_on_top(true);
        let _ = overlay.set_visible_on_all_workspaces(true);
        state.overlay_visible.store(true, Ordering::Relaxed);
        overlay
            .show()
            .map_err(|e| format!("Failed to show overlay window: {e}"))?;

        #[cfg(target_os = "linux")]
        {
            let app_top = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(ov) = app_top.get_webview_window("overlay") {
                    if let Ok(gtk_win) = ov.gtk_window() {
                        if !crate::layer_shell::set_overlay_layer_top(&gtk_win, true) {
                            gtk_win.set_keep_above(true);
                            gtk_win.stick();
                        }
                    }
                }
            });
            // Defer input-region application slightly so GTK realizes the mapped GdkWindow first.
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(160));
                apply_linux_input_region(&app_clone);
            });
        }
        #[cfg(not(target_os = "linux"))]
        {
            let start_ignore = !state.force_interactive.load(Ordering::Relaxed);
            let _ = overlay.set_ignore_cursor_events(start_ignore);
            state.cursor_ignored.store(start_ignore, Ordering::Relaxed);
        }
    } else {
        state.overlay_visible.store(false, Ordering::Relaxed);
        state.cursor_ignored.store(false, Ordering::Relaxed);
        #[cfg(target_os = "linux")]
        {
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(ov) = app_clone.get_webview_window("overlay") {
                    if let Ok(gtk_win) = ov.gtk_window() {
                        gtk_win.input_shape_combine_region(None);
                    }
                    let _ = ov.hide();
                }
            });
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = overlay.set_ignore_cursor_events(false);
            let _ = overlay.hide();
        }
        let _ = main_win.show();
        let _ = main_win.unminimize();
        let _ = main_win.set_focus();
    }

    Ok(())
}

fn resolve_pets_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("assets").join("pets"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("assets").join("pets"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("assets").join("pets"));
        }
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("assets").join("pets"));
        candidates.push(res_dir.join("_up_").join("assets").join("pets"));
    }

    candidates.into_iter().find(|p| p.is_dir())
}

fn load_png_dir(dir: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return map;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_png = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if !is_png {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.len() > MAX_SPRITE_BYTES {
            continue;
        }
        if let Ok(bytes) = fs::read(&path) {
            let encoded = BASE64.encode(bytes);
            map.insert(
                stem.to_lowercase(),
                format!("data:image/png;base64,{encoded}"),
            );
        }
    }
    map
}

#[tauri::command]
pub fn scan_pet_sprites(app: AppHandle) -> Result<PetSpritePack, String> {
    let Some(root) = resolve_pets_root(&app) else {
        return Err("Could not locate assets/pets directory".to_string());
    };

    let orchestrator = load_png_dir(&root.join("orchestrator"));
    let mut subagents = HashMap::new();
    let sub_root = root.join("subagents");
    if let Ok(entries) = fs::read_dir(&sub_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(role) = path.file_name().and_then(|n| n.to_str()) {
                let sprites = load_png_dir(&path);
                if !sprites.is_empty() {
                    subagents.insert(role.to_lowercase(), sprites);
                }
            }
        }
    }

    Ok(PetSpritePack {
        root_path: root.to_string_lossy().to_string(),
        orchestrator,
        subagents,
    })
}

fn default_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::temp_dir())
}

fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_available_port(preferred: u16) -> u16 {
    for offset in 0..20u16 {
        let candidate = preferred.saturating_add(offset);
        if is_port_free(candidate) {
            return candidate;
        }
    }
    preferred
}

fn generate_ephemeral_password() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = WORKTREE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("ocpet-{}-{}-{}", std::process::id(), seq, ts)
}

#[tauri::command]
pub fn spawn_opencode_serve(
    state: State<'_, AppState>,
    workspace_dir: String,
    port: u16,
) -> Result<SpawnServeResult, String> {
    let mut guard = state
        .opencode_child
        .lock()
        .map_err(|_| "Failed to lock opencode child mutex".to_string())?;

    if let Some(existing) = guard.as_mut() {
        match existing.try_wait() {
            Ok(None) => {
                let active_port = state
                    .server_port
                    .lock()
                    .ok()
                    .and_then(|g| *g)
                    .unwrap_or(port);
                let active_pw = state
                    .server_password
                    .lock()
                    .ok()
                    .and_then(|g| g.clone());
                return Ok(SpawnServeResult {
                    started: true,
                    pid: Some(existing.id()),
                    url: format!("http://127.0.0.1:{active_port}"),
                    password: active_pw,
                    message: "Managed opencode serve is already running".to_string(),
                });
            }
            _ => {
                *guard = None;
            }
        }
    }

    let work_dir = if workspace_dir.trim().is_empty() {
        default_home_dir()
    } else {
        PathBuf::from(&workspace_dir)
    };
    if !work_dir.is_dir() {
        return Err(format!(
            "Workspace directory does not exist: {}",
            work_dir.display()
        ));
    }

    let chosen_port = find_available_port(port);
    let password = std::env::var("OPENCODE_SERVER_PASSWORD")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(generate_ephemeral_password);

    let mut cmd = Command::new("opencode");
    cmd.arg("serve")
        .arg("--hostname")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(chosen_port.to_string())
        .arg("--cors")
        .arg("http://localhost:1420")
        .arg("--cors")
        .arg("tauri://localhost")
        .arg("--cors")
        .arg("http://tauri.localhost")
        .env("OPENCODE_SERVER_USERNAME", "opencode")
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn `opencode serve` (ensure `opencode` is installed and on PATH): {e}"
        )
    })?;

    // Wait briefly until the TCP socket accepts connections or the child exits.
    let addr: SocketAddr = ([127, 0, 0, 1], chosen_port).into();
    for _ in 0..35 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "`opencode serve` exited immediately with status {status} on port {chosen_port}"
            ));
        }
        if TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    let pid = child.id();
    *guard = Some(child);
    if let Ok(mut p) = state.server_port.lock() {
        *p = Some(chosen_port);
    }
    if let Ok(mut pw) = state.server_password.lock() {
        *pw = Some(password.clone());
    }

    Ok(SpawnServeResult {
        started: true,
        pid: Some(pid),
        url: format!("http://127.0.0.1:{chosen_port}"),
        password: Some(password),
        message: format!("Spawned opencode serve (PID {pid}) on 127.0.0.1:{chosen_port}"),
    })
}

#[tauri::command]
pub fn stop_opencode_serve(state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = state
        .opencode_child
        .lock()
        .map_err(|_| "Failed to lock opencode child mutex".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn git_is_repo(workspace_dir: String) -> bool {
    if workspace_dir.trim().is_empty() {
        return false;
    }
    Command::new("git")
        .arg("-C")
        .arg(&workspace_dir)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn sanitize_slug(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "task".to_string()
    } else {
        trimmed.chars().take(24).collect()
    }
}

fn worktree_base_dir() -> PathBuf {
    std::env::temp_dir().join("boymoder-worktrees")
}

pub fn validate_managed_worktree_path(target: &Path, base_dir: &Path) -> Result<PathBuf, String> {
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Refusing worktree path containing parent traversal ('..')".to_string());
    }

    fs::create_dir_all(base_dir)
        .map_err(|e| format!("Failed to resolve managed worktree directory: {e}"))?;
    let canon_base = fs::canonicalize(base_dir)
        .map_err(|e| format!("Failed to canonicalize worktree base dir: {e}"))?;

    let canon_target = if target.exists() {
        fs::canonicalize(target).map_err(|e| format!("Failed to canonicalize worktree path: {e}"))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| "Invalid worktree path".to_string())?;
        let name = target
            .file_name()
            .ok_or_else(|| "Invalid worktree filename".to_string())?;
        fs::canonicalize(parent)
            .map_err(|e| format!("Failed to canonicalize worktree parent: {e}"))?
            .join(name)
    };

    if !canon_target.starts_with(&canon_base) || canon_target == canon_base {
        return Err("Refusing to remove worktree outside managed temp directory".to_string());
    }
    Ok(canon_target)
}

#[tauri::command]
pub fn git_worktree_create(workspace_dir: String, task_id: String) -> Result<WorktreeInfo, String> {
    if !git_is_repo(workspace_dir.clone()) {
        return Err("Selected directory is not a git repository".to_string());
    }

    let head_check = Command::new("git")
        .arg("-C")
        .arg(&workspace_dir)
        .arg("rev-parse")
        .arg("--verify")
        .arg("HEAD")
        .output()
        .map_err(|e| format!("Failed to check git HEAD: {e}"))?;
    if !head_check.status.success() {
        return Err(
            "Git repository has no commits yet (HEAD missing); skipping worktree isolation"
                .to_string(),
        );
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = WORKTREE_SEQ.fetch_add(1, Ordering::Relaxed);
    let slug = sanitize_slug(&task_id);
    let unique_name = format!("{slug}-{seq}-{ts}");
    let branch = format!("boymoder/{unique_name}");

    let base_dir = worktree_base_dir();
    fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to create temp worktree folder: {e}"))?;
    let wt_path = base_dir.join(&unique_name);

    let out = Command::new("git")
        .arg("-C")
        .arg(&workspace_dir)
        .arg("worktree")
        .arg("add")
        .arg("-b")
        .arg(&branch)
        .arg(&wt_path)
        .arg("HEAD")
        .output()
        .map_err(|e| format!("Failed to execute git worktree add: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git worktree add failed: {stderr}"));
    }

    Ok(WorktreeInfo {
        path: wt_path.to_string_lossy().to_string(),
        branch,
    })
}

#[tauri::command]
pub fn git_worktree_remove(
    workspace_dir: String,
    worktree_path: String,
    branch: Option<String>,
    force: bool,
) -> Result<(), String> {
    let base_dir = worktree_base_dir();
    let canon_target = validate_managed_worktree_path(Path::new(&worktree_path), &base_dir)?;

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&workspace_dir)
        .arg("worktree")
        .arg("remove");
    if force {
        cmd.arg("--force");
    }
    cmd.arg(&canon_target);

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to execute git worktree remove: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git worktree remove failed: {stderr}"));
    }

    if let Some(br) = branch {
        if br.starts_with("boymoder/") || br.starts_with("akuur/") || br.starts_with("opencode-pet/") {
            let _ = Command::new("git")
                .arg("-C")
                .arg(&workspace_dir)
                .arg("branch")
                .arg("-d")
                .arg(&br)
                .output();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_worktree_diff_summary(worktree_path: String) -> Result<String, String> {
    let status_out = Command::new("git")
        .arg("-C")
        .arg(&worktree_path)
        .arg("status")
        .arg("--short")
        .output()
        .map_err(|e| format!("Failed to run git status: {e}"))?;

    let diff_out = Command::new("git")
        .arg("-C")
        .arg(&worktree_path)
        .arg("diff")
        .arg("--stat")
        .output()
        .map_err(|e| format!("Failed to run git diff --stat: {e}"))?;

    let status_txt = String::from_utf8_lossy(&status_out.stdout).trim().to_string();
    let diff_txt = String::from_utf8_lossy(&diff_out.stdout).trim().to_string();

    if status_txt.is_empty() && diff_txt.is_empty() {
        Ok("No uncommitted changes in worktree.".to_string())
    } else {
        Ok(format!("{status_txt}\n{diff_txt}").trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_slug_truncates_and_cleans() {
        assert_eq!(sanitize_slug("subtask/1: test!"), "subtask-1--test");
        assert_eq!(sanitize_slug("///"), "task");
        let long = "a".repeat(50);
        assert_eq!(sanitize_slug(&long).len(), 24);
    }

    #[test]
    fn worktree_validation_rejects_traversal() {
        let base = worktree_base_dir();
        assert!(validate_managed_worktree_path(
            Path::new("/tmp/boymoder-worktrees/../other"),
            &base
        )
        .is_err());
        assert!(validate_managed_worktree_path(&base, &base).is_err());
    }
}
