export type EntryKind = "file" | "dir" | "link";

export interface Entry {
  id: number;
  rootId: number;
  parentId: number | null;
  name: string;
  ext: string;
  kind: EntryKind;
  size: number;
  fileCount: number;
  dirCount: number;
  modified: number | null;
  created: number | null;
  category: string;
  depth: number;
  path: string;
}

export interface RootInfo {
  id: number;
  path: string;
  addedAt: number;
  lastScan: number | null;
  status: string;
  message: string | null;
  entry: Entry | null;
}

export interface ChildPage {
  parentId: number;
  offset: number;
  items: Entry[];
  total: number;
  remainingCount: number;
  remainingSize: number;
}

export interface LocateStep {
  entry: Entry;
  rank: number;
}

export interface ScanProgress {
  rootId: number;
  rootPath: string;
  phase: "scanning" | "aggregating" | "committing" | "done" | "cancelled";
  files: number;
  dirs: number;
  bytes: number;
  skipped: number;
  links: number;
  errors: number;
  current: string;
  elapsedMs: number;
}

export interface ScanOutcome {
  progress: ScanProgress;
  status: "done" | "cancelled";
  errorSamples: string[];
}

export interface SecuritySettings {
  showExecutables: boolean;
  showScripts: boolean;
  showInstallers: boolean;
  showShortcuts: boolean;
  allowLaunch: boolean;
  allowReadContents: boolean;
  allowTerminal: boolean;
  extraExcludedDirs: string[];
  extraExcludedPatterns: string[];
}

export interface IndexStats {
  entries: number;
  files: number;
  dirs: number;
  totalSize: number;
}

export interface AddRootResult {
  status: "added" | "exists" | "needsConfirmation";
  message: string | null;
  rootId: number | null;
}

export interface TextFile {
  text: string;
  truncated: boolean;
  size: number;
}

export type TerminalShell = "powershell" | "cmd";

/** Track reported by the Windows media session (Spotify, browsers, …). */
export interface NowPlaying {
  title: string;
  artist: string;
  source: string;
  playing: boolean;
}

export type DesktopMode = "window" | "wallpaper" | "overlay";

/** `interactive`: above the desktop icons, clickable. `behindIcons`: a true wallpaper behind the icons. */
export type WallpaperStyle = "interactive" | "behindIcons";

export interface DesktopInfo {
  mode: DesktopMode;
  hotkey: string;
  idleReturnSecs: number;
  wallpaperStyle: WallpaperStyle;
  musicSync: boolean;
  musicIntensity: number;
  autostart: boolean;
  devBuild: boolean;
  covered: boolean;
}
