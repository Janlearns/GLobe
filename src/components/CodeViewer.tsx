import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api";
import { formatSize } from "../fileTypes";
import { useStore } from "../state/store";
import type { TextFile } from "../types";
import { highlight, makeTokenizer } from "./highlight";
import { NotebookView, notebookCode, parseNotebook, type Notebook } from "./NotebookView";
import { openTerminal, runCommandFor } from "./workbench";

/** Lines highlighted at most; the rest of a huge file is shown as plain text. */
const HIGHLIGHT_LINES = 4000;

export function CodeViewer() {
  const e = useStore((s) => s.codeView);
  const notify = useStore((s) => s.notify);
  const [file, setFile] = useState<TextFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    setFile(null);
    setError(null);
    setRaw(false);
    if (!e) return;
    let alive = true;
    api
      .readTextFile(e.id)
      .then((f) => alive && setFile(f))
      .catch((err) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [e]);

  useEffect(() => {
    if (!e) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopImmediatePropagation();
        useStore.setState({ codeView: null });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [e]);

  const isNotebook = e?.ext.toLowerCase() === "ipynb";
  const notebook = useMemo<{ nb: Notebook } | { error: string } | null>(() => {
    if (!isNotebook || !file) return null;
    try {
      return { nb: parseNotebook(file.text) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }, [isNotebook, file]);
  const showNotebook = notebook && "nb" in notebook && !raw;

  const lines = useMemo(() => (file ? file.text.replace(/\r\n?/g, "\n").split("\n") : []), [file]);
  const body = useMemo(() => {
    if (!e || !file) return null;
    const re = makeTokenizer(e.ext.toLowerCase());
    const head = lines.slice(0, HIGHLIGHT_LINES).map((l, i) => highlight(l, re, i));
    const rest = lines.length > HIGHLIGHT_LINES ? lines.slice(HIGHLIGHT_LINES).join("\n") : "";
    return (
      <>
        {head}
        {rest}
      </>
    );
  }, [e, file, lines]);

  if (!e) return null;
  const run = runCommandFor(e);
  const close = () => useStore.setState({ codeView: null });

  return (
    <div className="modal-backdrop code-backdrop" onClick={close}>
      <div className="code-viewer" role="dialog" aria-label={`Code: ${e.name}`} onClick={(ev) => ev.stopPropagation()}>
        <header className="code-head">
          <button className="btn small back-btn" title="Back (Esc)" onClick={close}>
            ← Back
          </button>
          <div className="code-title">
            <strong>{e.name}</strong>
            <span className="muted small" title={e.path}>
              {e.path}
            </span>
          </div>
          <div className="row tight">
            {file && (
              <span className="muted small">
                {notebook && "nb" in notebook
                  ? `${notebook.nb.cells.length.toLocaleString()} cells · ${notebook.nb.language}`
                  : `${lines.length.toLocaleString()} lines`}{" "}
                · {formatSize(file.size)} · read-only
              </span>
            )}
            {notebook && "nb" in notebook && (
              <button className={`btn small ${raw ? "on" : ""}`} title="Show the notebook's raw JSON" onClick={() => setRaw(!raw)}>
                {raw ? "Notebook" : "Raw"}
              </button>
            )}
            {file && (
              <button
                className="btn small"
                title={showNotebook ? "Copy the code of every cell" : "Copy the whole file"}
                onClick={() =>
                  navigator.clipboard.writeText(showNotebook && notebook && "nb" in notebook ? notebookCode(notebook.nb) : file.text).then(
                    () => notify("info", "Code copied"),
                    (err) => notify("error", errorMessage(err)),
                  )
                }
              >
                Copy
              </button>
            )}
            {run && e.parentId != null && (
              <button
                className="btn small primary"
                title={`Opens a terminal in this folder with "${run}" typed in, ready for you to press Enter`}
                onClick={async () => {
                  const dir = await api.getEntry(e.parentId!).catch(() => null);
                  if (!dir) return;
                  close();
                  await openTerminal(dir, "powershell", run);
                }}
              >
                ▶ Run in terminal
              </button>
            )}
            <button className="icon-btn" title="Close (Esc)" onClick={close}>
              ×
            </button>
          </div>
        </header>
        {error ? (
          <p className="code-msg">{error}</p>
        ) : !file ? (
          <p className="code-msg muted">Loading…</p>
        ) : showNotebook ? (
          <div className="code-scroll nb-scroll">
            <NotebookView nb={(notebook as { nb: Notebook }).nb} />
          </div>
        ) : (
          <div className="code-scroll">
            <pre className="code-gutter" aria-hidden>
              {lines.map((_, i) => i + 1).join("\n")}
            </pre>
            <pre className="code-text">{body}</pre>
          </div>
        )}
        {notebook && "error" in notebook && <p className="code-note">{notebook.error} Showing the raw file instead.</p>}
        {file?.truncated && !isNotebook && <p className="code-note">Only the first 1 MB of this file is shown.</p>}
      </div>
    </div>
  );
}
