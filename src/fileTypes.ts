/** Display colors per category (shared by the globe and the UI). */
export const CATEGORY_COLORS: Record<string, string> = {
  folder: "#3fa9ff",
  document: "#7ad7ff",
  image: "#b48cff",
  video: "#ff6fb5",
  audio: "#ffb86b",
  archive: "#f2d16b",
  code: "#6bffb8",
  data: "#4fe0d0",
  font: "#c8c8ff",
  executable: "#ff5a5a",
  script: "#ff8a5a",
  installer: "#ff6a8a",
  shortcut: "#a9b4c4",
  link: "#8892a4",
  other: "#9fb3c8",
};

export const CATEGORY_LABELS: Record<string, string> = {
  folder: "Folder",
  document: "Document",
  image: "Image",
  video: "Video",
  audio: "Audio",
  archive: "Archive / disk image",
  code: "Source code",
  data: "Data / config",
  font: "Font",
  executable: "Executable (hidden by default)",
  script: "Script / macro document (hidden by default)",
  installer: "Installer / package (hidden by default)",
  shortcut: "Shortcut (hidden by default)",
  link: "Symbolic link / junction (not followed)",
  other: "Other",
};

export const categoryColor = (c: string) => CATEGORY_COLORS[c] ?? CATEGORY_COLORS.other;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function formatDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}
