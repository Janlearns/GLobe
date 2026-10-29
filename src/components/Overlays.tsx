import { CATEGORY_COLORS, CATEGORY_LABELS, formatCount, formatSize } from "../fileTypes";
import { useStore } from "../state/store";

export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  if (!confirm) return null;
  return (
    <div className="modal-backdrop" onClick={() => confirm.resolve(false)}>
      <div className="modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <h3>{confirm.title}</h3>
        <p className="modal-body">{confirm.body}</p>
        <div className="row end">
          <button className="btn" autoFocus onClick={() => confirm.resolve(false)}>
            Cancel
          </button>
          <button className={`btn ${confirm.danger ? "danger" : "primary"}`} onClick={() => confirm.resolve(true)}>
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

export function HoverTip() {
  const hovered = useStore((s) => s.hovered);
  if (!hovered) return null;
  const { tile, x, y } = hovered;
  const name = tile.more ? `+${formatCount(tile.more.count)} more items` : tile.entry!.name;
  const detail = tile.more
    ? `${formatSize(tile.more.size)} · click to show the next page`
    : tile.entry!.kind === "dir"
      ? `${formatSize(tile.entry!.size)} · ${formatCount(tile.entry!.fileCount)} files · click to enter`
      : `${formatSize(tile.entry!.size)} · ${CATEGORY_LABELS[tile.entry!.category] ?? tile.entry!.category}`;
  return (
    <div className="hover-tip" style={{ transform: `translate(${x + 14}px, ${y + 14}px)` }}>
      <div className="hover-name">{name}</div>
      <div className="hover-detail">{detail}</div>
    </div>
  );
}

export function Legend() {
  const hiddenByDefault = new Set(["executable", "script", "installer", "shortcut", "link"]);
  const settings = useStore((s) => s.settings);
  const visible = Object.keys(CATEGORY_COLORS).filter((c) => {
    if (!hiddenByDefault.has(c) || !settings) return !hiddenByDefault.has(c);
    if (c === "executable") return settings.showExecutables;
    if (c === "script") return settings.showScripts;
    if (c === "installer") return settings.showInstallers;
    return settings.showShortcuts;
  });
  return (
    <div className="legend">
      {visible.map((c) => (
        <span key={c} className="legend-item" title={CATEGORY_LABELS[c]}>
          <span className="dot" style={{ background: CATEGORY_COLORS[c] }} />
          {c}
        </span>
      ))}
    </div>
  );
}
