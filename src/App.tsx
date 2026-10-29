import { useEffect } from "react";
import { api, errorMessage, listenDesktopEvents, listenMusicEvents, listenScanEvents } from "./api";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { DesktopPanel, loadDesktopInfo } from "./components/DesktopPanel";
import { MusicPanel, NowPlayingChip } from "./components/MusicPanel";
import { music, pushAudioFrame } from "./globe/music";
import { InfoPanel } from "./components/InfoPanel";
import { Labels } from "./components/Labels";
import { ConfirmDialog, HoverTip, Legend, Notices } from "./components/Overlays";
import { SearchBar } from "./components/SearchBar";
import { NetworkControls, NetworkCrumbs, NetworkLabels, ViewModeSwitch } from "./components/NetworkUI";
import { SecurityPanel } from "./components/SecurityPanel";
import { CodeViewer } from "./components/CodeViewer";
import { TerminalPanel } from "./components/TerminalPanel";
import { SourcesPanel, addFolderFlow } from "./components/SourcesPanel";
import { formatCount, formatSize } from "./fileTypes";
import { GlobeScene } from "./globe/GlobeScene";
import { netGraph, pathTo } from "./globe/network/graph";
import { useStore } from "./state/store";

function useBootstrap() {
  useEffect(() => {
    const st = useStore.getState();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const [settings, scanning] = await Promise.all([api.getSettings(), api.isScanning()]);
        useStore.setState({ settings, scanning });
        await st.refresh();
        const off = await listenScanEvents({
          onProgress: (p) => useStore.setState({ progress: p, scanning: true }),
          onFinished: (o) => {
            useStore.setState({ lastOutcome: o, progress: o.progress });
            const p = o.progress;
            st.notify(
              "info",
              o.status === "done"
                ? `Indexed ${formatCount(p.files)} files in ${formatCount(p.dirs)} folders (${formatSize(p.bytes)})${p.errors ? ` · ${p.errors} unreadable` : ""}`
                : "Scan cancelled — the previous index was kept.",
            );
            void useStore.getState().refresh();
          },
          onError: (e) => st.notify("error", e.message),
          onIdle: () => useStore.setState({ scanning: false }),
        });
        const offMusic = await listenMusicEvents({
          onFrame: pushAudioFrame,
          onNowPlaying: (np) => useStore.setState({ nowPlaying: np }),
          onError: (m) => st.notify("error", `Music sync: ${m}`),
        });
        const offDesktop = await listenDesktopEvents({
          onMode: (mode) => {
            useStore.setState({ desktopMode: mode, covered: false });
            if (mode === "wallpaper") {
              // Ambient view: world, nothing selected, no panels.
              useStore.setState({ panel: "none", resultsOpen: false, selected: null, selectedKey: null, highlightKey: null });
              void useStore.getState().setChain([]);
            }
            void loadDesktopInfo();
          },
          onCovered: (covered) => useStore.setState({ covered }),
          onError: (m) => st.notify("error", m),
        });
        await loadDesktopInfo();
        const both = () => {
          off();
          offDesktop();
          offMusic();
        };
        if (disposed) both();
        else unlisten = both;
      } catch (e) {
        st.notify("error", `Backend unavailable: ${errorMessage(e)}`);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (e.key === "Escape" && !typing) {
        if (st.confirm) return;
        if (st.resultsOpen) useStore.setState({ resultsOpen: false });
        else if (st.panel !== "none") useStore.setState({ panel: "none" });
        else if (st.selected) useStore.setState({ selected: null, selectedKey: null, highlightKey: null });
        else if (st.viewMode === "planet" && st.chain.length > 0) void st.goUp();
        else if (st.desktopMode === "overlay") void api.setDesktopMode("wallpaper");
      } else if ((e.altKey && e.key === "ArrowLeft") || (e.key === "Backspace" && !typing)) {
        e.preventDefault();
        st.goBack();
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        if (st.viewMode === "network") {
          const idx = st.selected ? netGraph().byId.get(st.selected.id) : undefined;
          const path = idx != null ? pathTo(idx) : [];
          if (path.length >= 2) st.activateNetNode(path[path.length - 2]);
        } else void st.goUp();
      } else if (e.key === "Home" && !typing) {
        void st.goToLevel(0);
      }
    };
    // The mouse's side "back" button.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        useStore.getState().goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);
}

/** In the overlay, return to the wallpaper after a period without input. */
function useIdleReturn() {
  const mode = useStore((s) => s.desktopMode);
  const secs = useStore((s) => s.desktopInfo?.idleReturnSecs ?? 90);
  useEffect(() => {
    if (mode !== "overlay") return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const id = setInterval(() => {
      const st = useStore.getState();
      if (!st.confirm && Date.now() - last > secs * 1000) void api.setDesktopMode("wallpaper");
    }, 1000);
    return () => {
      clearInterval(id);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [mode, secs]);
}

/** Mirrors the music settings into the render-loop state. */
function useMusicSettings() {
  const on = useStore((s) => s.desktopInfo?.musicSync ?? false);
  const intensity = useStore((s) => s.desktopInfo?.musicIntensity ?? 0.7);
  useEffect(() => {
    music.enabled = on;
    music.intensity = intensity;
    if (!on) useStore.setState({ nowPlaying: null });
  }, [on, intensity]);
}

export default function App() {
  useBootstrap();
  useShortcuts();
  useIdleReturn();
  useMusicSettings();
  const { roots, panel, scanning, progress, stats, lowPower, desktopMode, desktopInfo, viewMode, terminal } = useStore();
  const network = viewMode === "network";
  const hotkey = (desktopInfo?.hotkey ?? "CommandOrControl+Alt+G").replace("CommandOrControl", "Ctrl");

  return (
    <div className={`app mode-${desktopMode} wp-${desktopInfo?.wallpaperStyle ?? "interactive"} view-${viewMode} ${terminal ? "term-open" : ""}`}>
      {desktopMode === "wallpaper" && desktopInfo?.wallpaperStyle === "behindIcons" && (
        <div className="wallpaper-hint">{hotkey} · explore your files</div>
      )}
      <GlobeScene />
      {network ? (
        <NetworkLabels />
      ) : (
        <>
          <Labels />
          <HoverTip />
        </>
      )}

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          Globe<span className="brand-light"> File Explorer</span>
        </div>
        <SearchBar />
        <div className="top-actions">
          <ViewModeSwitch />
          <button className={`btn ghost ${panel === "sources" ? "on" : ""}`} onClick={() => useStore.setState({ panel: panel === "sources" ? "none" : "sources" })}>
            Folders
          </button>
          <button className={`btn ghost ${panel === "security" ? "on" : ""}`} onClick={() => useStore.setState({ panel: panel === "security" ? "none" : "security" })}>
            Security
          </button>
          {desktopMode === "overlay" ? (
            <button className="btn ghost on" title={`Or press ${hotkey} / Esc`} onClick={() => api.setDesktopMode("wallpaper")}>
              Back to wallpaper
            </button>
          ) : (
            <button className={`btn ghost ${panel === "desktop" ? "on" : ""}`} onClick={() => useStore.setState({ panel: panel === "desktop" ? "none" : "desktop" })}>
              Wallpaper
            </button>
          )}
          <button
            className={`btn ghost ${panel === "music" || desktopInfo?.musicSync ? "on" : ""}`}
            title="Sync the visuals to the music you are playing"
            onClick={() => useStore.setState({ panel: panel === "music" ? "none" : "music" })}
          >
            ♪ Music
          </button>
          <button className={`btn ghost ${lowPower ? "on" : ""}`} title="Lower resolution, fewer effects, no idle animation" onClick={() => useStore.setState({ lowPower: !lowPower })}>
            Low power
          </button>
        </div>
      </header>
      {network ? <NetworkCrumbs /> : <Breadcrumbs />}
      {network && <NetworkControls />}

      {panel === "sources" && <SourcesPanel />}
      {panel === "security" && <SecurityPanel />}
      {panel === "desktop" && <DesktopPanel />}
      {panel === "music" && <MusicPanel />}
      <InfoPanel />

      {roots.length === 0 && (
        <div className="welcome">
          <h1>Your files, as a planet.</h1>
          <p>
            Choose a folder to map. Globe File Explorer reads only file names, sizes and dates — it never modifies, moves, uploads or
            runs anything.
          </p>
          <button className="btn primary big" onClick={addFolderFlow}>
            Choose a folder to scan…
          </button>
        </div>
      )}

      <footer className="statusbar">
        <div className="status-left">
          <NowPlayingChip />
          <Legend />
        </div>
        <div className="status-right">
          {scanning && progress ? (
            <button className="link-btn" onClick={() => useStore.setState({ panel: "sources" })}>
              <span className="spinner small" /> Scanning · {formatCount(progress.files)} files · {formatSize(progress.bytes)}
            </button>
          ) : stats ? (
            <span>
              {formatCount(stats.files)} files · {formatCount(stats.dirs)} folders · {formatSize(stats.totalSize)}
            </span>
          ) : null}
          <span className="hint">
            {network ? "drag to rotate · scroll to zoom · click a node for details" : "drag to rotate · scroll to zoom · click to enter · Esc to go up"}
          </span>
        </div>
      </footer>
      <TerminalPanel />
      <CodeViewer />
      <Notices />
      <ConfirmDialog />
    </div>
  );
}
