import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../api";
import { formatCount, formatDate, formatSize } from "../fileTypes";
import { useStore } from "../state/store";

/** Adds a user-selected folder (with confirmation for broad locations) and scans it. */
export async function addFolderFlow() {
  const st = useStore.getState();
  try {
    const picked = await open({ directory: true, multiple: false, title: "Choose a folder to visualize" });
    if (typeof picked !== "string") return;
    let res = await api.addRoot(picked, false);
    if (res.status === "needsConfirmation") {
      const ok = await st.ask({ title: "Scan a broad location?", body: res.message ?? "", confirmLabel: "Scan anyway" });
      if (!ok) return;
      res = await api.addRoot(picked, true);
    }
    if (res.rootId != null) {
      await useStore.getState().refresh();
      if (useStore.getState().scanning) {
        st.notify("info", "Folder added. Start its scan when the current scan finishes.");
      } else {
        await api.startScan([res.rootId]);
        useStore.setState({ scanning: true });
      }
    }
  } catch (e) {
    st.notify("error", errorMessage(e));
  }
}

export function SourcesPanel() {
  const { roots, scanning, progress, lastOutcome, stats, notify, ask, refresh } = useStore();

  const scan = async (ids: number[]) => {
    try {
      await api.startScan(ids);
      useStore.setState({ scanning: true });
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  const remove = async (id: number, path: string) => {
    const ok = await ask({
      title: "Remove from index?",
      body: `“${path}” will be removed from Globe File Explorer's index.\n\nNo files on disk are deleted or changed.`,
      confirmLabel: "Remove from index",
    });
    if (!ok) return;
    try {
      await api.removeRoot(id);
      await refresh();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  return (
    <aside className="panel sources">
      <div className="panel-head">
        <h3>Scan folders</h3>
        <button className="icon-btn" title="Close" onClick={() => useStore.setState({ panel: "none" })}>
          ×
        </button>
      </div>
      <p className="muted small">
        Only folders you add here are indexed, read-only, using file metadata. System folders, application data, credential stores and
        private keys are always skipped.
      </p>
      <div className="root-list">
        {roots.length === 0 && <div className="empty">No folders yet.</div>}
        {roots.map((r) => (
          <div key={r.id} className="root">
            <div className="root-path" title={r.path}>
              {r.path}
            </div>
            <div className="root-meta">
              <span className={`status ${r.status}`}>{r.status}</span>
              {r.entry && (
                <span>
                  {formatSize(r.entry.size)} · {formatCount(r.entry.fileCount)} files
                </span>
              )}
              {r.lastScan && <span className="muted">scanned {formatDate(r.lastScan)}</span>}
            </div>
            {r.message && <div className="root-msg">{r.message}</div>}
            <div className="root-actions">
              <button className="btn small" disabled={scanning} onClick={() => scan([r.id])}>
                Rescan
              </button>
              <button className="btn small subtle" disabled={scanning} onClick={() => remove(r.id, r.path)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="row">
        <button className="btn primary" onClick={addFolderFlow}>
          + Add folder…
        </button>
        {roots.length > 1 && (
          <button className="btn" disabled={scanning} onClick={() => scan(roots.map((r) => r.id))}>
            Rescan all
          </button>
        )}
      </div>

      {(scanning || progress) && (
        <div className="scan-box">
          <div className="scan-title">
            {scanning ? `Scanning (${progress?.phase ?? "starting"})` : `Last scan: ${progress?.phase}`}
            {scanning && (
              <button className="btn small subtle" onClick={() => api.cancelScan()}>
                Cancel
              </button>
            )}
          </div>
          {progress && (
            <>
              <div className="scan-stats">
                {formatCount(progress.files)} files · {formatCount(progress.dirs)} folders · {formatSize(progress.bytes)}
                <br />
                {formatCount(progress.skipped)} excluded · {formatCount(progress.links)} links not followed · {formatCount(progress.errors)} errors
                · {(progress.elapsedMs / 1000).toFixed(1)}s
              </div>
              {scanning && <div className="scan-current">{progress.current}</div>}
              {scanning && <div className="bar indeterminate" />}
            </>
          )}
        </div>
      )}
      {lastOutcome && lastOutcome.errorSamples.length > 0 && (
        <details className="errors">
          <summary>{lastOutcome.errorSamples.length} unreadable locations (first shown)</summary>
          <ul>
            {lastOutcome.errorSamples.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      )}
      {stats && (
        <div className="muted small stats">
          Index: {formatCount(stats.files)} files · {formatCount(stats.dirs)} folders · {formatSize(stats.totalSize)}
        </div>
      )}
    </aside>
  );
}
