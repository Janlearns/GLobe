//! Read-only metadata scanner.
//!
//! * Only directory listings and metadata are read; no file is opened.
//! * Symlinks and junctions are recorded but never followed.
//! * Protected/hidden OS files and sensitive locations are skipped.
//! * The whole rescan of a root runs in a single write transaction, so the UI
//!   keeps querying the previous index until the new one is committed, and a
//!   cancelled scan leaves the previous index untouched.

use crate::db::{self, KIND_DIR, KIND_FILE, KIND_LINK};
use crate::security::{classify_extension, extension_of, Category, ScanPolicy};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
const MAX_DEPTH: i64 = 96;
const MAX_REPORTED_ERRORS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub root_id: i64,
    pub root_path: String,
    pub phase: &'static str,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub skipped: u64,
    pub links: u64,
    pub errors: u64,
    pub current: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutcome {
    pub progress: ScanProgress,
    pub status: &'static str,
    pub error_samples: Vec<String>,
}

struct DirAcc {
    id: i64,
    parent: Option<usize>,
    size: i64,
    files: i64,
    dirs: i64,
}

fn to_millis(t: std::io::Result<SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[cfg(windows)]
fn attributes(md: &std::fs::Metadata) -> u32 {
    md.file_attributes()
}
#[cfg(not(windows))]
fn attributes(_md: &std::fs::Metadata) -> u32 {
    0
}

/// Scans `root_path` into the index for `root_id`. `on_progress` is called
/// periodically from the scanning thread.
pub fn scan_root(
    conn: &mut Connection,
    root_id: i64,
    root_path: &str,
    policy: &ScanPolicy,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&ScanProgress),
) -> rusqlite::Result<ScanOutcome> {
    let started = Instant::now();
    let mut progress = ScanProgress {
        root_id,
        root_path: root_path.to_string(),
        phase: "scanning",
        files: 0,
        dirs: 0,
        bytes: 0,
        skipped: 0,
        links: 0,
        errors: 0,
        current: root_path.to_string(),
        elapsed_ms: 0,
    };
    let mut error_samples = Vec::new();
    let mut last_emit = Instant::now();
    on_progress(&progress);

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM entries WHERE root_id = ?1", [root_id])?;

    let root = PathBuf::from(root_path);
    let root_md = std::fs::metadata(&root);
    let root_name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_path.to_string());
    let mut dirs: Vec<DirAcc> = Vec::new();
    let mut stack: Vec<(PathBuf, usize, i64)> = Vec::new();
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO entries(root_id, parent_id, name, name_lower, ext, kind, size, modified, created, category, depth, path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        let (m, c) = match &root_md {
            Ok(md) => (to_millis(md.modified()), to_millis(md.created())),
            Err(_) => (None, None),
        };
        insert.execute(params![
            root_id, None::<i64>, root_name, root_name.to_lowercase(), "", KIND_DIR, 0, m, c,
            Category::Folder.as_str(), 0, root_path
        ])?;
        dirs.push(DirAcc { id: tx.last_insert_rowid(), parent: None, size: 0, files: 0, dirs: 0 });
        stack.push((root.clone(), 0, 0));

        let mut since_check = 0u32;
        while let Some((dir_path, dir_idx, depth)) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let read = match std::fs::read_dir(&dir_path) {
                Ok(r) => r,
                Err(e) => {
                    progress.errors += 1;
                    if error_samples.len() < MAX_REPORTED_ERRORS {
                        error_samples.push(format!("{}: {e}", dir_path.display()));
                    }
                    continue;
                }
            };
            for item in read {
                since_check += 1;
                if since_check >= 2048 {
                    since_check = 0;
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                }
                let item = match item {
                    Ok(i) => i,
                    Err(e) => {
                        progress.errors += 1;
                        if error_samples.len() < MAX_REPORTED_ERRORS {
                            error_samples.push(format!("{}: {e}", dir_path.display()));
                        }
                        continue;
                    }
                };
                // On Windows this comes from the directory listing itself and
                // does not follow reparse points or open the file.
                let md = match item.metadata() {
                    Ok(m) => m,
                    Err(e) => {
                        progress.errors += 1;
                        if error_samples.len() < MAX_REPORTED_ERRORS {
                            error_samples.push(format!("{}: {e}", item.path().display()));
                        }
                        continue;
                    }
                };
                let attrs = attributes(&md);
                if attrs & FILE_ATTRIBUTE_HIDDEN != 0 && attrs & FILE_ATTRIBUTE_SYSTEM != 0 {
                    progress.skipped += 1; // protected operating system item
                    continue;
                }
                let name = item.file_name().to_string_lossy().into_owned();
                let path = item.path();
                let path_str = path.to_string_lossy().into_owned();
                let ft = md.file_type();
                let modified = to_millis(md.modified());
                let created = to_millis(md.created());
                let child_depth = depth + 1;

                if ft.is_symlink() {
                    // Symlinks and junctions: recorded, never followed.
                    if policy.is_excluded_file(&name) || policy.is_excluded_dir(&path, &name) {
                        progress.skipped += 1;
                        continue;
                    }
                    insert.execute(params![
                        root_id, dirs[dir_idx].id, name, name.to_lowercase(), extension_of(&name), KIND_LINK, 0,
                        modified, created, Category::Link.as_str(), child_depth, path_str
                    ])?;
                    progress.links += 1;
                } else if md.is_dir() {
                    if policy.is_excluded_dir(&path, &name) || child_depth > MAX_DEPTH {
                        progress.skipped += 1;
                        continue;
                    }
                    insert.execute(params![
                        root_id, dirs[dir_idx].id, name, name.to_lowercase(), "", KIND_DIR, 0,
                        modified, created, Category::Folder.as_str(), child_depth, path_str
                    ])?;
                    dirs.push(DirAcc { id: tx.last_insert_rowid(), parent: Some(dir_idx), size: 0, files: 0, dirs: 0 });
                    stack.push((path, dirs.len() - 1, child_depth));
                    progress.dirs += 1;
                } else {
                    if policy.is_excluded_file(&name) {
                        progress.skipped += 1;
                        continue;
                    }
                    let ext = extension_of(&name);
                    let category = classify_extension(&ext);
                    let size = md.len() as i64;
                    insert.execute(params![
                        root_id, dirs[dir_idx].id, name, name.to_lowercase(), ext, KIND_FILE, size,
                        modified, created, category.as_str(), child_depth, path_str
                    ])?;
                    dirs[dir_idx].size += size;
                    dirs[dir_idx].files += 1;
                    progress.files += 1;
                    progress.bytes += size as u64;
                }

                if last_emit.elapsed() >= Duration::from_millis(200) {
                    last_emit = Instant::now();
                    progress.current = dir_path.to_string_lossy().into_owned();
                    progress.elapsed_ms = started.elapsed().as_millis() as u64;
                    on_progress(&progress);
                }
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        drop(tx); // rollback: the previous index for this root is kept
        progress.phase = "cancelled";
        progress.elapsed_ms = started.elapsed().as_millis() as u64;
        on_progress(&progress);
        return Ok(ScanOutcome { progress, status: "cancelled", error_samples });
    }

    // Aggregate sizes bottom-up. Children are always pushed after their parent.
    progress.phase = "aggregating";
    on_progress(&progress);
    for i in (1..dirs.len()).rev() {
        let (size, files, sub) = (dirs[i].size, dirs[i].files, dirs[i].dirs + 1);
        if let Some(p) = dirs[i].parent {
            dirs[p].size += size;
            dirs[p].files += files;
            dirs[p].dirs += sub;
        }
    }
    {
        let mut upd = tx.prepare_cached("UPDATE entries SET size = ?2, file_count = ?3, dir_count = ?4 WHERE id = ?1")?;
        for d in &dirs {
            upd.execute(params![d.id, d.size, d.files, d.dirs])?;
        }
    }
    progress.phase = "committing";
    on_progress(&progress);
    tx.commit()?;
    db::set_root_status(
        conn,
        root_id,
        "ready",
        if progress.errors > 0 { Some("Some folders could not be read (see scan errors).") } else { None },
        Some(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)),
    )?;
    progress.phase = "done";
    progress.elapsed_ms = started.elapsed().as_millis() as u64;
    on_progress(&progress);
    Ok(ScanOutcome { progress, status: "done", error_samples })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::SecuritySettings;
    use std::fs;

    fn snapshot(dir: &std::path::Path) -> Vec<(String, u64, Option<SystemTime>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let e = e.unwrap();
                let md = fs::symlink_metadata(e.path()).unwrap();
                out.push((e.path().display().to_string(), md.len(), md.modified().ok()));
                if md.is_dir() {
                    stack.push(e.path());
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    #[test]
    fn scans_read_only_and_excludes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data");
        fs::create_dir_all(root.join("docs/deep")).unwrap();
        fs::create_dir_all(root.join(".ssh")).unwrap();
        fs::create_dir_all(root.join("AppData/Local")).unwrap();
        fs::write(root.join("docs/report.pdf"), vec![0u8; 1000]).unwrap();
        fs::write(root.join("docs/deep/notes.txt"), vec![0u8; 250]).unwrap();
        fs::write(root.join("setup.exe"), vec![0u8; 50]).unwrap();
        fs::write(root.join("server.pem"), b"secret").unwrap();
        fs::write(root.join(".ssh/id_rsa"), b"secret").unwrap();
        fs::write(root.join("AppData/Local/x.db"), b"x").unwrap();
        let before = snapshot(&root);

        let mut conn = db::open(&tmp.path().join("index.db")).unwrap();
        let root_str = root.display().to_string();
        let root_id = db::add_root(&conn, &root_str, 0).unwrap();
        let policy = ScanPolicy::with_protected(&SecuritySettings::default(), vec![]);
        let cancel = AtomicBool::new(false);
        let out = scan_root(&mut conn, root_id, &root_str, &policy, &cancel, |_| {}).unwrap();
        assert_eq!(out.status, "done");
        assert_eq!(out.progress.files, 3);
        assert_eq!(out.progress.dirs, 2);
        assert_eq!(before, snapshot(&root), "scanner must not modify anything");

        let roots = db::list_roots(&conn).unwrap();
        let root_entry = roots[0].entry.clone().unwrap();
        assert_eq!(root_entry.size, 1300);
        assert_eq!(root_entry.file_count, 3);

        let hidden = SecuritySettings::default().hidden_categories();
        let page = db::list_children(&conn, root_entry.id, 0, 10, &hidden).unwrap();
        let names: Vec<_> = page.items.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["docs"], "setup.exe hidden, secrets and excluded dirs absent");

        let res = db::search(&conn, "notes", 10, &hidden).unwrap();
        assert_eq!(res.len(), 1);
        assert!(res[0].path.ends_with("notes.txt"));
        assert!(db::search(&conn, "setup", 10, &hidden).unwrap().is_empty());
        assert_eq!(db::search(&conn, "setup", 10, &[]).unwrap().len(), 1);
        assert!(db::search(&conn, "id_rsa", 10, &[]).unwrap().is_empty());
        assert!(db::search(&conn, "x.db", 10, &[]).unwrap().is_empty());

        let chain = db::locate(&conn, res[0].id, &hidden).unwrap().unwrap();
        let chain_names: Vec<_> = chain.iter().map(|s| s.entry.name.as_str()).collect();
        assert_eq!(chain_names, vec!["data", "docs", "deep", "notes.txt"]);

        // A cancelled rescan keeps the previous index.
        cancel.store(true, Ordering::Relaxed);
        let out = scan_root(&mut conn, root_id, &root_str, &policy, &cancel, |_| {}).unwrap();
        assert_eq!(out.status, "cancelled");
        assert_eq!(db::search(&conn, "notes", 10, &hidden).unwrap().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"x").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .output()
            .unwrap();
        if !status.status.success() {
            return; // junction creation unavailable in this environment
        }
        let mut conn = db::open(&tmp.path().join("index.db")).unwrap();
        let root_str = root.display().to_string();
        let root_id = db::add_root(&conn, &root_str, 0).unwrap();
        let policy = ScanPolicy::with_protected(&SecuritySettings::default(), vec![]);
        let out = scan_root(&mut conn, root_id, &root_str, &policy, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(out.progress.links, 1);
        assert_eq!(out.progress.files, 0);
        assert!(db::search(&conn, "secret", 10, &[]).unwrap().is_empty());
    }
}
