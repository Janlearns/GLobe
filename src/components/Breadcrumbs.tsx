import { PAGE_SIZE } from "../globe/layout";
import { useStore } from "../state/store";
import { BackButton } from "./NetworkUI";

export function Breadcrumbs() {
  const { chain, goToLevel, goUp } = useStore();
  return (
    <nav className="crumbs" aria-label="Location">
      <BackButton disabled={chain.length === 0} />
      <button className="icon-btn" title="Up one level (Alt+↑)" disabled={chain.length === 0} onClick={() => goUp()}>
        ↑
      </button>
      <button className={`crumb ${chain.length === 0 ? "current" : ""}`} onClick={() => goToLevel(0)}>
        Overview
      </button>
      {chain.map((c, i) => (
        <span key={`${c.entry.id}@${c.offset}`} className="crumb-wrap">
          <span className="sep">›</span>
          <button
            className={`crumb ${i === chain.length - 1 ? "current" : ""}`}
            title={c.entry.path}
            onClick={() => (i === chain.length - 1 ? undefined : goToLevel(i + 1))}
          >
            {i === 0 ? c.entry.path : c.entry.name}
            {c.offset > 0 && <span className="page"> · page {c.offset / PAGE_SIZE + 1}</span>}
          </button>
        </span>
      ))}
    </nav>
  );
}
