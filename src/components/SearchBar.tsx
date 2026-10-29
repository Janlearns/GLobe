import { useEffect, useRef, useState } from "react";
import { categoryColor, formatSize } from "../fileTypes";
import { useStore } from "../state/store";
import type { Entry } from "../types";

const HINT = "Search files & folders…   try  report  ·  ext:pdf  ·  type:image  ·  kind:dir  ·  in:projects";

export function SearchBar() {
  const { results, searching, resultsOpen, runSearch, revealEntry } = useStore();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Debounced search against the local index.
  useEffect(() => {
    const t = setTimeout(() => runSearch(text), 160);
    return () => clearTimeout(t);
  }, [text, runSearch]);

  useEffect(() => setActive(0), [results]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
        if (text) useStore.setState({ resultsOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [text]);

  const choose = (e: Entry) => {
    revealEntry(e);
    input.current?.blur();
  };

  return (
    <div className="search">
      <div className="search-box">
        <svg viewBox="0 0 24 24" className="search-icon" aria-hidden>
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M16.5 16.5 L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={text}
          placeholder={HINT}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => text && useStore.setState({ resultsOpen: true })}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && results[active]) {
              choose(results[active]);
            } else if (e.key === "Escape") {
              useStore.setState({ resultsOpen: false });
              input.current?.blur();
            }
          }}
        />
        {searching && <span className="spinner" />}
        {text && (
          <button className="icon-btn" title="Clear" onClick={() => setText("")}>
            ×
          </button>
        )}
      </div>
      {resultsOpen && text.trim() && (
        <div className="results">
          <div className="results-head">
            {searching ? "Searching…" : `${results.length}${results.length === 200 ? "+" : ""} result${results.length === 1 ? "" : "s"}`}
            <button className="link-btn" onClick={() => useStore.setState({ resultsOpen: false })}>
              close
            </button>
          </div>
          <div className="results-list">
            {results.map((r, i) => (
              <button
                key={r.id}
                className={`result ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                title={r.path}
              >
                <span className="dot" style={{ background: categoryColor(r.category) }} />
                <span className="result-main">
                  <span className="result-name">
                    {r.kind === "dir" ? "📁 " : ""}
                    {r.name}
                  </span>
                  <span className="result-path">{r.path}</span>
                </span>
                <span className="result-size">{formatSize(r.size)}</span>
              </button>
            ))}
            {!searching && results.length === 0 && <div className="empty">No indexed item matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
