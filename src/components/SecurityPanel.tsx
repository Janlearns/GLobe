import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useStore } from "../state/store";
import type { SecuritySettings } from "../types";

const TOGGLES: { key: keyof SecuritySettings; label: string; detail: string }[] = [
  { key: "showExecutables", label: "Executables", detail: ".exe .dll .com .scr .sys .cpl …" },
  { key: "showScripts", label: "Scripts & macro documents", detail: ".bat .cmd .ps1 .vbs .js .py .jar .reg .docm .xlsm …" },
  { key: "showInstallers", label: "Installers & packages", detail: ".msi .msix .appx .apk .vsix …" },
  { key: "showShortcuts", label: "Shortcuts & links", detail: ".lnk .url, symbolic links and junctions" },
];

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export function SecurityPanel() {
  const { settings, ask, notify, refresh } = useStore();
  const [dirs, setDirs] = useState("");
  const [patterns, setPatterns] = useState("");

  useEffect(() => {
    if (settings) {
      setDirs(settings.extraExcludedDirs.join("\n"));
      setPatterns(settings.extraExcludedPatterns.join("\n"));
    }
  }, [settings]);

  if (!settings) return null;

  const save = async (next: SecuritySettings) => {
    try {
      const saved = await api.setSettings(next);
      useStore.setState({ settings: saved });
      await refresh();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  const toggle = async (key: keyof SecuritySettings, label: string) => {
    const enabling = !settings[key];
    if (enabling) {
      const ok = await ask({
        title: `Show ${label.toLowerCase()}?`,
        body:
          "These files can run code on your computer. They will become visible on the globe and in search results, " +
          "but Globe File Explorer will still never open or run them — you can only reveal them in File Explorer.",
        confirmLabel: "Show them",
        danger: true,
      });
      if (!ok) return;
    }
    await save({ ...settings, [key]: enabling });
  };

  const toggleLaunch = async () => {
    if (!settings.allowLaunch) {
      const ok = await ask({
        title: "Allow launching programs?",
        body:
          "Programs, scripts, installers and shortcuts you can see on the globe will become runnable — always after a confirmation " +
          "for each launch.\n\nOnly run files you trust. A program started this way has the same access to your computer as if you " +
          "had double-clicked it in File Explorer.",
        confirmLabel: "Allow launching",
        danger: true,
      });
      if (!ok) return;
    }
    await save({ ...settings, allowLaunch: !settings.allowLaunch });
  };

  const toggleContents = async () => {
    await save({ ...settings, allowReadContents: !settings.allowReadContents });
  };

  const toggleTerminal = async () => {
    if (!settings.allowTerminal) {
      const ok = await ask({
        title: "Allow the terminal?",
        body:
          "Lets you open PowerShell or Command Prompt inside an indexed folder and type commands. Commands run with your normal " +
          "rights (never as administrator) and are recorded in launch-log.tsv. Only run commands you understand.",
        confirmLabel: "Allow terminal",
        danger: true,
      });
      if (!ok) return;
    }
    await save({ ...settings, allowTerminal: !settings.allowTerminal });
  };

  const saveExclusions = async () => {
    await save({ ...settings, extraExcludedDirs: lines(dirs), extraExcludedPatterns: lines(patterns) });
    notify("info", "Exclusions saved. Rescan your folders to apply them.");
  };

  return (
    <aside className="panel security">
      <div className="panel-head">
        <h3>Security settings</h3>
        <button className="icon-btn" title="Close" onClick={() => useStore.setState({ panel: "none" })}>
          ×
        </button>
      </div>
      <p className="muted small">
        Potentially dangerous file types are indexed by metadata only and hidden by default. Extensions are only a hint: opening is
        also refused for files whose content looks like a program.
      </p>
      <div className="toggles">
        {TOGGLES.map((t) => (
          <label key={t.key} className="toggle">
            <input type="checkbox" checked={Boolean(settings[t.key])} onChange={() => toggle(t.key, t.label)} />
            <span>
              <strong>{t.label}</strong>
              <span className="muted small">{t.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <h4>Running programs</h4>
      <label className="toggle">
        <input type="checkbox" checked={settings.allowLaunch} onChange={toggleLaunch} />
        <span>
          <strong>Allow launching programs</strong>
          <span className="muted small">
            Lets you run visible executables, scripts, installers and shortcuts from the globe. Every launch still asks for confirmation,
            runs without administrator rights (Windows SmartScreen and UAC still apply) and is recorded in launch-log.tsv. Off by
            default.
          </span>
        </span>
      </label>
      {settings.allowLaunch && !settings.showExecutables && !settings.showScripts && !settings.showInstallers && !settings.showShortcuts && (
        <p className="note">Also enable the file types you want to run above; hidden types can never be launched.</p>
      )}

      <h4>Code and terminal</h4>
      <label className="toggle">
        <input type="checkbox" checked={settings.allowReadContents} onChange={toggleContents} />
        <span>
          <strong>Allow reading file contents</strong>
          <span className="muted small">
            Lets the code viewer show the text of a file when you open it there (read-only, up to 1 MB, binary files refused). The
            scanner never reads contents either way. Off by default.
          </span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={settings.allowTerminal} onChange={toggleTerminal} />
        <span>
          <strong>Allow the terminal</strong>
          <span className="muted small">
            Lets you open PowerShell / Command Prompt in an indexed folder to run your code. Each session asks first, nothing runs
            until you press Enter, never as administrator, and every command is recorded in launch-log.tsv. Off by default.
          </span>
        </span>
      </label>

      <h4>Always excluded</h4>
      <p className="muted small">
        Windows, Program Files, ProgramData, AppData (incl. browser profiles), WindowsApps, Recycle Bin, System Volume Information,
        .ssh/.gnupg/.aws and similar, private keys (*.pem, *.key, id_rsa…), password vaults (*.kdbx…), .env files and protected OS
        files.
      </p>
      <h4>Extra excluded folders</h4>
      <textarea value={dirs} onChange={(e) => setDirs(e.target.value)} placeholder={"node_modules\nD:\\Private"} rows={3} />
      <h4>Extra excluded file patterns</h4>
      <textarea value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder={"*.tmp\nsecret*"} rows={3} />
      <button className="btn primary" onClick={saveExclusions}>
        Save exclusions
      </button>
    </aside>
  );
}
