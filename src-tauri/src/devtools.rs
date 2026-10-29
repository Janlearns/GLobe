//! Developer helpers used by `examples/index_folder.rs` to exercise the real
//! scanner and index without the UI.

use crate::{db, scanner, security};
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// Adds `folder` as a scan root in the database at `db_path` and scans it with
/// the default security policy. Returns (files, dirs, skipped, errors).
pub fn index_folder(db_path: &Path, folder: &str) -> Result<(u64, u64, u64, u64), String> {
    let root = security::canonical_root(folder)?;
    let policy = security::ScanPolicy::new(&security::SecuritySettings::default());
    policy.check_root(&root)?;
    let display = security::display_path(&root);
    let mut conn = db::open(db_path).map_err(|e| e.to_string())?;
    let id = db::add_root(&conn, &display, 0).map_err(|e| e.to_string())?;
    let out = scanner::scan_root(&mut conn, id, &display, &policy, &AtomicBool::new(false), |_| {})
        .map_err(|e| e.to_string())?;
    let p = out.progress;
    Ok((p.files, p.dirs, p.skipped, p.errors))
}

/// Opens the system-audio loopback for a few seconds; returns (sample rate, peak RMS).
pub fn probe_audio(secs: u64) -> Result<(u32, f32), String> {
    crate::audio::probe(secs)
}

/// Current media session as (title, artist, source app, playing), if any.
pub fn probe_now_playing() -> Option<(String, String, String, bool)> {
    crate::audio::probe_now_playing().map(|n| (n.title, n.artist, n.source, n.playing))
}
