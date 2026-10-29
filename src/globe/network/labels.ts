/** DOM labels for Network Mode, positioned each frame by the scene (no React re-render per frame). */
export const FOLDER_LABELS = 70;

export const netLabelEls = {
  hover: null as HTMLDivElement | null,
  selected: null as HTMLDivElement | null,
  /** Pool of folder-name labels, filled by priority without overlapping. */
  folders: [] as (HTMLDivElement | null)[],
};
