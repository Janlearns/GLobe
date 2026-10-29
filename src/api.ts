import { invoke } from "@tauri-apps/api/core";
import type { AudioFrame } from "./globe/music";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AddRootResult,
  DesktopInfo,
  DesktopMode,
  WallpaperStyle,
  NowPlaying,
  TerminalShell,
  TextFile,
  ChildPage,
  Entry,
  IndexStats,
  LocateStep,
  RootInfo,
  ScanOutcome,
  ScanProgress,
  SecuritySettings,
} from "./types";

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  listRoots: () => invoke<RootInfo[]>("list_roots"),
  addRoot: (path: string, confirmed = false) => invoke<AddRootResult>("add_root", { path, confirmed }),
  removeRoot: (rootId: number) => invoke<void>("remove_root", { rootId }),
  startScan: (rootIds: number[]) => invoke<void>("start_scan", { rootIds }),
  cancelScan: () => invoke<void>("cancel_scan"),
  isScanning: () => invoke<boolean>("is_scanning"),
  listChildren: (parentId: number, offset: number, limit: number) =>
    invoke<ChildPage>("list_children", { parentId, offset, limit }),
  getEntry: (id: number) => invoke<Entry>("get_entry", { id }),
  locate: (id: number) => invoke<LocateStep[]>("locate", { id }),
  locatePath: (path: string) => invoke<LocateStep[] | null>("locate_path", { path }),
  search: (query: string, limit = 200) => invoke<Entry[]>("search", { query, limit }),
  indexStats: () => invoke<IndexStats>("index_stats"),
  getSettings: () => invoke<SecuritySettings>("get_settings"),
  setSettings: (settings: SecuritySettings) => invoke<SecuritySettings>("set_settings", { settings }),
  revealInExplorer: (id: number) => invoke<void>("reveal_in_explorer", { id }),
  openContainingFolder: (id: number) => invoke<void>("open_containing_folder", { id }),
  openFile: (id: number, confirmed: boolean) => invoke<void>("open_file", { id, confirmed }),
  getDesktopInfo: () => invoke<DesktopInfo>("get_desktop_info"),
  setDesktopMode: (mode: DesktopMode) => invoke<void>("set_desktop_mode", { mode }),
  setHotkey: (hotkey: string) => invoke<void>("set_hotkey", { hotkey }),
  setIdleReturn: (secs: number) => invoke<void>("set_idle_return", { secs }),
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
  setWallpaperStyle: (style: WallpaperStyle) => invoke<void>("set_wallpaper_style", { style }),
  setMusicSync: (enabled: boolean) => invoke<void>("set_music_sync", { enabled }),
  setMusicIntensity: (intensity: number) => invoke<void>("set_music_intensity", { intensity }),
  readTextFile: (id: number) => invoke<TextFile>("read_text_file", { id }),
  terminalStart: (id: number, shell: TerminalShell, confirmed: boolean) => invoke<number>("terminal_start", { id, shell, confirmed }),
  terminalWrite: (session: number, line: string) => invoke<void>("terminal_write", { session, line }),
  terminalStop: (session: number) => invoke<void>("terminal_stop", { session }),
  openExternalTerminal: (id: number, shell: TerminalShell, confirmed: boolean) => invoke<void>("open_external_terminal", { id, shell, confirmed }),
};

export async function listenTerminal(h: {
  onOutput: (e: { id: number; data: string; err: boolean }) => void;
  onExit: (id: number) => void;
}): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<{ id: number; data: string; err: boolean }>("terminal-output", (e) => h.onOutput(e.payload)),
    listen<number>("terminal-exit", (e) => h.onExit(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

export async function listenMusicEvents(h: {
  onFrame: (f: AudioFrame) => void;
  onNowPlaying: (np: NowPlaying) => void;
  onError: (message: string) => void;
}): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<AudioFrame>("audio-frame", (e) => h.onFrame(e.payload)),
    listen<NowPlaying>("now-playing", (e) => h.onNowPlaying(e.payload)),
    listen<string>("music-error", (e) => h.onError(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

export async function listenDesktopEvents(h: {
  onMode: (m: DesktopMode) => void;
  onCovered: (covered: boolean) => void;
  onError: (message: string) => void;
}): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<DesktopMode>("desktop-mode", (e) => h.onMode(e.payload)),
    listen<boolean>("wallpaper-covered", (e) => h.onCovered(e.payload)),
    listen<string>("desktop-error", (e) => h.onError(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

export interface ScanEvents {
  onProgress: (p: ScanProgress) => void;
  onFinished: (o: ScanOutcome) => void;
  onError: (e: { rootId: number | null; message: string }) => void;
  onIdle: () => void;
}

export async function listenScanEvents(h: ScanEvents): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<ScanProgress>("scan-progress", (e) => h.onProgress(e.payload)),
    listen<ScanOutcome>("scan-finished", (e) => h.onFinished(e.payload)),
    listen<{ rootId: number | null; message: string }>("scan-error", (e) => h.onError(e.payload)),
    listen("scan-idle", () => h.onIdle()),
  ]);
  return () => offs.forEach((off) => off());
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
