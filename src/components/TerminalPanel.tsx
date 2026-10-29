import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, listenTerminal } from "../api";
import { useStore } from "../state/store";
import { openExternalTerminal } from "./workbench";

/** Printed by the backend whenever the shell is ready; see terminal.rs. */
const MARK = "##GFE-PROMPT##";
const MAX_CHARS = 300_000;

interface Seg {
  text: string;
  kind: "out" | "err" | "cmd";
}

export function TerminalPanel() {
  const term = useStore((s) => s.terminal);
  const notify = useStore((s) => s.notify);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [pending, setPending] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(true);
  const [ended, setEnded] = useState(false);
  const [input, setInput] = useState("");
  const session = useRef<number | null>(null);
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);
  const pendingRef = useRef("");
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  const append = (seg: Seg) =>
    setSegs((cur) => {
      const next = [...cur];
      const last = next[next.length - 1];
      if (last && last.kind === seg.kind) next[next.length - 1] = { ...last, text: last.text + seg.text };
      else next.push(seg);
      // Keep the scrollback bounded.
      let total = next.reduce((s, x) => s + x.text.length, 0);
      while (total > MAX_CHARS && next.length > 1) total -= next.shift()!.text.length;
      return next;
    });

  // One session per `run`; closing or replacing the panel ends it.
  useEffect(() => {
    if (!term) return;
    let alive = true;
    setSegs([]);
    setPending("");
    pendingRef.current = "";
    setCwd(term.dir.path);
    setBusy(true);
    setEnded(false);
    let unlisten: (() => void) | null = null;
    const listening = listenTerminal({
      onOutput: ({ id, data, err }) => {
        if (id !== session.current) return;
        if (err) {
          append({ text: data, kind: "err" });
          return;
        }
        // Complete lines are checked for the prompt marker; the unfinished
        // last line (e.g. "Name? " waiting for input) is shown as it is.
        const text = pendingRef.current + data;
        const parts = text.split(/\r?\n/);
        pendingRef.current = parts.pop() ?? "";
        let out = "";
        for (const line of parts) {
          if (line.startsWith(MARK)) {
            setCwd(line.slice(MARK.length));
            setBusy(false);
            // CMD prints an empty line before each prompt.
            if (out.endsWith("\n\n")) out = out.slice(0, -1);
          } else out += line + "\n";
        }
        if (out) append({ text: out, kind: "out" });
        setPending(pendingRef.current);
      },
      onExit: (id) => {
        if (id !== session.current) return;
        setEnded(true);
        setBusy(false);
      },
    });
    (async () => {
      try {
        // Listen first, so the shell's first prompt is not missed.
        unlisten = await listening;
        if (!alive) return unlisten();
        const id = await api.terminalStart(term.dir.id, term.shell, true);
        if (!alive) return void api.terminalStop(id);
        session.current = id;
      } catch (e) {
        append({ text: errorMessage(e) + "\n", kind: "err" });
        setEnded(true);
      }
    })();
    return () => {
      alive = false;
      if (unlisten) unlisten();
      else void listening.then((f) => f());
      if (session.current != null) void api.terminalStop(session.current);
      session.current = null;
    };
  }, [term?.run]);

  // A command typed in for the user (e.g. "Run in terminal"); never sent automatically.
  useEffect(() => {
    if (!term?.prefill) return;
    setInput(term.prefill.text);
    inputRef.current?.focus();
  }, [term?.prefill?.n]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [segs, pending]);

  if (!term) return null;
  const isPs = term.shell === "powershell";
  const prompt = isPs ? `PS ${cwd}>` : `${cwd}>`;
  const hidePending = MARK.startsWith(pendingRef.current) || pending.startsWith(MARK.slice(0, 4));

  const send = async () => {
    const id = session.current;
    if (id == null || ended) return;
    const line = input;
    append({ text: busy ? `${line}\n` : `${prompt} ${line}\n`, kind: "cmd" });
    if (line.trim()) history.current = [line, ...history.current.filter((h) => h !== line)].slice(0, 100);
    histPos.current = -1;
    setInput("");
    setBusy(true);
    stick.current = true;
    try {
      await api.terminalWrite(id, line);
    } catch (e) {
      notify("error", errorMessage(e));
      setEnded(true);
    }
  };

  const stop = () => {
    if (session.current != null) void api.terminalStop(session.current);
    append({ text: "\n[session stopped]\n", kind: "err" });
    setEnded(true);
    setBusy(false);
  };
  const restart = () => useStore.setState({ terminal: { ...term, run: term.run + 1, prefill: null } });

  return (
    <section className="terminal" aria-label="Terminal">
      <header className="term-head">
        <span className={`term-dot ${ended ? "off" : busy ? "busy" : ""}`} />
        <strong>{isPs ? "PowerShell" : "Command Prompt"}</strong>
        <span className="muted small term-cwd" title={cwd}>
          {cwd}
        </span>
        <div className="row tight">
          {ended ? (
            <button className="btn small" onClick={restart}>
              ↻ Restart
            </button>
          ) : (
            <button className="btn small" title="End this session and everything it started" onClick={stop}>
              ■ Stop
            </button>
          )}
          <button className="btn small" onClick={() => setSegs([])}>
            Clear
          </button>
          <button className="btn small" title="Open a separate terminal window in this folder" onClick={() => openExternalTerminal(term.dir, term.shell)}>
            ↗ Window
          </button>
          <button className="icon-btn" title="Close terminal" onClick={() => useStore.setState({ terminal: null })}>
            ×
          </button>
        </div>
      </header>
      <div
        className="term-out"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        onMouseUp={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        <pre>
          {segs.map((s, i) => (
            <span key={i} className={`term-${s.kind}`}>
              {s.text}
            </span>
          ))}
          {!hidePending && pending}
        </pre>
      </div>
      <form
        className="term-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="term-prompt">{ended ? "ended" : busy ? "›" : prompt}</span>
        <input
          ref={inputRef}
          value={input}
          disabled={ended}
          spellCheck={false}
          autoComplete="off"
          placeholder={ended ? "Session ended — Restart to continue" : busy ? "running… (type input for the program, or Stop)" : "type a command, Enter to run"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              const h = history.current;
              if (!h.length) return;
              e.preventDefault();
              histPos.current = Math.max(-1, Math.min(h.length - 1, histPos.current + (e.key === "ArrowUp" ? 1 : -1)));
              setInput(histPos.current < 0 ? "" : h[histPos.current]);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              inputRef.current?.blur();
            }
          }}
        />
      </form>
    </section>
  );
}
