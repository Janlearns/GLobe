mod actions;
mod audio;
mod db;
mod desktop;
pub mod devtools;
mod scanner;
mod security;
mod settings;
mod terminal;
mod wallpaper;

use rusqlite::Connection;
use security::{RootCheck, ScanPolicy, SecuritySettings};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

struct ActiveScan {
    cancel: Arc<AtomicBool>,
    root_ids: Vec<i64>,
}

pub struct AppState {
    db_path: PathBuf,
    settings_path: PathBuf,
    conn: Mutex<Connection>,
    settings: RwLock<SecuritySettings>,
    scan: Arc<Mutex<Option<ActiveScan>>>,
}

impl AppState {
    fn hidden(&self) -> Vec<&'static str> {
        self.settings.read().unwrap().hidden_categories()
    }
    fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> CmdResult<T> {
        let mut conn = self.conn.lock().map_err(|_| "database unavailable".to_string())?;
        f(&mut conn).map_err(|e| format!("Index error: {e}"))
    }
    fn entry(&self, id: i64) -> CmdResult<db::Entry> {
        let e = self.with_conn(|c| db::get_entry(c, id))?.ok_or("Item is not in the index.")?;
        if self.hidden().contains(&e.category.as_str()) {
            return Err("This item is hidden by your security settings.".into());
        }
        Ok(e)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
async fn list_roots(state: State<'_, AppState>) -> CmdResult<Vec<db::RootInfo>> {
    state.with_conn(|c| db::list_roots(c))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddRootResult {
    status: &'static str,
    message: Option<String>,
    root_id: Option<i64>,
}

#[tauri::command]
async fn add_root(state: State<'_, AppState>, path: String, confirmed: bool) -> CmdResult<AddRootResult> {
    let canon = security::canonical_root(&path)?;
    let policy = ScanPolicy::new(&state.settings.read().unwrap());
    let check = policy.check_root(&canon)?;
    let display = security::display_path(&canon);
    if check == RootCheck::NeedsConfirmation && !confirmed {
        return Ok(AddRootResult {
            status: "needsConfirmation",
            message: Some(format!(
                "'{display}' is a very broad location. Protected and sensitive folders will still be skipped, but scanning may take a long time. Continue?"
            )),
            root_id: None,
        });
    }
    let norm = security::normalize_for_compare(&display);
    let existing = state.with_conn(|c| db::list_roots(c))?;
    for r in &existing {
        let other = security::normalize_for_compare(&r.path);
        if other == norm {
            return Ok(AddRootResult { status: "exists", message: None, root_id: Some(r.id) });
        }
        if security::is_within(&norm, &other) || security::is_within(&other, &norm) {
            return Err(format!("'{display}' overlaps the existing scan folder '{}'. Remove it first.", r.path));
        }
    }
    let id = state.with_conn(|c| db::add_root(c, &display, now_ms()))?;
    Ok(AddRootResult { status: "added", message: None, root_id: Some(id) })
}

#[tauri::command]
async fn remove_root(state: State<'_, AppState>, root_id: i64) -> CmdResult<()> {
    if let Some(active) = state.scan.lock().unwrap().as_ref() {
        if active.root_ids.contains(&root_id) {
            return Err("This folder is being scanned. Cancel the scan first.".into());
        }
    }
    state.with_conn(|c| db::remove_root(c, root_id))
}

#[tauri::command]
async fn start_scan(app: tauri::AppHandle, state: State<'_, AppState>, root_ids: Vec<i64>) -> CmdResult<()> {
    let mut guard = state.scan.lock().unwrap();
    if guard.is_some() {
        return Err("A scan is already running.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *guard = Some(ActiveScan { cancel: cancel.clone(), root_ids: root_ids.clone() });
    drop(guard);

    let db_path = state.db_path.clone();
    let policy = ScanPolicy::new(&state.settings.read().unwrap());
    let scan_slot = state.scan.clone();
    std::thread::Builder::new()
        .name("scanner".into())
        .spawn(move || {
            let run = || -> Result<(), String> {
                let mut conn = db::open(&db_path).map_err(|e| e.to_string())?;
                for root_id in root_ids {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let Some(path) = db::root_path(&conn, root_id).map_err(|e| e.to_string())? else { continue };
                    let _ = db::set_root_status(&conn, root_id, "scanning", None, None);
                    let result = scanner::scan_root(&mut conn, root_id, &path, &policy, &cancel, |p| {
                        let _ = app.emit("scan-progress", p);
                    });
                    match result {
                        Ok(outcome) => {
                            if outcome.status == "cancelled" {
                                let _ = db::set_root_status(&conn, root_id, "cancelled", Some("Scan cancelled; previous index kept."), None);
                            }
                            let _ = app.emit("scan-finished", &outcome);
                        }
                        Err(e) => {
                            let msg = format!("Scan failed: {e}");
                            let _ = db::set_root_status(&conn, root_id, "failed", Some(&msg), None);
                            let _ = app.emit("scan-error", serde_json::json!({ "rootId": root_id, "message": msg }));
                        }
                    }
                }
                Ok(())
            };
            if let Err(e) = run() {
                let _ = app.emit("scan-error", serde_json::json!({ "rootId": null, "message": e }));
            }
            *scan_slot.lock().unwrap() = None;
            let _ = app.emit("scan-idle", ());
        })
        .map_err(|e| {
            *state.scan.lock().unwrap() = None;
            e.to_string()
        })?;
    Ok(())
}

#[tauri::command]
async fn cancel_scan(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(active) = state.scan.lock().unwrap().as_ref() {
        active.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn is_scanning(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(state.scan.lock().unwrap().is_some())
}

#[tauri::command]
async fn list_children(state: State<'_, AppState>, parent_id: i64, offset: i64, limit: i64) -> CmdResult<db::ChildPage> {
    let hidden = state.hidden();
    state.with_conn(|c| db::list_children(c, parent_id, offset.max(0), limit.clamp(1, 500), &hidden))
}

#[tauri::command]
async fn get_entry(state: State<'_, AppState>, id: i64) -> CmdResult<db::Entry> {
    state.entry(id)
}

#[tauri::command]
async fn locate(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<db::LocateStep>> {
    let hidden = state.hidden();
    state
        .with_conn(|c| db::locate(c, id, &hidden))?
        .ok_or_else(|| "Item is not in the index or is hidden by your security settings.".into())
}

#[tauri::command]
async fn locate_path(state: State<'_, AppState>, path: String) -> CmdResult<Option<Vec<db::LocateStep>>> {
    let hidden = state.hidden();
    state.with_conn(|c| match db::find_by_path(c, &path)? {
        Some(id) => db::locate(c, id, &hidden),
        None => Ok(None),
    })
}

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String, limit: i64) -> CmdResult<Vec<db::Entry>> {
    let hidden = state.hidden();
    state.with_conn(|c| db::search(c, &query, limit.clamp(1, 1000), &hidden))
}

#[tauri::command]
async fn index_stats(state: State<'_, AppState>) -> CmdResult<db::IndexStats> {
    state.with_conn(|c| db::stats(c))
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> CmdResult<SecuritySettings> {
    Ok(state.settings.read().unwrap().clone())
}

#[tauri::command]
async fn set_settings(state: State<'_, AppState>, settings: SecuritySettings) -> CmdResult<SecuritySettings> {
    settings::save(&state.settings_path, &settings)?;
    *state.settings.write().unwrap() = settings.clone();
    Ok(settings)
}

#[tauri::command]
async fn reveal_in_explorer(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    actions::reveal(&state.entry(id)?)
}

#[tauri::command]
async fn open_containing_folder(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    actions::open_containing_folder(&state.entry(id)?)
}

/// `confirmed` must come from an explicit confirmation dialog in the UI.
#[tauri::command]
async fn open_file(state: State<'_, AppState>, id: i64, confirmed: bool) -> CmdResult<()> {
    if !confirmed {
        return Err("Opening a file requires explicit confirmation.".into());
    }
    // `entry` refuses items whose category is hidden, so a program can only
    // run if its category is visible *and* launching is allowed.
    let entry = state.entry(id)?;
    let allow_launch = state.settings.read().unwrap().allow_launch;
    actions::open_with_default_app(&entry, allow_launch, &state.launch_log())
}

impl AppState {
    fn launch_log(&self) -> PathBuf {
        self.settings_path.with_file_name("launch-log.tsv")
    }
}

/// Text of a file for the code viewer; needs "Allow reading file contents".
#[tauri::command]
async fn read_text_file(state: State<'_, AppState>, id: i64) -> CmdResult<actions::TextFile> {
    if !state.settings.read().unwrap().allow_read_contents {
        return Err("Reading file contents is turned off. Enable it in Security settings.".into());
    }
    actions::read_text(&state.entry(id)?)
}

fn terminal_dir(state: &AppState, id: i64, confirmed: bool) -> CmdResult<db::Entry> {
    if !state.settings.read().unwrap().allow_terminal {
        return Err("The terminal is turned off. Enable it in Security settings.".into());
    }
    if !confirmed {
        return Err("Opening a terminal requires explicit confirmation.".into());
    }
    let entry = state.entry(id)?;
    actions::existing_dir(&entry)?;
    Ok(entry)
}

/// Starts a PowerShell / CMD session in an indexed folder. `confirmed` must
/// come from a confirmation dialog in the UI.
#[tauri::command]
async fn terminal_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    terms: State<'_, terminal::Terminals>,
    id: i64,
    shell: terminal::Shell,
    confirmed: bool,
) -> CmdResult<u32> {
    let dir = terminal_dir(&state, id, confirmed)?;
    actions::log_event(&state.launch_log(), &format!("terminal-{}", if shell == terminal::Shell::Cmd { "cmd" } else { "powershell" }), &dir.path);
    terms.start(&app, std::path::Path::new(&dir.path), shell)
}

#[tauri::command]
async fn terminal_write(state: State<'_, AppState>, terms: State<'_, terminal::Terminals>, session: u32, line: String) -> CmdResult<()> {
    if !state.settings.read().unwrap().allow_terminal {
        return Err("The terminal is turned off. Enable it in Security settings.".into());
    }
    if !line.trim().is_empty() {
        actions::log_event(&state.launch_log(), "command", &line);
    }
    terms.write(session, &line)
}

#[tauri::command]
async fn terminal_stop(terms: State<'_, terminal::Terminals>, session: u32) -> CmdResult<()> {
    terms.stop(session);
    Ok(())
}

#[tauri::command]
async fn open_external_terminal(state: State<'_, AppState>, id: i64, shell: terminal::Shell, confirmed: bool) -> CmdResult<()> {
    let dir = terminal_dir(&state, id, confirmed)?;
    actions::log_event(&state.launch_log(), "terminal-window", &dir.path);
    terminal::open_external(std::path::Path::new(&dir.path), shell)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // A second launch (e.g. from the Start menu while the autostarted
        // wallpaper runs) just brings the explorer up in the first instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if app.state::<desktop::DesktopState>().mode() == desktop::Mode::Window {
                desktop::request_mode(app, desktop::Mode::Window);
            } else {
                desktop::request_mode(app, desktop::Mode::Overlay);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![desktop::WALLPAPER_ARG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        desktop::toggle_explore(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("index.sqlite3");
            let settings_path = dir.join("security-settings.json");
            let conn = db::open(&db_path)?;
            // A scan interrupted by a crash or shutdown left its transaction
            // rolled back; reflect that in the status.
            conn.execute("UPDATE roots SET status = 'cancelled' WHERE status = 'scanning'", [])?;
            app.manage(AppState {
                db_path,
                settings: RwLock::new(settings::load(&settings_path)),
                settings_path,
                conn: Mutex::new(conn),
                scan: Arc::new(Mutex::new(None)),
            });

            app.manage(terminal::Terminals::default());
            app.manage(desktop::DesktopState::new(dir.join("desktop-prefs.json")));
            let handle = app.handle().clone();
            let hotkey = app.state::<desktop::DesktopState>().hotkey();
            if let Err(e) = desktop::register_hotkey(&handle, &hotkey) {
                eprintln!("{e}");
            }
            desktop::build_tray(&handle)?;
            desktop::start_watchdog(handle.clone());
            if app.state::<desktop::DesktopState>().music_sync() {
                app.state::<desktop::DesktopState>().set_music_running(&handle, true);
            }
            let start_as_wallpaper = std::env::args().any(|a| a == desktop::WALLPAPER_ARG);
            desktop::request_mode(&handle, if start_as_wallpaper { desktop::Mode::Wallpaper } else { desktop::Mode::Window });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_roots,
            add_root,
            remove_root,
            start_scan,
            cancel_scan,
            is_scanning,
            list_children,
            get_entry,
            locate,
            locate_path,
            search,
            index_stats,
            get_settings,
            set_settings,
            reveal_in_explorer,
            open_containing_folder,
            open_file,
            read_text_file,
            terminal_start,
            terminal_write,
            terminal_stop,
            open_external_terminal,
            desktop::get_desktop_info,
            desktop::set_desktop_mode,
            desktop::set_hotkey,
            desktop::set_idle_return,
            desktop::set_wallpaper_style,
            desktop::set_music_sync,
            desktop::set_music_intensity,
            desktop::set_autostart
        ])
        .build(tauri::generate_context!())
        .expect("error while building Globe File Explorer");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<terminal::Terminals>().stop_all();
        }
        // If Explorer destroys the wallpaper window, keep running so the
        // watchdog can recreate it; the tray "Quit" exits explicitly.
        if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
            if app.state::<desktop::DesktopState>().mode() != desktop::Mode::Window {
                api.prevent_exit();
            }
        }
    });
}
