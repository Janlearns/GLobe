import { useMemo } from "react";
import { formatCount, formatSize } from "../fileTypes";
import { angularSize } from "../globe/layout";
import { registerLabel } from "../globe/labels";
import type { Tile } from "../globe/model";
import { useStore } from "../state/store";

const MAX_LABELS = 90;
const MAX_PREVIEW_LABELS = 60;

interface Placed {
  t: Tile;
  planet: number;
  major: boolean;
}

export function Labels() {
  const layers = useStore((s) => s.layers);
  const selectedKey = useStore((s) => s.selectedKey);

  const placed = useMemo(() => {
    const bySize = (a: Placed, b: Placed) => angularSize(b.t.rect) - angularSize(a.t.rect);
    // Focused layers (every planet in the overview): folders first, then by size.
    const focus: Placed[] = layers
      .filter((l) => l.role === "focus")
      .flatMap((l) => l.tiles.map((t) => ({ t, planet: l.planet, major: true })))
      .sort((a, b) => (b.t.entry?.kind === "dir" ? 1 : 0) - (a.t.entry?.kind === "dir" ? 1 : 0) || bySize(a, b))
      .slice(0, MAX_LABELS);
    // Names of the largest sub-folders inside previewed folders; projectLabels
    // only shows them once they are big enough on screen.
    const previews: Placed[] = layers
      .filter((l) => l.role === "preview")
      .flatMap((l) => l.tiles.filter((t) => t.entry?.kind === "dir").map((t) => ({ t, planet: l.planet, major: false })))
      .sort(bySize)
      .slice(0, MAX_PREVIEW_LABELS);
    const chosen = [...focus, ...previews];
    if (selectedKey && !chosen.some((p) => p.t.key === selectedKey)) {
      for (const l of layers) {
        const t = l.tiles.find((x) => x.key === selectedKey);
        if (t) {
          chosen.push({ t, planet: l.planet, major: true });
          break;
        }
      }
    }
    return chosen;
  }, [layers, selectedKey]);

  return (
    <div className="labels" aria-hidden>
      {placed.map(({ t, planet, major }) => {
        const isSel = t.key === selectedKey;
        const title = t.more ? `+${formatCount(t.more.count)} more` : t.entry!.name;
        const sub = t.more
          ? formatSize(t.more.size)
          : t.entry!.kind === "dir"
            ? `${formatSize(t.entry!.size)} · ${formatCount(t.entry!.fileCount)} files`
            : formatSize(t.entry!.size);
        return (
          <div
            key={t.key}
            ref={(el) => registerLabel(t.key, el, t.rect, planet, isSel, major ? 34 : 80)}
            className={`label ${t.entry?.kind ?? "more"} ${isSel ? "selected" : ""} ${major ? "" : "minor"}`}
            style={{ visibility: "hidden" }}
          >
            <div className="label-title">{title}</div>
            <div className="label-sub">{sub}</div>
          </div>
        );
      })}
    </div>
  );
}
