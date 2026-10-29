/**
 * Read-only Jupyter notebook (.ipynb) view: markdown cells, code cells with
 * syntax colouring, and their saved outputs (text, errors, images).
 *
 * Nothing from the notebook is ever run or inserted as HTML: HTML outputs
 * (e.g. pandas tables) fall back to their plain-text version, markdown is
 * rendered by a tiny React renderer, and images are shown as <img> data URIs
 * (which cannot run scripts, SVG included).
 */
import { useMemo, type ReactNode } from "react";
import { errorMessage } from "../api";
import { useStore } from "../state/store";
import { highlight, makeTokenizer } from "./highlight";

type Source = string | string[];
const joinSrc = (s: Source | undefined) => (Array.isArray(s) ? s.join("") : (s ?? ""));

interface Output {
  output_type: string;
  name?: string;
  text?: Source;
  data?: Record<string, Source>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface Cell {
  cell_type: string;
  source: Source;
  execution_count?: number | null;
  outputs?: Output[];
}

export interface Notebook {
  cells: Cell[];
  language: string;
}

/** Parses notebook JSON; throws a readable error when it is not one. */
export function parseNotebook(text: string): Notebook {
  let nb: { cells?: Cell[]; metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } };
  try {
    nb = JSON.parse(text);
  } catch {
    throw new Error("This notebook could not be read (it is not valid JSON, or it is larger than 32 MB).");
  }
  if (!Array.isArray(nb.cells)) throw new Error("This file has no notebook cells.");
  const language = (nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? "python").toLowerCase();
  return { cells: nb.cells, language };
}

const LANG_EXT: Record<string, string> = { python: "py", r: "r", julia: "jl", javascript: "js", typescript: "ts", scala: "scala", bash: "sh" };

// Terminal colour codes in tracebacks.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/* ------------------------------------------------------------ markdown */

/** Inline markdown: `code`, **bold**, *italic*, [links] (shown as text). */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(!?\[([^\]]*)\]\(([^)]*)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const id = `${key}-${k++}`;
    if (m[1]) out.push(<code key={id}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={id}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={id}>{m[3].slice(1, -1)}</em>);
    else
      out.push(
        <span key={id} className="nb-link" title={m[6]}>
          {m[4].startsWith("!") ? `[image: ${m[5] || m[6]}]` : m[5]}
        </span>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text, id }: { text: string; id: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `${id}-${k++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={key} className="nb-md-code">{body.join("\n")}</pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const H = `h${Math.min(6, level + 1)}` as "h2";
      blocks.push(<H key={key}>{inline(line.replace(/^#+\s*/, ""), key)}</H>);
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        items.push(<li key={i}>{inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""), `${key}-${i}`)}</li>);
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    } else if (/^>\s?/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(body.join(" "), key)}</blockquote>);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push(<p key={key}>{inline(body.join(" "), key)}</p>);
    }
  }
  return <div className="nb-md">{blocks}</div>;
}

/* ------------------------------------------------------------ outputs */

function OutputView({ o, id }: { o: Output; id: string }) {
  if (o.output_type === "stream") {
    return <pre className={`nb-out ${o.name === "stderr" ? "nb-err" : ""}`}>{stripAnsi(joinSrc(o.text))}</pre>;
  }
  if (o.output_type === "error") {
    const tb = o.traceback?.length ? o.traceback.map(stripAnsi).join("\n") : `${o.ename}: ${o.evalue}`;
    return <pre className="nb-out nb-err">{tb}</pre>;
  }
  const d = o.data ?? {};
  for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
    if (d[mime]) return <img className="nb-img" alt="output" src={`data:${mime};base64,${joinSrc(d[mime]).replace(/\s/g, "")}`} />;
  }
  if (d["image/svg+xml"]) {
    // As an <img>, an SVG cannot run scripts.
    return <img className="nb-img" alt="output" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(joinSrc(d["image/svg+xml"]))}`} />;
  }
  if (d["text/markdown"]) return <Markdown text={joinSrc(d["text/markdown"])} id={id} />;
  if (d["text/plain"]) return <pre className="nb-out">{stripAnsi(joinSrc(d["text/plain"]))}</pre>;
  if (d["text/html"]) return <p className="muted small">HTML output (not shown for safety; no plain-text version was saved).</p>;
  return null;
}

/* ------------------------------------------------------------ notebook */

export function NotebookView({ nb }: { nb: Notebook }) {
  const notify = useStore((s) => s.notify);
  const re = useMemo(() => makeTokenizer(LANG_EXT[nb.language] ?? "py"), [nb.language]);
  return (
    <div className="nb">
      {nb.cells.map((c, i) => {
        const src = joinSrc(c.source);
        if (c.cell_type === "markdown") return <Markdown key={i} text={src} id={`c${i}`} />;
        if (c.cell_type !== "code") return <pre key={i} className="nb-raw">{src}</pre>;
        return (
          <div key={i} className="nb-cell">
            <div className="nb-in">
              <span className="nb-count">[{c.execution_count ?? " "}]</span>
              <pre className="nb-code">{src.replace(/\r\n?/g, "\n").split("\n").map((l, j) => highlight(l, re, j))}</pre>
              <button
                className="icon-btn nb-copy"
                title="Copy this cell"
                onClick={() =>
                  navigator.clipboard.writeText(src).then(
                    () => notify("info", "Cell copied"),
                    (e) => notify("error", errorMessage(e)),
                  )
                }
              >
                ⧉
              </button>
            </div>
            {c.outputs && c.outputs.length > 0 && (
              <div className="nb-outputs">
                {c.outputs.map((o, j) => (
                  <OutputView key={j} o={o} id={`c${i}o${j}`} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** All code cells, for "Copy". */
export function notebookCode(nb: Notebook): string {
  return nb.cells
    .filter((c) => c.cell_type === "code")
    .map((c) => joinSrc(c.source))
    .join("\n\n");
}
