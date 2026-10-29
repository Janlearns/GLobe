//! Scan policy: which locations may be scanned, what is excluded, and how
//! entries are classified. Everything here is pure logic so it can be tested
//! without touching the filesystem.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// File categories. Directories use `Folder`, symlinks/junctions use `Link`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Folder,
    Link,
    Document,
    Image,
    Video,
    Audio,
    Archive,
    Code,
    Data,
    Font,
    Executable,
    Script,
    Installer,
    Shortcut,
    Other,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Folder => "folder",
            Category::Link => "link",
            Category::Document => "document",
            Category::Image => "image",
            Category::Video => "video",
            Category::Audio => "audio",
            Category::Archive => "archive",
            Category::Code => "code",
            Category::Data => "data",
            Category::Font => "font",
            Category::Executable => "executable",
            Category::Script => "script",
            Category::Installer => "installer",
            Category::Shortcut => "shortcut",
            Category::Other => "other",
        }
    }

    /// Categories that are hidden unless explicitly enabled and can never be
    /// opened from inside the app.
    pub fn is_potentially_dangerous(self) -> bool {
        matches!(
            self,
            Category::Executable
                | Category::Script
                | Category::Installer
                | Category::Shortcut
                | Category::Link
        )
    }
}

pub const DANGEROUS_CATEGORY_NAMES: [&str; 5] = ["executable", "script", "installer", "shortcut", "link"];

/// Classify by extension. This is only a visibility heuristic: the open action
/// performs additional content checks because an extension alone is not a
/// reliable indicator of what a file really is.
pub fn classify_extension(ext: &str) -> Category {
    match ext {
        "exe" | "dll" | "com" | "scr" | "sys" | "cpl" | "ocx" | "drv" | "efi" | "pif" | "msc"
        | "gadget" | "elf" => Category::Executable,
        "bat" | "cmd" | "ps1" | "psm1" | "psd1" | "ps1xml" | "vbs" | "vbe" | "js" | "jse"
        | "wsf" | "wsh" | "wsc" | "hta" | "sh" | "bash" | "zsh" | "fish" | "py" | "pyw" | "pyc"
        | "rb" | "pl" | "php" | "jar" | "reg" | "scf" | "inf" | "ahk" | "au3" | "applescript"
        | "command" | "xlsm" | "xltm" | "docm" | "dotm" | "pptm" | "potm" | "ppam" | "xlam"
        | "sldm" => Category::Script,
        "msi" | "msix" | "msixbundle" | "msp" | "mst" | "appx" | "appxbundle" | "appinstaller"
        | "apk" | "aab" | "deb" | "rpm" | "dmg" | "pkg" | "vsix" | "xpi" | "crx" => {
            Category::Installer
        }
        "lnk" | "url" | "website" | "desktop" | "library-ms" | "searchconnector-ms" | "settingcontent-ms" => {
            Category::Shortcut
        }
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "markdown" | "tex" | "epub"
        | "mobi" | "xls" | "xlsx" | "ods" | "csv" | "tsv" | "ppt" | "pptx" | "odp" | "pages"
        | "numbers" | "one" | "log" | "rst" | "org" | "djvu" | "xps" | "oxps" => {
            Category::Document
        }
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff" | "svg" | "ico"
        | "heic" | "heif" | "avif" | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "psd"
        | "ai" | "xcf" | "kra" | "eps" => Category::Image,
        "mp4" | "mkv" | "mov" | "avi" | "wmv" | "webm" | "flv" | "m4v" | "mpg" | "mpeg" | "3gp"
        | "m2ts" | "vob" => Category::Video,
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "opus" | "m4a" | "wma" | "aiff" | "mid"
        | "midi" => Category::Audio,
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "iso" | "img"
        | "cab" | "lz" | "lzma" | "vhd" | "vhdx" => Category::Archive,
        "c" | "h" | "ts" | "cpp" | "hpp" | "cc" | "cs" | "java" | "kt" | "go" | "rs" | "swift"
        | "tsx" | "jsx" | "mjs" | "cjs" | "vue" | "svelte" | "html" | "htm" | "css" | "scss"
        | "less" | "lua" | "dart" | "scala" | "r" | "m" | "mm" | "zig" | "sql" | "ipynb"
        | "gradle" | "cmake" | "make" | "dockerfile" => Category::Code,
        "json" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "db" | "sqlite"
        | "sqlite3" | "parquet" | "avro" | "dat" | "sav" | "bak" | "lock" => Category::Data,
        "ttf" | "otf" | "woff" | "woff2" | "fon" => Category::Font,
        _ => Category::Other,
    }
}

/// Lower-cased extension without the dot ("" when none).
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Directory names that are never descended into, wherever they appear.
const EXCLUDED_DIR_NAMES: &[&str] = &[
    "$recycle.bin",
    "recycler",
    "system volume information",
    "windowsapps",
    "appdata",
    "application data",
    "local settings",
    "$windows.~bt",
    "$windows.~ws",
    "$winreagent",
    "config.msi",
    "recovery",
    "msocache",
    "windows.old",
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".password-store",
    ".mozilla",
    ".thunderbird",
    ".config",
    ".local",
    ".cache",
    "user data", // Chromium-family browser profiles
];

/// File name patterns for credential stores, private keys and OS files.
/// Matching files are never indexed.
const SENSITIVE_FILE_PATTERNS: &[&str] = &[
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    "known_hosts",
    "authorized_keys",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.ppk",
    "*.jks",
    "*.keystore",
    "*.kdbx",
    "*.kdb",
    "*.psafe3",
    "*.opvault",
    "*.agilekeychain",
    "*.1pif",
    "*.gpg",
    "*.pgp",
    "*.ovpn",
    "*.asc",
    ".env",
    ".env.*",
    ".netrc",
    "_netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "credentials",
    "credentials.json",
    "login data",
    "cookies",
    "web data",
    "key3.db",
    "key4.db",
    "logins.json",
    "cert9.db",
    "ntuser.*",
    "usrclass.dat*",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
];

/// User-adjustable security settings (persisted as JSON by `settings.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SecuritySettings {
    pub show_executables: bool,
    pub show_scripts: bool,
    pub show_installers: bool,
    pub show_shortcuts: bool,
    /// Allows running visible programs, scripts, installers and shortcuts
    /// after a per-launch confirmation. Off by default.
    pub allow_launch: bool,
    /// Lets the code viewer read the text of a file the user opens in it.
    /// Off by default: the scanner itself never reads contents.
    pub allow_read_contents: bool,
    /// Lets the user open a PowerShell / CMD terminal in an indexed folder.
    /// Off by default; every session also needs a confirmation.
    pub allow_terminal: bool,
    /// Extra excluded directory paths (absolute) or directory names.
    pub extra_excluded_dirs: Vec<String>,
    /// Extra excluded file name glob patterns, e.g. `*.tmp`.
    pub extra_excluded_patterns: Vec<String>,
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            show_executables: false,
            show_scripts: false,
            show_installers: false,
            show_shortcuts: false,
            allow_launch: false,
            allow_read_contents: false,
            allow_terminal: false,
            extra_excluded_dirs: Vec::new(),
            extra_excluded_patterns: Vec::new(),
        }
    }
}

impl SecuritySettings {
    /// Category names that must be filtered out of every query.
    pub fn hidden_categories(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if !self.show_executables {
            out.push("executable");
        }
        if !self.show_scripts {
            out.push("script");
        }
        if !self.show_installers {
            out.push("installer");
        }
        if !self.show_shortcuts {
            out.push("shortcut");
            out.push("link");
        }
        out
    }
}

/// Protected system locations derived from the environment. A scan root may
/// not be inside any of these, and the scanner never descends into them.
pub fn protected_prefixes() -> Vec<String> {
    let mut out = Vec::new();
    for var in [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                out.push(normalize_for_compare(&v));
            }
        }
    }
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    for p in ["\\Windows", "\\Program Files", "\\Program Files (x86)", "\\ProgramData"] {
        out.push(normalize_for_compare(&format!("{system_drive}{p}")));
    }
    out.sort();
    out.dedup();
    out
}

/// Lower-cases, uses backslashes and strips trailing separators.
pub fn normalize_for_compare(p: &str) -> String {
    let s = display_path(Path::new(p)).replace('/', "\\").to_lowercase();
    let trimmed = s.trim_end_matches('\\');
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

/// True if `path` equals `prefix` or lies inside it (both normalized).
pub fn is_within(path: &str, prefix: &str) -> bool {
    if prefix.ends_with('\\') {
        return path.starts_with(prefix) || path == prefix.trim_end_matches('\\');
    }
    path == prefix || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'\\'))
}

/// Removes the `\\?\` verbatim prefix produced by `canonicalize`.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// Case-insensitive glob matcher supporting `*` and `?`.
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootCheck {
    Ok,
    /// Drive roots and the whole user profile are allowed only after an
    /// explicit confirmation from the user.
    NeedsConfirmation,
}

/// Compiled policy used by the scanner.
#[derive(Debug, Clone)]
pub struct ScanPolicy {
    protected: Vec<String>,
    excluded_dir_paths: Vec<String>,
    excluded_dir_names: Vec<String>,
    file_patterns: Vec<String>,
}

impl ScanPolicy {
    pub fn new(settings: &SecuritySettings) -> Self {
        Self::with_protected(settings, protected_prefixes())
    }

    pub fn with_protected(settings: &SecuritySettings, protected: Vec<String>) -> Self {
        let mut excluded_dir_paths = Vec::new();
        let mut excluded_dir_names: Vec<String> =
            EXCLUDED_DIR_NAMES.iter().map(|s| s.to_string()).collect();
        for d in &settings.extra_excluded_dirs {
            let d = d.trim();
            if d.is_empty() {
                continue;
            }
            if d.contains('\\') || d.contains('/') || d.contains(':') {
                excluded_dir_paths.push(normalize_for_compare(d));
            } else {
                excluded_dir_names.push(d.to_lowercase());
            }
        }
        let mut file_patterns: Vec<String> =
            SENSITIVE_FILE_PATTERNS.iter().map(|s| s.to_string()).collect();
        file_patterns.extend(
            settings
                .extra_excluded_patterns
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        );
        Self { protected, excluded_dir_paths, excluded_dir_names, file_patterns }
    }

    /// Validates a user-selected scan root (already canonicalized).
    pub fn check_root(&self, root: &Path) -> Result<RootCheck, String> {
        let norm = normalize_for_compare(&display_path(root));
        if let Some(p) = self.protected.iter().find(|p| is_within(&norm, p)) {
            return Err(format!("'{}' is inside a protected system location ({p}) and cannot be scanned.", display_path(root)));
        }
        if let Some(name) = root.file_name().and_then(|n| n.to_str()) {
            if self.excluded_dir_names.iter().any(|n| n == &name.to_lowercase()) {
                return Err(format!("'{}' is an excluded location and cannot be scanned.", display_path(root)));
            }
        }
        let is_drive_root = norm.len() <= 3 && norm.ends_with(":\\");
        let is_profile = std::env::var("USERPROFILE")
            .map(|u| normalize_for_compare(&u) == norm)
            .unwrap_or(false);
        let is_share_root = norm.starts_with("\\\\") && norm.matches('\\').count() <= 3;
        if is_drive_root || is_profile || is_share_root {
            Ok(RootCheck::NeedsConfirmation)
        } else {
            Ok(RootCheck::Ok)
        }
    }

    pub fn is_excluded_dir(&self, path: &Path, name: &str) -> bool {
        let lname = name.to_lowercase();
        if self.excluded_dir_names.iter().any(|n| n == &lname) {
            return true;
        }
        let norm = normalize_for_compare(&display_path(path));
        self.protected.iter().any(|p| is_within(&norm, p))
            || self.excluded_dir_paths.iter().any(|p| is_within(&norm, p))
    }

    pub fn is_excluded_file(&self, name: &str) -> bool {
        self.file_patterns.iter().any(|p| glob_match(p, name))
    }
}

/// Canonicalize a user-provided root path.
pub fn canonical_root(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path.trim());
    let canon = std::fs::canonicalize(p).map_err(|e| format!("Cannot access '{path}': {e}"))?;
    let md = std::fs::metadata(&canon).map_err(|e| format!("Cannot access '{path}': {e}"))?;
    if !md.is_dir() {
        return Err(format!("'{path}' is not a folder."));
    }
    Ok(PathBuf::from(display_path(&canon)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> ScanPolicy {
        ScanPolicy::with_protected(
            &SecuritySettings::default(),
            vec!["c:\\windows".into(), "c:\\program files".into(), "c:\\users\\me\\appdata\\local".into()],
        )
    }

    #[test]
    fn glob() {
        assert!(glob_match("*.pem", "Server.PEM"));
        assert!(glob_match("id_rsa*", "id_rsa.pub"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("*.pem", "pem.txt"));
        assert!(glob_match("*", ""));
        assert!(!glob_match("credentials", "credentials.txt"));
    }

    #[test]
    fn extensions() {
        assert_eq!(extension_of("a.TXT"), "txt");
        assert_eq!(extension_of(".bashrc"), "");
        assert_eq!(extension_of("archive.tar.gz"), "gz");
        assert_eq!(extension_of("noext"), "");
        assert!(classify_extension("exe").is_potentially_dangerous());
        assert!(classify_extension("ps1").is_potentially_dangerous());
        assert!(classify_extension("lnk").is_potentially_dangerous());
        assert!(!classify_extension("pdf").is_potentially_dangerous());
    }

    #[test]
    fn within() {
        assert!(is_within("c:\\windows\\system32", "c:\\windows"));
        assert!(is_within("c:\\windows", "c:\\windows"));
        assert!(!is_within("c:\\windowsfoo", "c:\\windows"));
        assert!(is_within("d:\\x", "d:\\"));
    }

    #[test]
    fn roots() {
        let p = policy();
        assert!(p.check_root(Path::new("C:\\Windows\\System32")).is_err());
        assert!(p.check_root(Path::new("C:\\Program Files")).is_err());
        assert!(p.check_root(Path::new("C:\\Users\\me\\AppData\\Local\\Temp")).is_err());
        assert_eq!(p.check_root(Path::new("D:\\")).unwrap(), RootCheck::NeedsConfirmation);
        assert_eq!(p.check_root(Path::new("D:\\Projects")).unwrap(), RootCheck::Ok);
    }

    #[test]
    fn exclusions() {
        let mut s = SecuritySettings::default();
        s.extra_excluded_dirs = vec!["node_modules".into(), "D:\\Secret".into()];
        s.extra_excluded_patterns = vec!["*.tmp".into()];
        let p = ScanPolicy::with_protected(&s, vec![]);
        assert!(p.is_excluded_dir(Path::new("C:\\Users\\me\\.ssh"), ".ssh"));
        assert!(p.is_excluded_dir(Path::new("C:\\Users\\me\\AppData"), "AppData"));
        assert!(p.is_excluded_dir(Path::new("D:\\a\\node_modules"), "node_modules"));
        assert!(p.is_excluded_dir(Path::new("D:\\Secret\\inner"), "inner"));
        assert!(!p.is_excluded_dir(Path::new("D:\\Photos"), "Photos"));
        assert!(p.is_excluded_file("id_ed25519"));
        assert!(p.is_excluded_file("vault.KDBX"));
        assert!(p.is_excluded_file("x.tmp"));
        assert!(!p.is_excluded_file("report.pdf"));
    }

    #[test]
    fn hidden_categories() {
        let mut s = SecuritySettings::default();
        assert_eq!(s.hidden_categories().len(), 5);
        s.show_scripts = true;
        assert!(!s.hidden_categories().contains(&"script"));
    }

    #[test]
    fn verbatim() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a")), r"C:\a");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share")), r"\\srv\share");
    }
}
