import { api, errorMessage } from "../api";
import { CATEGORY_LABELS, categoryColor, formatCount, formatDate, formatSize } from "../fileTypes";
import { useStore } from "../state/store";
import type { Entry } from "../types";
import { FolderContents } from "./NetworkUI";
import { openCodeView, openTerminal, runCommandFor } from "./workbench";

function parentOf(path: string): string {
  const i = path.lastIndexOf("\\");
  return i > 0 ? path.slice(0, i) : path;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    useStore.getState().notify("info", `${what} copied`);
  } catch (e) {
    useStore.getState().notify("error", `Copy failed: ${errorMessage(e)}`);
  }
}

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    useStore.getState().notify("error", errorMessage(e));
  }
}

export function InfoPanel() {
  const selected = useStore((s) => s.selected);
  if (!selected) return null;
  return <Details e={selected} />;
}

/** Categories that run code; opening them requires "Allow launching programs". */
const RUNS_CODE = new Set(["executable", "script", "installer", "shortcut"]);

function Details({ e }: { e: Entry }) {
  const { ask, revealEntry } = useStore();
  const allowLaunch = useStore((s) => s.settings?.allowLaunch ?? false);
  const isDir = e.kind === "dir";
  const network = useStore((s) => s.viewMode === "network");
  const runsCode = RUNS_CODE.has(e.category) || (e.kind === "file" && !e.ext);

  const openFile = async () => {
    const ok = await ask({
      title: "Open file?",
      body: `“${e.name}” will be opened with its default Windows application.\n\n${e.path}`,
      confirmLabel: "Open file",
    });
    if (ok) await run(() => api.openFile(e.id, true));
  };

  const runProgram = async () => {
    const ok = await ask({
      title: `Run this ${e.category === "shortcut" ? "shortcut" : e.category || "file"}?`,
      body:
        `“${e.name}” will be run on your computer.\n\n${e.path}\n\n` +
        "Only continue if you trust this file and know where it came from. It runs without administrator rights; Windows may still " +
        "show its own SmartScreen or UAC prompt.",
      confirmLabel: "Run it",
      danger: true,
    });
    if (ok) await run(() => api.openFile(e.id, true));
  };

  return (
    <aside className="panel info">
      <div className="info-head">
        <span className="type-chip" style={{ borderColor: categoryColor(e.category), color: categoryColor(e.category) }}>
          {isDir ? "Folder" : e.kind === "link" ? "Link" : e.ext ? `.${e.ext}` : "File"}
        </span>
        <button className="icon-btn" title="Close" onClick={() => useStore.setState({ selected: null, selectedKey: null, highlightKey: null })}>
          ×
        </button>
      </div>
      <h2 className="info-name" title={e.name}>
        {e.name}
      </h2>
      {network && isDir && <FolderContents id={e.id} />}
      <dl className="meta">
        <dt>Type</dt>
        <dd>{CATEGORY_LABELS[e.category] ?? e.category}</dd>
        <dt>Size</dt>
        <dd>
          {formatSize(e.size)} <span className="muted">({formatCount(e.size)} bytes)</span>
        </dd>
        {isDir && (
          <>
            <dt>Contains</dt>
            <dd>
              {formatCount(e.fileCount)} files · {formatCount(e.dirCount)} folders
            </dd>
          </>
        )}
        <dt>Modified</dt>
        <dd>{formatDate(e.modified)}</dd>
        <dt>Created</dt>
        <dd>{formatDate(e.created)}</dd>
        <dt>Folder</dt>
        <dd className="path" title={parentOf(e.path)}>
          {parentOf(e.path)}
        </dd>
        <dt>Full path</dt>
        <dd className="path selectable">{e.path}</dd>
      </dl>
      {e.kind === "link" && <p className="note">Symbolic link or junction. It is shown but never followed or opened.</p>}
      <div className="actions">
        {isDir && (
          <div className="row tight">
            <button className="btn primary grow" title="Open PowerShell in this folder" onClick={() => openTerminal(e, "powershell")}>
              ›_ Terminal here
            </button>
            <button className="btn" title="Open Command Prompt in this folder" onClick={() => openTerminal(e, "cmd")}>
              CMD
            </button>
          </div>
        )}
        {e.kind === "file" && (
          <button className="btn primary" title="Read the file in the built-in code viewer (read-only)" onClick={() => openCodeView(e)}>
            {"</>"} View code
          </button>
        )}
        {e.kind === "file" && e.parentId != null && runCommandFor(e) && (
          <button
            className="btn"
            title={`Opens a terminal in the file's folder with "${runCommandFor(e)}" typed in, ready for you to press Enter`}
            onClick={() => run(async () => openTerminal(await api.getEntry(e.parentId!), "powershell", runCommandFor(e)!))}
          >
            ▶ Run in terminal
          </button>
        )}
        <button className={`btn ${isDir || e.kind === "file" ? "" : "primary"}`} onClick={() => run(() => api.revealInExplorer(e.id))}>
          Reveal in Explorer
        </button>
        <button className="btn" onClick={() => run(() => api.openContainingFolder(e.id))}>
          {isDir ? "Open folder" : "Open containing folder"}
        </button>
        <button className="btn" onClick={() => copy(e.path, "Full path")}>
          Copy path
        </button>
        <button className="btn" onClick={() => copy(e.name, "Name")}>
          Copy name
        </button>
        {!isDir && e.parentId != null && (
          <button className="btn" onClick={() => run(async () => revealEntry(await api.getEntry(e.parentId!)))}>
            Show parent on globe
          </button>
        )}
        {e.kind === "file" && !runsCode && (
          <button className="btn subtle" onClick={openFile}>
            Open with default app…
          </button>
        )}
        {e.kind === "file" && runsCode && allowLaunch && (
          <button className="btn danger" onClick={runProgram}>
            Run {e.category === "shortcut" ? "shortcut" : "program"}…
          </button>
        )}
        {e.kind === "file" && runsCode && !allowLaunch && (
          <p className="note">This file can run code. Running it is turned off; enable “Allow launching programs” in Security settings.</p>
        )}
      </div>
    </aside>
  );
}
