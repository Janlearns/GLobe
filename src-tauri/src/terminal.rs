//! Built-in terminal: a PowerShell or CMD session in an indexed folder.
//!
//! Only opened by an explicit user action with "Allow terminal" enabled and
//! a per-session confirmation. The shell runs with the user's normal rights
//! (never elevated), without a console window; its output streams to the UI
//! as `terminal-output` events. Nothing is typed into it except what the
//! user sends.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Printed (followed by the current folder) whenever the shell is ready for
/// the next command. The UI turns these lines into its prompt.
pub const PROMPT_MARK: &str = "##GFE-PROMPT##";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Powershell,
    Cmd,
}

impl Shell {
    fn exe(self) -> &'static str {
        match self {
            Shell::Powershell => "powershell.exe",
            Shell::Cmd => "cmd.exe",
        }
    }
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    shell: Shell,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    id: u32,
    data: String,
    err: bool,
}

/// Forwards a pipe to the UI, keeping multi-byte UTF-8 characters intact
/// across reads.
fn pump(app: AppHandle, id: u32, mut pipe: impl Read + Send + 'static, err: bool) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                // An incomplete character at the end waits for the next read;
                // a truly invalid byte is replaced.
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid == 0 {
                continue;
            }
            let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            let _ = app.emit("terminal-output", OutputEvent { id, data, err });
        }
        if !err {
            let _ = app.emit("terminal-exit", id);
        }
    });
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The line actually written to the shell.
///
/// PowerShell gets the prompt marker on the same line (so a program reading
/// input never sees it). Its piped input is read in the legacy code page, so
/// a line with non-ASCII text (or a `#` comment, which would hide the marker)
/// is sent base64-encoded and dot-sourced, which keeps variables and the
/// current folder. CMD prints the marker itself as its prompt (see `start`).
fn wrap_line(shell: Shell, line: &str) -> String {
    match shell {
        Shell::Powershell => {
            let mark = format!("\"{PROMPT_MARK}$((Get-Location).Path)\"");
            if line.is_ascii() && !line.contains('#') {
                format!("{line}; {mark}\r\n")
            } else {
                let b64 = base64(line.as_bytes());
                format!(". ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64}')))); {mark}\r\n")
            }
        }
        Shell::Cmd => format!("{line}\r\n"),
    }
}

impl Terminals {
    pub fn start(&self, app: &AppHandle, dir: &Path, shell: Shell) -> Result<u32, String> {
        let mut cmd = Command::new(shell.exe());
        match shell {
            Shell::Powershell => {
                cmd.args(["-NoLogo", "-NoProfile", "-Command", "-"]);
            }
            Shell::Cmd => {
                // The prompt is the marker plus the folder, on its own line.
                cmd.args(["/Q", "/K"]).env("PROMPT", format!("{PROMPT_MARK}$P$_"));
            }
        }
        cmd.current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Scripts print as they go instead of when they exit.
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", shell.exe()))?;
        let mut stdin = child.stdin.take().ok_or("terminal input unavailable")?;
        let stdout = child.stdout.take().ok_or("terminal output unavailable")?;
        let stderr = child.stderr.take().ok_or("terminal output unavailable")?;

        // UTF-8 output, then a first prompt.
        let setup = match shell {
            Shell::Powershell => format!(
                "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; \"{PROMPT_MARK}$((Get-Location).Path)\"\r\n"
            ),
            Shell::Cmd => "chcp 65001 >nul\r\n".to_string(),
        };
        stdin.write_all(setup.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        pump(app.clone(), id, stdout, false);
        pump(app.clone(), id, stderr, true);
        self.sessions.lock().unwrap().insert(id, Session { child, stdin, shell });
        Ok(id)
    }

    /// Sends one line the user typed.
    pub fn write(&self, id: u32, line: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("This terminal has ended. Open a new one.")?;
        let text = wrap_line(s.shell, line.trim_end_matches(['\r', '\n']));
        s.stdin
            .write_all(text.as_bytes())
            .and_then(|_| s.stdin.flush())
            .map_err(|_| "This terminal has ended. Open a new one.".to_string())
    }

    /// Ends the session and everything started from it.
    pub fn stop(&self, id: u32) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(&id) {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &s.child.id().to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.stop(id);
        }
    }
}

/// Opens a separate terminal window (Windows Terminal or a console,
/// whichever Windows uses by default) in the folder.
pub fn open_external(dir: &Path, shell: Shell) -> Result<(), String> {
    let mut cmd = Command::new("cmd.exe");
    // `start` opens a new console; the window title comes first.
    cmd.args(["/C", "start", "Globe terminal", shell.exe()]).current_dir(dir);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not open a terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_stays_on_the_command_line() {
        assert_eq!(wrap_line(Shell::Cmd, "python app.py"), "python app.py\r\n");
        let ps = wrap_line(Shell::Powershell, "node index.js");
        assert!(ps.starts_with("node index.js; ") && ps.matches("\r\n").count() == 1);
        // Comments and non-ASCII text go through the encoded form, still one line.
        for line in ["ls # files", "echo \"halo ✓\""] {
            let w = wrap_line(Shell::Powershell, line);
            assert!(w.contains(&base64(line.as_bytes())) && w.matches("\r\n").count() == 1);
        }
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64("✓".as_bytes()), "4pyT");
    }
}
