import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useStore } from "../state/store";

const pretty = (hk: string) => hk.replace("CommandOrControl", "Ctrl");

export async function loadDesktopInfo() {
  try {
    const info = await api.getDesktopInfo();
    useStore.setState({ desktopInfo: info, desktopMode: info.mode, covered: info.covered });
  } catch (e) {
    useStore.getState().notify("error", errorMessage(e));
  }
}

export function DesktopPanel() {
  const { desktopInfo: info, desktopMode, notify } = useStore();
  const [hotkey, setHotkey] = useState("");
  const [idle, setIdle] = useState(90);

  useEffect(() => {
    void loadDesktopInfo();
  }, []);
  useEffect(() => {
    if (info) {
      setHotkey(info.hotkey);
      setIdle(info.idleReturnSecs);
    }
  }, [info]);

  if (!info) return null;

  const run = async (f: () => Promise<unknown>, ok?: string) => {
    try {
      await f();
      await loadDesktopInfo();
      if (ok) notify("info", ok);
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  return (
    <aside className="panel desktop">
      <div className="panel-head">
        <h3>Wallpaper mode</h3>
        <button className="icon-btn" title="Close" onClick={() => useStore.setState({ panel: "none" })}>
          ×
        </button>
      </div>
      <p className="muted small">
        The globe becomes your desktop background and slowly rotates; it always stays behind your other windows. Press{" "}
        <strong>{pretty(info.hotkey)}</strong> (or click the tray icon) to bring it in front of everything; press it again or Esc to
        send it back.
      </p>
      <button
        className="btn primary"
        onClick={() => run(() => api.setDesktopMode(desktopMode === "window" ? "wallpaper" : "window"))}
      >
        {desktopMode === "window" ? "Set as wallpaper now" : "Back to normal window"}
      </button>

      <h4>Wallpaper style</h4>
      <div className="toggles">
        <label className="toggle">
          <input
            type="radio"
            name="wpstyle"
            checked={info.wallpaperStyle === "interactive"}
            onChange={() => run(() => api.setWallpaperStyle("interactive"))}
          />
          <span>
            <strong>Interactive (recommended)</strong>
            <span className="muted small">
              Works exactly like the explorer: click, search and type directly on the wallpaper. Covers the desktop icons and always
              stays behind your other windows.
            </span>
          </span>
        </label>
        <label className="toggle">
          <input
            type="radio"
            name="wpstyle"
            checked={info.wallpaperStyle === "behindIcons"}
            onChange={() => run(() => api.setWallpaperStyle("behindIcons"))}
          />
          <span>
            <strong>Behind desktop icons</strong>
            <span className="muted small">
              A classic wallpaper: your desktop icons stay visible on top, but Windows sends clicks to the icons, so use{" "}
              {pretty(info.hotkey)} to interact.
            </span>
          </span>
        </label>
      </div>

      <h4>Start with Windows</h4>
      <label className="toggle">
        <input type="checkbox" checked={info.autostart} onChange={(e) => run(() => api.setAutostart(e.target.checked))} />
        <span>
          <strong>Show the globe as wallpaper when I sign in</strong>
          <span className="muted small">Adds a per-user startup entry (no administrator rights).</span>
        </span>
      </label>
      {info.devBuild && (
        <p className="note">
          This is a development build. Startup only works from the installed app (npm run tauri build → run the installer).
        </p>
      )}

      <h4>Explore hotkey</h4>
      <div className="row tight">
        <input className="text" value={hotkey} onChange={(e) => setHotkey(e.target.value)} placeholder="CommandOrControl+Alt+G" />
        <button className="btn" onClick={() => run(() => api.setHotkey(hotkey), "Hotkey saved")}>
          Save
        </button>
      </div>
      <p className="muted small">Examples: CommandOrControl+Alt+G, Alt+Shift+Space, Super+Alt+F</p>

      <h4>Return to wallpaper after inactivity</h4>
      <div className="row tight">
        <input className="text" type="number" min={15} max={3600} value={idle} onChange={(e) => setIdle(Number(e.target.value))} />
        <span className="muted small">seconds</span>
        <button className="btn" onClick={() => run(() => api.setIdleReturn(idle), "Saved")}>
          Save
        </button>
      </div>

      <h4>Limitations</h4>
      <p className="muted small">
        Covers the primary monitor only. Rendering pauses while a maximized or full-screen app covers the desktop. If Explorer
        restarts, the wallpaper re-attaches automatically within a few seconds. Use the tray icon → Quit to close it completely.
      </p>
    </aside>
  );
}
