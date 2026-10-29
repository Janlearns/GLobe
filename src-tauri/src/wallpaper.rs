//! Win32 desktop-layer integration.
//!
//! A real wallpaper window has to live *behind the desktop icons*, which a
//! normal (or always-on-bottom) window cannot do. The usual technique is used:
//! sending the undocumented 0x052C message to `Progman` makes Explorer create a
//! `WorkerW` window between the icons (`SHELLDLL_DefView`) and the wallpaper,
//! and our window is re-parented into that layer.
//!
//! * Windows 10 / Windows 11 before 24H2: the `WorkerW` is a top-level window
//!   that follows the one hosting `SHELLDLL_DefView`; we become its child.
//! * Windows 11 24H2+: `SHELLDLL_DefView` and `WorkerW` are children of
//!   `Progman`; we become a child of `Progman`, ordered between the icons and
//!   the `WorkerW`.
//!
//! Behind the icons the desktop receives every click, so there is also an
//! *interactive* style: a borderless top-level window pinned directly above
//! the desktop (covering the icons) and below every other window. A window
//! subclass rewrites `WM_WINDOWPOSCHANGING` so activating it never raises it.

#![cfg(windows)]

use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::MapWindowPoints;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn find(parent: HWND, after: HWND, class: &str) -> HWND {
    let c = wide(class);
    FindWindowExW(parent, after, c.as_ptr(), null())
}

#[derive(Clone, Copy, Debug)]
pub enum Host {
    /// Pre-24H2: child of this top-level WorkerW.
    WorkerW(isize),
    /// 24H2+: child of Progman, between `defview` and `workerw`.
    Progman { progman: isize, defview: isize, workerw: isize },
}

impl Host {
    pub fn parent(&self) -> HWND {
        match *self {
            Host::WorkerW(w) => w as HWND,
            Host::Progman { progman, .. } => progman as HWND,
        }
    }
}

unsafe extern "system" fn find_legacy_worker(top: HWND, lparam: LPARAM) -> i32 {
    if !find(top, null_mut(), "SHELLDLL_DefView").is_null() {
        let w = find(null_mut(), top, "WorkerW");
        if !w.is_null() {
            *(lparam as *mut HWND) = w;
            return 0;
        }
    }
    1
}

/// Locates (creating if needed) the desktop layer behind the icons.
pub fn desktop_host() -> Option<Host> {
    unsafe {
        let progman = FindWindowW(wide("Progman").as_ptr(), null());
        if progman.is_null() {
            return None;
        }
        let mut result = 0usize;
        SendMessageTimeoutW(progman, 0x052C, 0xD, 0, SMTO_NORMAL, 1000, &mut result);
        SendMessageTimeoutW(progman, 0x052C, 0xD, 1, SMTO_NORMAL, 1000, &mut result);

        // Windows 11 24H2+ layout.
        let inner_worker = find(progman, null_mut(), "WorkerW");
        let inner_defview = find(progman, null_mut(), "SHELLDLL_DefView");
        if !inner_worker.is_null() && !inner_defview.is_null() {
            return Some(Host::Progman {
                progman: progman as isize,
                defview: inner_defview as isize,
                workerw: inner_worker as isize,
            });
        }
        // Classic layout.
        let mut worker: HWND = null_mut();
        EnumWindows(Some(find_legacy_worker), &mut worker as *mut HWND as LPARAM);
        if !worker.is_null() {
            return Some(Host::WorkerW(worker as isize));
        }
        None
    }
}

/// Primary monitor rectangle in screen coordinates.
pub fn primary_monitor_rect() -> RECT {
    unsafe { RECT { left: 0, top: 0, right: GetSystemMetrics(SM_CXSCREEN), bottom: GetSystemMetrics(SM_CYSCREEN) } }
}

/// Primary monitor minus the taskbar (and other app bars), in screen
/// coordinates. Windows treats a window covering the whole monitor as a
/// full-screen app and hides the taskbar, so the clickable modes use this.
pub fn work_area() -> RECT {
    unsafe {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut RECT as *mut _, 0) == 0 || r.right <= r.left || r.bottom <= r.top {
            return primary_monitor_rect();
        }
        r
    }
}

fn fit_to_work_area(hwnd: HWND) {
    let r = work_area();
    unsafe {
        SetWindowPos(hwnd, null_mut(), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

#[derive(Clone, Copy)]
pub struct SavedWindow {
    style: isize,
    ex_style: isize,
    rect: RECT,
}

pub fn save(hwnd: HWND) -> SavedWindow {
    unsafe {
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        GetWindowRect(hwnd, &mut rect);
        SavedWindow { style: GetWindowLongPtrW(hwnd, GWL_STYLE), ex_style: GetWindowLongPtrW(hwnd, GWL_EXSTYLE), rect }
    }
}

/// Re-parents `hwnd` into the desktop layer, covering the primary monitor.
pub fn attach(hwnd: HWND, host: Host) -> Result<(), String> {
    unpin();
    unsafe {
        let parent = host.parent();
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let child_style = (style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX))
            | WS_CHILD
            | WS_VISIBLE;
        SetWindowLongPtrW(hwnd, GWL_STYLE, child_style as isize);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ((ex & !(WS_EX_APPWINDOW | WS_EX_TOPMOST)) | WS_EX_TOOLWINDOW) as isize);
        if SetParent(hwnd, parent).is_null() {
            return Err("Windows refused to place the globe on the desktop layer.".into());
        }
        // Monitor rect in the parent's client coordinates (the desktop layer
        // spans the whole virtual screen, whose origin may be negative).
        let r = primary_monitor_rect();
        let mut pts = [POINT { x: r.left, y: r.top }, POINT { x: r.right, y: r.bottom }];
        MapWindowPoints(null_mut(), parent, pts.as_mut_ptr(), 2);
        let (x, y, w, h) = (pts[0].x, pts[0].y, pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        match host {
            Host::Progman { defview, workerw, .. } => {
                // Below the icons, above Explorer's own wallpaper WorkerW.
                SetWindowPos(hwnd, defview as HWND, x, y, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
                SetWindowPos(workerw as HWND, hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            Host::WorkerW(_) => {
                SetWindowPos(hwnd, HWND_TOP, x, y, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            }
        }
        Ok(())
    }
}

static PIN_TO_DESKTOP: AtomicBool = AtomicBool::new(false);
static OVERLAY: AtomicBool = AtomicBool::new(false);
static SUBCLASSED: AtomicIsize = AtomicIsize::new(0);
const SUBCLASS_ID: usize = 0x474C_4F42; // "GLOB"

unsafe extern "system" fn find_icons_host(top: HWND, lparam: LPARAM) -> i32 {
    if !find(top, null_mut(), "SHELLDLL_DefView").is_null() {
        *(lparam as *mut HWND) = top;
        return 0;
    }
    1
}

/// Top-level window that hosts the desktop icons (`Progman` or a `WorkerW`).
fn icons_host() -> HWND {
    unsafe {
        let mut found: HWND = null_mut();
        EnumWindows(Some(find_icons_host), &mut found as *mut HWND as LPARAM);
        if found.is_null() {
            FindWindowW(wide("Progman").as_ptr(), null())
        } else {
            found
        }
    }
}

/// Keeps the window directly above the desktop icons whenever anything
/// (including a click that activates it) tries to change its z-order.
unsafe extern "system" fn pin_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    // The taskbar moved / resized or the resolution changed: follow the work area.
    let bars_changed = (msg == WM_SETTINGCHANGE && wparam as u32 == SPI_SETWORKAREA) || msg == WM_DISPLAYCHANGE;
    if bars_changed && (PIN_TO_DESKTOP.load(Ordering::Relaxed) || OVERLAY.load(Ordering::Relaxed)) {
        fit_to_work_area(hwnd);
    }
    if msg == WM_WINDOWPOSCHANGING && PIN_TO_DESKTOP.load(Ordering::Relaxed) {
        let wp = &mut *(lparam as *mut WINDOWPOS);
        if wp.flags & SWP_NOZORDER == 0 {
            let host = icons_host();
            let above = if host.is_null() { null_mut() } else { GetWindow(host, GW_HWNDPREV) };
            if above.is_null() || above == hwnd {
                wp.flags |= SWP_NOZORDER;
            } else {
                wp.hwndInsertAfter = above;
            }
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn ensure_subclassed(hwnd: HWND) {
    if SUBCLASSED.swap(hwnd as isize, Ordering::Relaxed) != hwnd as isize {
        unsafe {
            SetWindowSubclass(hwnd, Some(pin_proc), SUBCLASS_ID, 0);
        }
    }
}

/// Interactive wallpaper: the primary monitor's work area (the taskbar stays
/// visible), above the desktop icons and below every other window, fully
/// clickable.
pub fn attach_interactive(hwnd: HWND) {
    ensure_subclassed(hwnd);
    OVERLAY.store(false, Ordering::Relaxed);
    unsafe {
        PIN_TO_DESKTOP.store(false, Ordering::Relaxed);
        SetParent(hwnd, null_mut());
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let popup = (style & !(WS_CHILD | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX))
            | WS_POPUP
            | WS_VISIBLE;
        SetWindowLongPtrW(hwnd, GWL_STYLE, popup as isize);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ((ex & !(WS_EX_APPWINDOW | WS_EX_TOPMOST)) | WS_EX_TOOLWINDOW) as isize);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        PIN_TO_DESKTOP.store(true, Ordering::Relaxed);
        let r = work_area();
        SetWindowPos(
            hwnd,
            HWND_BOTTOM, // rewritten by `pin_proc` to "just above the icons"
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        );
    }
}

/// Stops pinning the window to the desktop layer.
pub fn unpin() {
    PIN_TO_DESKTOP.store(false, Ordering::Relaxed);
    OVERLAY.store(false, Ordering::Relaxed);
}

/// Detaches into a borderless, top-most window over the primary monitor's
/// work area (the interactive overlay used while in wallpaper mode); the
/// taskbar stays visible.
pub fn detach_overlay(hwnd: HWND) {
    unpin();
    ensure_subclassed(hwnd);
    OVERLAY.store(true, Ordering::Relaxed);
    unsafe {
        SetParent(hwnd, null_mut());
        let style = (GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & !WS_CHILD) | WS_POPUP | WS_VISIBLE;
        SetWindowLongPtrW(hwnd, GWL_STYLE, style as isize);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ((ex & !WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW) as isize);
        let r = work_area();
        SetWindowPos(hwnd, HWND_TOPMOST, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        SetForegroundWindow(hwnd);
    }
}

/// Restores a normal top-level window with the styles saved earlier.
pub fn restore(hwnd: HWND, saved: SavedWindow) {
    unpin();
    unsafe {
        SetParent(hwnd, null_mut());
        SetWindowLongPtrW(hwnd, GWL_STYLE, saved.style);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, saved.ex_style);
        let r = saved.rect;
        SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        );
        SetForegroundWindow(hwnd);
    }
}

pub fn parent_of(hwnd: HWND) -> HWND {
    unsafe { GetParent(hwnd) }
}

pub fn is_window(hwnd: HWND) -> bool {
    unsafe { IsWindow(hwnd) != 0 }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// True when another application covers the primary monitor (maximized or
/// full screen), so the wallpaper can stop rendering.
pub fn wallpaper_covered(own: HWND) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() || fg == own {
            return false;
        }
        let class = class_name(fg);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return false;
        }
        if IsIconic(fg) != 0 {
            return false;
        }
        if IsZoomed(fg) != 0 {
            return true;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        GetWindowRect(fg, &mut r);
        let m = primary_monitor_rect();
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}
