import { useSyncExternalStore } from "react";
import { CATEGORY_LABELS, categoryColor, formatCount, formatSize } from "../fileTypes";
import { graphVersion, netGraph, pathTo, subscribeGraph } from "../globe/network/graph";
import { FOLDER_LABELS, netLabelEls } from "../globe/network/labels";
import { resetNetView } from "../globe/network/view";
import { savePref, useStore } from "../state/store";

const useGraph = () => {
  useSyncExternalStore(subscribeGraph, graphVersion);
  return netGraph();
};

/** Planet / Network switch in the top bar. */
export function ViewModeSwitch() {
  const mode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  return (
    <div className="seg" role="group" aria-label="Globe style">
      <button className={mode === "planet" ? "on" : ""} onClick={() => setViewMode("planet")} title="Folders as regions on planets">
        Planet
      </button>
      <button className={mode === "network" ? "on" : ""} onClick={() => setViewMode("network")} title="Folders and files as a 3D network">
        Network
      </button>
    </div>
  );
}

/** Mode badge plus camera / rotation / intensity controls. */
export function NetworkControls() {
  const rotate = useStore((s) => s.netRotate);
  const intensity = useStore((s) => s.netIntensity);
  const g = useGraph();
  const folders = g.nodes.filter((n) => n.entry.kind === "dir").length;
  return (
    <div className="net-controls">
      <div className="net-badge" title="Network Mode is active">
        <span className="net-dot" />
        NETWORK MODE
        <span className="net-count">
          {formatCount(folders)} folders · {formatCount(g.nodes.length - folders)} files
        </span>
      </div>
      <div className="net-buttons">
        <button className="btn ghost small" title="Reset camera" onClick={resetNetView}>
          ⟲ Reset
        </button>
        <button
          className={`btn ghost small ${rotate ? "on" : ""}`}
          title={rotate ? "Pause auto-rotation" : "Resume auto-rotation"}
          onClick={() => {
            savePref("netRotate", !rotate);
            useStore.setState({ netRotate: !rotate });
          }}
        >
          {rotate ? "❚❚ Rotation" : "▶ Rotation"}
        </button>
        <label className="net-intensity" title="Glow intensity">
          <span>Glow</span>
          <input
            className="slider"
            type="range"
            min={0.2}
            max={1.5}
            step={0.05}
            value={intensity}
            onChange={(e) => useStore.setState({ netIntensity: Number(e.target.value) })}
            onPointerUp={() => savePref("netIntensity", useStore.getState().netIntensity)}
            onKeyUp={() => savePref("netIntensity", useStore.getState().netIntensity)}
          />
        </label>
      </div>
    </div>
  );
}

/** Visible "Back" (also: mouse back button, Alt+←, Backspace). */
export function BackButton({ disabled }: { disabled?: boolean }) {
  return (
    <button className="btn small back-btn" title="Back (mouse back button, Alt+←)" disabled={disabled} onClick={() => useStore.getState().goBack()}>
      ← Back
    </button>
  );
}

/** Breadcrumbs for Network Mode: the path to the selected node. */
export function NetworkCrumbs() {
  const selected = useStore((s) => s.selected);
  const activate = useStore((s) => s.activateNetNode);
  const g = useGraph();
  const idx = selected ? g.byId.get(selected.id) : undefined;
  const path = idx != null ? pathTo(idx) : [];
  const canBack = useStore((s) => s.backStack.length > 0 || s.selected != null);
  return (
    <nav className="crumbs" aria-label="Location">
      <BackButton disabled={!canBack} />
      <button
        className="icon-btn"
        title="Up one level (Alt+↑)"
        disabled={path.length < 2}
        onClick={() => path.length >= 2 && activate(path[path.length - 2])}
      >
        ↑
      </button>
      <button
        className={`crumb ${path.length === 0 ? "current" : ""}`}
        onClick={() => {
          useStore.setState({ selected: null, selectedKey: null, highlightKey: null });
          resetNetView();
        }}
      >
        Network
      </button>
      {path.map((i, k) => (
        <span key={i} className="crumb-wrap">
          <span className="sep">›</span>
          <button className={`crumb ${k === path.length - 1 ? "current" : ""}`} title={g.nodes[i].entry.path} onClick={() => activate(i)}>
            {k === 0 ? g.nodes[i].entry.path : g.nodes[i].entry.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** Labels that follow nodes; the scene moves them every frame. */
export function NetworkLabels() {
  const hover = useStore((s) => s.netHover);
  const selected = useStore((s) => s.selected);
  const g = useGraph();
  const h = hover != null ? g.nodes[hover] : undefined;
  const showSelected = selected && g.byId.has(selected.id) && g.byId.get(selected.id) !== hover;
  return (
    <div
      className="labels net-labels"
      onClick={(e) => {
        // Folder names are clickable: same as clicking the folder's node.
        const idx = (e.target as HTMLElement).dataset?.idx;
        if (idx) useStore.getState().activateNetNode(Number(idx));
      }}
    >
      {Array.from({ length: FOLDER_LABELS }, (_, i) => (
        // Text and position are written by the scene each frame.
        <div key={i} ref={(el) => void (netLabelEls.folders[i] = el)} className="net-label folder" style={{ opacity: 0 }} />
      ))}
      <div ref={(el) => void (netLabelEls.selected = el)} className="net-label selected" style={{ opacity: 0 }}>
        {showSelected ? selected.name : ""}
      </div>
      <div ref={(el) => void (netLabelEls.hover = el)} className="net-label hover" style={{ opacity: 0 }}>
        {h && (
          <>
            <div className="net-label-name">{h.entry.name || h.entry.path}</div>
            <div className="net-label-sub">
              {h.entry.kind === "dir"
                ? `${formatSize(h.entry.size)} · ${formatCount(h.entry.fileCount)} files · ${formatCount(h.entry.dirCount)} folders`
                : `${formatSize(h.entry.size)} · ${CATEGORY_LABELS[h.entry.category] ?? h.entry.category}`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Contents of the selected folder, for the details panel: sub-folders first,
 * then files. Hovering a row lights its node; clicking opens / selects it.
 */
export function FolderContents({ id }: { id: number }) {
  const activate = useStore((s) => s.activateNetNode);
  const g = useGraph();
  const idx = g.byId.get(id);
  const node = idx != null ? g.nodes[idx] : undefined;
  if (!node) return null;
  const kids = node.children.map((c) => ({ c, e: g.nodes[c].entry }));
  const dirs = kids.filter((k) => k.e.kind === "dir");
  const files = kids.filter((k) => k.e.kind !== "dir");
  const row = ({ c, e }: (typeof kids)[number]) => (
    <li key={c}>
      <button
        className={`fc-row ${e.kind === "dir" ? "dir" : ""}`}
        title={e.path}
        onClick={() => activate(c)}
        onPointerEnter={() => useStore.setState({ netHover: c })}
        onPointerLeave={() => useStore.getState().netHover === c && useStore.setState({ netHover: null })}
      >
        <span className="dot" style={{ background: categoryColor(e.kind === "dir" ? "folder" : e.category) }} />
        <span className="fc-name">{e.name}</span>
        <span className="fc-meta">{e.kind === "dir" ? `${formatCount(e.fileCount)} files` : formatSize(e.size)}</span>
      </button>
    </li>
  );
  return (
    <section className="folder-contents">
      {!node.loaded ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          <h4>
            Folders <span className="muted">{formatCount(dirs.length)}</span>
          </h4>
          {dirs.length ? <ul className="fc-list">{dirs.map(row)}</ul> : <p className="muted small">No sub-folders.</p>}
          {files.length > 0 && (
            <>
              <h4>
                Files <span className="muted">{formatCount(files.length)}</span>
              </h4>
              <ul className="fc-list">{files.map(row)}</ul>
            </>
          )}
          {kids.length >= 64 && <p className="muted small">Showing the 64 largest items. Use search to find the rest.</p>}
        </>
      )}
    </section>
  );
}
