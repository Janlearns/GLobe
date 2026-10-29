//! Security settings persisted as JSON next to the index. Kept outside SQLite
//! so they can be changed while a scan holds the database write lock.

use crate::security::SecuritySettings;
use std::path::Path;

pub fn load(path: &Path) -> SecuritySettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, s: &SecuritySettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
