//! User-initiated file actions. Every action takes an index entry (never an
//! arbitrary path from the UI), so only indexed, approved locations can be
//! targeted. Nothing here runs automatically.

use crate::db::Entry;
use crate::security::{classify_extension, Category, DANGEROUS_CATEGORY_NAMES};
use std::io::Read;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn explorer(arg: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // raw_arg keeps explorer's own quoting rules (`/select,"C:\a b\c"`).
        Command::new("explorer.exe")
            .raw_arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not start Windows File Explorer: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = arg;
        Err("File Explorer integration is only available on Windows.".into())
    }
}

fn ensure_exists(path: &str) -> Result<(), String> {
    std::fs::symlink_metadata(path)
        .map(|_| ())
        .map_err(|_| format!("'{path}' no longer exists. Rescan the folder to refresh the index."))
}

fn quoted(path: &str) -> Result<String, String> {
    if path.contains('"') {
        return Err("Unsupported path.".into());
    }
    Ok(format!("\"{path}\""))
}

/// Opens Explorer with the item selected.
pub fn reveal(entry: &Entry) -> Result<(), String> {
    ensure_exists(&entry.path)?;
    explorer(format!("/select,{}", quoted(&entry.path)?))
}

/// Opens the folder that contains the item (or the folder itself).
pub fn open_containing_folder(entry: &Entry) -> Result<(), String> {
    let dir = if entry.kind == "dir" {
        entry.path.clone()
    } else {
        Path::new(&entry.path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .ok_or("Item has no parent folder.")?
    };
    ensure_exists(&dir)?;
    explorer(quoted(&dir)?)
}

/// Looks at the first bytes of a file to detect executables/scripts that do
/// not carry a dangerous extension. Only used right before an explicit open.
fn looks_executable(path: &str) -> bool {
    let mut buf = [0u8; 4];
    let Ok(mut f) = std::fs::File::open(path) else { return true };
    let n = f.read(&mut buf).unwrap_or(0);
    let head = &buf[..n];
    head.starts_with(b"MZ") || head.starts_with(b"#!") || head.starts_with(b"\x7fELF")
}

fn is_symlink(path: &str) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(true)
}

/// Appends `kind<TAB>detail` with a timestamp to the launch log.
pub fn log_event(log: &Path, kind: &str, detail: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "{ts}\t{kind}\t{}", detail.replace(['\t', '\r', '\n'], " "));
    }
}

/// A folder from the index that still exists and is not a link.
pub fn existing_dir(entry: &Entry) -> Result<&Path, String> {
    if entry.kind != "dir" {
        return Err("Pick a folder.".into());
    }
    ensure_exists(&entry.path)?;
    if is_symlink(&entry.path) {
        return Err("Links are never followed.".into());
    }
    Ok(Path::new(&entry.path))
}

/// Appends a line to the launch log (who/what/when) for later review.
fn log_launch(log: &Path, entry: &Entry) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "{ts}\t{}\t{}", entry.category, entry.path);
    }
}

/// Opens a file with its default application, or runs a program. Must only
/// be called after an explicit, confirmed user action.
///
/// * Regular files open normally, but a file whose content looks like a
///   program despite a harmless extension is always refused.
/// * Programs, scripts, installers and shortcuts run only when the user has
///   enabled "Allow launching programs" (and the category is visible, which
///   the caller checks). They start through Explorer without elevation, so
///   SmartScreen, Mark-of-the-Web checks and UAC prompts still apply.
/// * Symbolic links and junctions are never followed or opened.
pub fn open_with_default_app(entry: &Entry, allow_launch: bool, launch_log: &Path) -> Result<(), String> {
    if entry.kind != "file" {
        return Err("Only regular files can be opened. Use 'Open folder' for folders.".into());
    }
    let cat = classify_extension(&entry.ext);
    if cat == Category::Link || entry.category == "link" {
        return Err("Links are never opened from Globe File Explorer.".into());
    }
    ensure_exists(&entry.path)?;
    if is_symlink(&entry.path) {
        return Err("Links are never opened from Globe File Explorer.".into());
    }
    let runs_code =
        cat.is_potentially_dangerous() || DANGEROUS_CATEGORY_NAMES.contains(&entry.category.as_str()) || entry.ext.is_empty();
    if runs_code {
        if !allow_launch {
            return Err(
                "Running programs is turned off. Enable 'Allow launching programs' in Security settings, or use 'Reveal in Explorer'."
                    .into(),
            );
        }
        log_launch(launch_log, entry);
        return explorer(quoted(&entry.path)?);
    }
    if looks_executable(&entry.path) {
        return Err("This file looks like a program or script despite its extension, so it will not be opened.".into());
    }
    explorer(quoted(&entry.path)?)
}

/// Largest part of a file the code viewer shows.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Jupyter notebooks (`.ipynb`) are read whole, embedded plots included.
pub const MAX_NOTEBOOK_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    /// The file is larger than `MAX_TEXT_BYTES`; only its start is shown.
    pub truncated: bool,
    pub size: u64,
}

/// Reads a text file for the code viewer (read-only, never executed). Only
/// called after the user opened the file in the viewer with reading enabled.
/// Binary files and links are refused.
pub fn read_text(entry: &Entry) -> Result<TextFile, String> {
    if entry.kind != "file" || entry.category == "link" {
        return Err("Only regular files can be viewed.".into());
    }
    ensure_exists(&entry.path)?;
    if is_symlink(&entry.path) {
        return Err("Links are never followed.".into());
    }
    // A notebook is only readable whole (it is JSON), and embedded plots make
    // them large, so they get a bigger limit.
    let limit = if entry.ext.eq_ignore_ascii_case("ipynb") { MAX_NOTEBOOK_BYTES } else { MAX_TEXT_BYTES };
    let file = std::fs::File::open(&entry.path).map_err(|e| format!("Could not read the file: {e}"))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut bytes = Vec::with_capacity((size as usize).min(limit));
    file.take(limit as u64).read_to_end(&mut bytes).map_err(|e| format!("Could not read the file: {e}"))?;
    Ok(TextFile { text: decode_text(&bytes)?, truncated: size > limit as u64, size })
}

/// UTF-8 (with or without BOM) or UTF-16 with BOM; anything with NUL bytes
/// otherwise is treated as binary.
fn decode_text(bytes: &[u8]) -> Result<String, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Ok(String::from_utf16_lossy(&units));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return Ok(String::from_utf16_lossy(&units));
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if body.iter().take(8192).any(|&b| b == 0) {
        return Err("This looks like a binary file, so it cannot be shown as text.".into());
    }
    Ok(String::from_utf8_lossy(body).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &Path, ext: &str, category: &str) -> Entry {
        Entry {
            id: 1,
            root_id: 1,
            parent_id: Some(0),
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            ext: ext.into(),
            kind: "file",
            size: 2,
            file_count: 0,
            dir_count: 0,
            modified: None,
            created: None,
            category: category.into(),
            depth: 1,
            path: path.display().to_string(),
        }
    }

    #[test]
    fn programs_need_launch_permission() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("tool.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        let log = dir.path().join("launch-log.tsv");
        let err = open_with_default_app(&entry(&exe, "exe", "executable"), false, &log).unwrap_err();
        assert!(err.contains("Allow launching programs"));
        assert!(!log.exists(), "refused launches are not logged as launches");
    }

    #[test]
    fn disguised_programs_are_never_opened() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("invoice.pdf");
        std::fs::write(&fake, b"MZ\x90\x00").unwrap();
        let log = dir.path().join("launch-log.tsv");
        // Even with launching allowed, a "PDF" that is really a program is refused.
        let err = open_with_default_app(&entry(&fake, "pdf", "document"), true, &log).unwrap_err();
        assert!(err.contains("looks like a program"));
    }

    #[test]
    fn text_decoding() {
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'p', b'y']).unwrap(), "py");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]).unwrap(), "hi");
        assert!(decode_text(&[b'M', b'Z', 0x90, 0x00, 0x03]).is_err());
    }
}
