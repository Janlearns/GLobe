//! Desktop integration: window / wallpaper / overlay modes, tray icon, global
//! hotkey, start-at-login and the wallpaper watchdog.
//!
//! Modes:
//! * `Window`    – normal application window.
//! * `Wallpaper` – attached to the desktop layer behind the icons. It cannot
//!                 receive mouse input there (the icons sit on top), so
//!                 interaction goes through the hotkey / tray.
//! * `Overlay`   – the same window lifted out of the desktop as a borderless
//!                 full-screen explorer; it returns to `Wallpaper` via the
//!                 hotkey, Esc, or after a period of inactivity.

use crate::wallpaper::{self, SavedWindow};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use windows_sys::Win32::Foundation::HWND;

pub const WALLPAPER_ARG: &str = "--wallpaper";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Window,
    Wallpaper,
    Overlay,
}

/// How the wallpaper sits on the desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperStyle {
    /// Directly above the desktop (covering the icons), below every other
    /// window, and fully clickable.
    Interactive,
    /// Behind the desktop icons like a real wallpaper; the icons keep the mouse.
    BehindIcons,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPrefs {
    pub hotkey: String,
    /// Seconds of inactivity after which the overlay returns to wallpaper.
    pub idle_return_secs: u32,
    pub wallpaper_style: WallpaperStyle,
    /// Animate the scene with whatever the PC is playing. Off by default.
    pub music_sync: bool,
    /// 0..1 strength of the music-driven effects.
    pub music_intensity: f32,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            hotkey: "CommandOrControl+Alt+G".into(),
            idle_return_secs: 90,
            wallpaper_style: WallpaperStyle::Interactive,
            music_sync: false,
            music_intensity: 0.7,
        }
    }
}

pub struct DesktopState {
    mode: Mutex<Mode>,
    saved: Mutex<Option<SavedWindow>>,
    prefs: Mutex<DesktopPrefs>,
    prefs_path: PathBuf,
    covered: AtomicBool,
    audio: Mutex<Option<crate::audio::AudioHandle>>,
}

impl DesktopState {
    pub fn new(prefs_path: PathBuf) -> Self {
        let prefs = std::fs::read_to_string(&prefs_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            mode: Mutex::new(Mode::Window),
            saved: Mutex::new(None),
            prefs: Mutex::new(prefs),
            prefs_path,
            covered: AtomicBool::new(false),
            audio: Mutex::new(None),
        }
    }

    pub fn mode(&self) -> Mode {
        *self.mode.lock().unwrap()
    }

    pub fn hotkey(&self) -> String {
        self.prefs.lock().unwrap().hotkey.clone()
    }

    pub fn music_sync(&self) -> bool {
        self.prefs.lock().unwrap().music_sync
    }

    /// Starts or stops the music analysis threads.
    pub fn set_music_running(&self, app: &AppHandle, on: bool) {
        let mut audio = self.audio.lock().unwrap();
        if let Some(h) = audio.take() {
            h.stop();
        }
        if on {
            *audio = Some(crate::audio::start(app.clone()));
        }
    }

    fn style(&self) -> WallpaperStyle {
        self.prefs.lock().unwrap().wallpaper_style
    }

    fn save_prefs(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&*self.prefs.lock().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&self.prefs_path, json).map_err(|e| e.to_string())
    }
}

fn main_hwnd(app: &AppHandle) -> Option<HWND> {
    app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as HWND)
}

/// Recreates the main window if Explorer took it down (e.g. Explorer restart
/// destroys every child of the old desktop layer).
fn ensure_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let cfg = app.config().app.windows.first().cloned().ok_or("missing window config")?;
    WebviewWindowBuilder::from_config(app, &cfg).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
    *app.state::<DesktopState>().mode.lock().unwrap() = Mode::Window;
    Ok(())
}

/// Must run on the main (UI) thread.
fn apply_mode(app: &AppHandle, target: Mode) -> Result<(), String> {
    ensure_window(app)?;
    let st = app.state::<DesktopState>();
    let win = app.get_webview_window("main").ok_or("main window missing")?;
    let hwnd = main_hwnd(app).ok_or("main window handle unavailable")?;
    let current = st.mode();

    if current == Mode::Window {
        // Remember the normal window placement before leaving it.
        if target != Mode::Window {
            *st.saved.lock().unwrap() = Some(wallpaper::save(hwnd));
        }
    }
    match target {
        Mode::Wallpaper => {
            let _ = win.show();
            match st.style() {
                WallpaperStyle::Interactive => wallpaper::attach_interactive(hwnd),
                WallpaperStyle::BehindIcons => {
                    let host = wallpaper::desktop_host().ok_or(
                        "Could not find the Windows desktop layer (is Explorer running?). Staying in window mode.",
                    )?;
                    wallpaper::attach(hwnd, host)?;
                }
            }
        }
        Mode::Overlay => {
            let _ = win.show();
            wallpaper::detach_overlay(hwnd);
            let _ = win.set_focus();
        }
        Mode::Window => {
            if current != Mode::Window {
                if let Some(saved) = st.saved.lock().unwrap().take() {
                    wallpaper::restore(hwnd, saved);
                }
            }
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
    *st.mode.lock().unwrap() = target;
    st.covered.store(false, Ordering::Relaxed);
    let _ = app.emit("desktop-mode", target);
    Ok(())
}

/// Queues a mode change on the UI thread (safe to call from any thread,
/// including tray and hotkey handlers that already run on it).
pub fn request_mode(app: &AppHandle, target: Mode) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = apply_mode(&handle, target) {
            let _ = handle.emit("desktop-error", e);
        }
    });
}

/// Hotkey / tray-click behaviour.
pub fn toggle_explore(app: &AppHandle) {
    let mode = app.state::<DesktopState>().mode();
    request_mode(
        app,
        match mode {
            Mode::Wallpaper => Mode::Overlay,
            Mode::Overlay => Mode::Wallpaper,
            Mode::Window => Mode::Window,
        },
    );
}

pub fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(hotkey).map_err(|e| format!("Could not register hotkey '{hotkey}': {e}"))
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let hotkey = app.state::<DesktopState>().prefs.lock().unwrap().hotkey.replace("CommandOrControl", "Ctrl");
    let explore = MenuItem::with_id(app, "explore", format!("Explore globe\t{hotkey}"), true, None::<&str>)?;
    let wallpaper = MenuItem::with_id(app, "wallpaper", "Wallpaper mode", true, None::<&str>)?;
    let window = MenuItem::with_id(app, "window", "Window mode", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Globe File Explorer", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&explore, &wallpaper, &window, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Globe File Explorer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "explore" => {
                if app.state::<DesktopState>().mode() == Mode::Window {
                    request_mode(app, Mode::Window);
                } else {
                    request_mode(app, Mode::Overlay);
                }
            }
            "wallpaper" => request_mode(app, Mode::Wallpaper),
            "window" => request_mode(app, Mode::Window),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                if app.state::<DesktopState>().mode() == Mode::Window {
                    request_mode(app, Mode::Window);
                } else {
                    toggle_explore(app);
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Keeps the wallpaper attached (Explorer restarts, display changes) and
/// reports when a maximized/full-screen app hides it so rendering can pause.
pub fn start_watchdog(app: AppHandle) {
    std::thread::Builder::new()
        .name("wallpaper-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(1500));
            let st = app.state::<DesktopState>();
            if st.mode() != Mode::Wallpaper {
                continue;
            }
            let Some(hwnd) = main_hwnd(&app) else {
                // Window was destroyed together with the old desktop layer.
                request_mode(&app, Mode::Wallpaper);
                continue;
            };
            if st.style() == WallpaperStyle::BehindIcons {
                let parent = wallpaper::parent_of(hwnd);
                if parent.is_null() || !wallpaper::is_window(parent) {
                    request_mode(&app, Mode::Wallpaper);
                    continue;
                }
            }
            let covered = wallpaper::wallpaper_covered(hwnd);
            if st.covered.swap(covered, Ordering::Relaxed) != covered {
                let _ = app.emit("wallpaper-covered", covered);
            }
        })
        .expect("failed to start wallpaper watchdog");
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    mode: Mode,
    hotkey: String,
    idle_return_secs: u32,
    wallpaper_style: WallpaperStyle,
    music_sync: bool,
    music_intensity: f32,
    autostart: bool,
    dev_build: bool,
    covered: bool,
}

#[tauri::command]
pub async fn get_desktop_info(app: AppHandle) -> Result<DesktopInfo, String> {
    let st = app.state::<DesktopState>();
    let prefs = st.prefs.lock().unwrap().clone();
    Ok(DesktopInfo {
        mode: st.mode(),
        hotkey: prefs.hotkey,
        idle_return_secs: prefs.idle_return_secs,
        wallpaper_style: prefs.wallpaper_style,
        music_sync: prefs.music_sync,
        music_intensity: prefs.music_intensity,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        dev_build: cfg!(debug_assertions),
        covered: st.covered.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub async fn set_desktop_mode(app: AppHandle, mode: Mode) -> Result<(), String> {
    request_mode(&app, mode);
    Ok(())
}

#[tauri::command]
pub async fn set_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    let st = app.state::<DesktopState>();
    let old = st.prefs.lock().unwrap().hotkey.clone();
    if let Err(e) = register_hotkey(&app, hotkey.trim()) {
        let _ = register_hotkey(&app, &old);
        return Err(e);
    }
    st.prefs.lock().unwrap().hotkey = hotkey.trim().to_string();
    st.save_prefs()
}

#[tauri::command]
pub async fn set_idle_return(app: AppHandle, secs: u32) -> Result<(), String> {
    let st = app.state::<DesktopState>();
    st.prefs.lock().unwrap().idle_return_secs = secs.clamp(15, 3600);
    st.save_prefs()
}

/// Music sync listens to the system audio output (loopback) for visuals only.
#[tauri::command]
pub async fn set_music_sync(app: AppHandle, enabled: bool) -> Result<(), String> {
    let st = app.state::<DesktopState>();
    st.prefs.lock().unwrap().music_sync = enabled;
    st.save_prefs()?;
    st.set_music_running(&app, enabled);
    Ok(())
}

#[tauri::command]
pub async fn set_music_intensity(app: AppHandle, intensity: f32) -> Result<(), String> {
    let st = app.state::<DesktopState>();
    st.prefs.lock().unwrap().music_intensity = intensity.clamp(0.0, 1.0);
    st.save_prefs()
}

#[tauri::command]
pub async fn set_wallpaper_style(app: AppHandle, style: WallpaperStyle) -> Result<(), String> {
    let st = app.state::<DesktopState>();
    st.prefs.lock().unwrap().wallpaper_style = style;
    st.save_prefs()?;
    if st.mode() == Mode::Wallpaper {
        request_mode(&app, Mode::Window);
        request_mode(&app, Mode::Wallpaper);
    }
    Ok(())
}

/// Start at sign-in directly in wallpaper mode (HKCU Run entry; no admin rights).
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}
