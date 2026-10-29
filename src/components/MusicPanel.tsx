import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { useStore } from "../state/store";
import { loadDesktopInfo } from "./DesktopPanel";

/** Friendly name for a media-session app id (e.g. "Spotify.exe", "Chrome"). */
export function sourceName(id: string): string {
  const s = id.toLowerCase();
  if (s.includes("spotify")) return "Spotify";
  if (s.includes("chrome")) return "Chrome";
  if (s.includes("msedge") || s.includes("edge")) return "Edge";
  if (s.includes("firefox")) return "Firefox";
  if (s.includes("vlc")) return "VLC";
  if (s.includes("zune") || s.includes("media")) return "Media Player";
  const last = id.split(/[\\/!]/).pop() ?? id;
  return last.replace(/\.exe$/i, "");
}

export function NowPlayingChip() {
  const np = useStore((s) => s.nowPlaying);
  const on = useStore((s) => s.desktopInfo?.musicSync ?? false);
  if (!on || !np || !np.title) return null;
  return (
    <div className={`now-playing ${np.playing ? "playing" : ""}`} title={`${np.title} — ${np.artist} (${sourceName(np.source)})`}>
      <span className="eq" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="np-title">{np.title}</span>
      {np.artist && <span className="np-artist">{np.artist}</span>}
      <span className="np-source">{sourceName(np.source)}</span>
    </div>
  );
}

export function MusicPanel() {
  const { desktopInfo: info, notify, nowPlaying } = useStore();
  const [intensity, setIntensity] = useState(0.7);

  useEffect(() => {
    if (info) setIntensity(info.musicIntensity);
  }, [info]);

  if (!info) return null;

  const toggle = async (enabled: boolean) => {
    try {
      await api.setMusicSync(enabled);
      await loadDesktopInfo();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  const saveIntensity = async (v: number) => {
    try {
      await api.setMusicIntensity(v);
      await loadDesktopInfo();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  return (
    <aside className="panel music">
      <div className="panel-head">
        <h3>Music sync</h3>
        <button className="icon-btn" title="Close" onClick={() => useStore.setState({ panel: "none" })}>
          ×
        </button>
      </div>
      <p className="muted small">
        The aura, stars and a spectrum ring react to whatever your PC is playing: Spotify, YouTube in any browser, games, anything.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={info.musicSync} onChange={(e) => toggle(e.target.checked)} />
        <span>
          <strong>Sync visuals to music</strong>
          <span className="muted small">
            Listens to your speakers' output only to measure the rhythm and frequencies. Nothing is recorded, saved or sent anywhere,
            and your microphone is never used.
          </span>
        </span>
      </label>

      <h4>Intensity</h4>
      <div className="row tight">
        <input
          className="slider"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={intensity}
          onChange={(e) => {
            const v = Number(e.target.value);
            setIntensity(v);
            useStore.setState({ desktopInfo: { ...info, musicIntensity: v } });
          }}
          onPointerUp={() => saveIntensity(intensity)}
          onKeyUp={() => saveIntensity(intensity)}
        />
        <span className="muted small">{Math.round(intensity * 100)}%</span>
      </div>

      <h4>Now playing</h4>
      {info.musicSync ? (
        nowPlaying && nowPlaying.title ? (
          <div className="np-card">
            <div className="np-card-title">{nowPlaying.title}</div>
            <div className="muted small">
              {nowPlaying.artist || "Unknown artist"} · {sourceName(nowPlaying.source)} · {nowPlaying.playing ? "playing" : "paused"}
            </div>
          </div>
        ) : (
          <p className="muted small">Nothing reported yet. Spotify, Chrome, Edge and most players show up here while playing.</p>
        )
      ) : (
        <p className="muted small">Turn on music sync to see the current track.</p>
      )}
    </aside>
  );
}
