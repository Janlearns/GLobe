import { create } from "zustand";
import { api, errorMessage } from "../api";
import { flyTo, flyToRect, systemH } from "../globe/camera";
import { WORLD_RECT, angularSize, rectCenter } from "../globe/layout";
import {
  buildLayers,
  chainFromSteps,
  clearModelCache,
  getRect,
  type ChainItem,
  type Layer,
  type Tile,
} from "../globe/model";
import { branchView, ensurePath, expandNode, loadNetwork, netGraph, nodePosition } from "../globe/network/graph";
import { focusNetPoint, netView, resetNetView } from "../globe/network/view";
import type { TerminalShell } from "../types";
import type { DesktopInfo, DesktopMode, Entry, IndexStats, NowPlaying, RootInfo, ScanOutcome, ScanProgress, SecuritySettings } from "../types";

export type ViewMode = "planet" | "network";

/** Per-viewer UI preferences that survive restarts (storage may be unavailable). */
function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** The docked terminal: a session in `dir`; `run` bumps to start a new one. */
export interface TerminalState {
  dir: Entry;
  shell: TerminalShell;
  run: number;
  /** A command typed into the input (never sent until the user presses Enter). */
  prefill: { text: string; n: number } | null;
}

export interface Notice {
  id: number;
  kind: "info" | "error";
  text: string;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface State {
  roots: RootInfo[];
  stats: IndexStats | null;
  chain: ChainItem[];
  layers: Layer[];
  focusSize: number;
  selected: Entry | null;
  selectedKey: string | null;
  highlightKey: string | null;
  hovered: { tile: Tile; planet: number; x: number; y: number } | null;

  query: string;
  results: Entry[];
  searching: boolean;
  resultsOpen: boolean;

  scanning: boolean;
  progress: ScanProgress | null;
  lastOutcome: ScanOutcome | null;

  settings: SecuritySettings | null;
  lowPower: boolean;
  reducedMotion: boolean;
  panel: "none" | "sources" | "security" | "desktop" | "music";
  nowPlaying: NowPlaying | null;
  desktopMode: DesktopMode;
  covered: boolean;
  desktopInfo: DesktopInfo | null;
  notices: Notice[];
  confirm: ConfirmRequest | null;

  viewMode: ViewMode;
  /** File shown in the code viewer. */
  codeView: Entry | null;
  terminal: TerminalState | null;
  /** Network Mode: idle auto-rotation on/off. */
  netRotate: boolean;
  /** Network Mode: glow / line / particle brightness, 0.2..1.5. */
  netIntensity: number;
  /** Network Mode: node index under the cursor. */
  netHover: number | null;
  /** Network Mode: earlier selections, newest last, for "Back". */
  backStack: Entry[];
  /** Network Mode: last node revealed by search (drives the ripple). */
  netFound: { idx: number; at: number } | null;

  refresh: () => Promise<void>;
  setChain: (chain: ChainItem[], opts?: { fly?: boolean }) => Promise<void>;
  goToLevel: (index: number) => Promise<void>;
  goUp: () => Promise<void>;
  activateTile: (tile: Tile, layer: Layer) => Promise<void>;
  revealEntry: (entry: Entry) => Promise<void>;
  runSearch: (q: string) => Promise<void>;
  notify: (kind: Notice["kind"], text: string) => void;
  ask: (req: Omit<ConfirmRequest, "resolve">) => Promise<boolean>;
  setViewMode: (mode: ViewMode) => void;
  syncNetwork: (force?: boolean) => Promise<void>;
  activateNetNode: (idx: number) => void;
  /** Back: closes the code viewer, else returns to the previous folder / file (Network) or goes up (Planet). */
  goBack: () => void;
}

let noticeId = 1;
/** Set while "Back" re-selects an entry, so that it is not pushed again. */
let restoring = false;

/** Pushes the current selection onto the Back stack before `next` replaces it. */
function remember(next: Entry) {
  if (restoring) return;
  const { selected, backStack } = useStore.getState();
  if (!selected || selected.id === next.id) return;
  useStore.setState({ backStack: [...backStack.filter((e) => e.id !== selected.id), selected].slice(-50) });
}
let buildSeq = 0;
let searchSeq = 0;

export const useStore = create<State>((set, get) => ({
  roots: [],
  stats: null,
  chain: [],
  layers: [],
  focusSize: angularSize(WORLD_RECT),
  selected: null,
  selectedKey: null,
  highlightKey: null,
  hovered: null,
  query: "",
  results: [],
  searching: false,
  resultsOpen: false,
  scanning: false,
  progress: null,
  lastOutcome: null,
  settings: null,
  lowPower: false,
  reducedMotion: typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  panel: "none",
  desktopMode: "window",
  covered: false,
  desktopInfo: null,
  nowPlaying: null,
  notices: [],
  confirm: null,
  viewMode: loadPref<ViewMode>("viewMode", "planet"),
  codeView: null,
  terminal: null,
  netRotate: loadPref("netRotate", true),
  netIntensity: loadPref("netIntensity", 1),
  netHover: null,
  netFound: null,
  backStack: [],

  /** Reloads roots and rebuilds the globe, keeping the current path when possible. */
  refresh: async () => {
    clearModelCache();
    try {
      const [roots, stats] = await Promise.all([api.listRoots(), api.indexStats()]);
      set({ roots, stats });
      // Entry ids change after a rescan, so the view is restored by real path.
      const last = get().chain[get().chain.length - 1];
      let next: ChainItem[] = [];
      if (last) {
        const steps = await api.locatePath(last.entry.path).catch(() => null);
        if (steps) next = chainFromSteps(steps).chain;
      }
      await get().setChain(next, { fly: false });
      const sel = get().selected;
      if (sel) {
        const steps = await api.locatePath(sel.path).catch(() => null);
        const fresh = steps?.[steps.length - 1].entry;
        set(fresh ? { selected: fresh, selectedKey: `e${fresh.id}`, highlightKey: `e${fresh.id}` } : { selected: null, selectedKey: null, highlightKey: null });
      }
    } catch (e) {
      get().notify("error", errorMessage(e));
    }
  },

  setChain: async (chain, opts = {}) => {
    const seq = ++buildSeq;
    try {
      const { layers, focusRect, focusPlanet } = await buildLayers(get().roots, chain);
      if (seq !== buildSeq) return;
      set({ chain, layers, focusSize: angularSize(focusRect), hovered: null });
      if (opts.fly !== false) {
        if (chain.length === 0) {
          const c = rectCenter(WORLD_RECT);
          flyTo({ planet: focusPlanet, lon: c.lon + 0.35, lat: 0.25, h: systemH() });
        } else {
          flyToRect(focusRect, focusPlanet, 0.85);
        }
      }
    } catch (e) {
      if (seq === buildSeq) get().notify("error", `Could not load this region: ${errorMessage(e)}`);
    }
  },

  goToLevel: async (index) => {
    const chain = get().chain.slice(0, index);
    await get().setChain(chain);
  },

  goUp: async () => {
    const chain = get().chain;
    if (chain.length === 0) return;
    const last = chain[chain.length - 1];
    // Leaving an overflow page goes back to the previous page of the same folder.
    const next = last.offset > 0 ? [...chain.slice(0, -1), { entry: last.entry, offset: 0 }] : chain.slice(0, -1);
    await get().setChain(next);
  },

  activateTile: async (tile, layer) => {
    const { chain } = get();
    // Chain prefix that owns `layer` (layers are built world -> focus -> previews).
    const ownerId = layer.key.startsWith("world:") ? null : Number(layer.key.split("@")[0]);
    let prefix: ChainItem[];
    if (ownerId === null) prefix = [];
    else {
      const idx = chain.findIndex((c) => c.entry.id === ownerId);
      if (idx >= 0) {
        prefix = chain.slice(0, idx + 1).map((c, i) => (i === idx ? { ...c, offset: Number(layer.key.split("@")[1]) } : c));
      } else {
        // Preview layer: its owner is a child folder of the current focus.
        const focusLayer = get().layers.find((l) => l.role === "focus");
        const owner = focusLayer?.tiles.find((t) => t.entry?.id === ownerId)?.entry;
        if (!owner) return;
        prefix = [...chain, { entry: owner, offset: 0 }];
      }
    }

    if (tile.more) {
      const owner = prefix[prefix.length - 1];
      await get().setChain([...prefix.slice(0, -1), { entry: owner.entry, offset: tile.more.offset }]);
      return;
    }
    const entry = tile.entry!;
    set({ selected: entry, selectedKey: tile.key, highlightKey: tile.key });
    if (entry.kind === "dir") {
      await get().setChain([...prefix, { entry, offset: 0 }]);
    } else {
      if (prefix.length !== chain.length || prefix.some((c, i) => c.entry.id !== chain[i].entry.id || c.offset !== chain[i].offset)) {
        await get().setChain(prefix, { fly: false });
      }
      const rect = getRect(tile.key);
      if (rect) flyToRect(rect, layer.planet, 0.12);
    }
  },

  /** Navigates the globe to any indexed entry (used by search results). */
  revealEntry: async (entry) => {
    if (get().viewMode === "network") {
      try {
        const steps = await api.locate(entry.id);
        const idx = await ensurePath(steps);
        if (idx < 0) {
          get().notify("error", "That item is not part of the network yet.");
          return;
        }
        const target = steps[steps.length - 1].entry;
        remember(target);
        set({ selected: target, selectedKey: `e${target.id}`, highlightKey: `e${target.id}`, resultsOpen: false, netFound: { idx, at: performance.now() } });
        if (target.kind === "dir") {
          await expandNode(idx);
          const v = branchView(idx);
          if (v) focusNetPoint(v.point, v.dist);
        } else {
          const p = nodePosition(idx);
          if (p) focusNetPoint(p, 1.6);
        }
      } catch (e) {
        get().notify("error", errorMessage(e));
      }
      return;
    }
    try {
      const steps = await api.locate(entry.id);
      const { chain, target } = chainFromSteps(steps);
      set({ selected: target, selectedKey: `e${target.id}`, highlightKey: `e${target.id}`, resultsOpen: false });
      await get().setChain(chain, { fly: target.kind === "dir" });
      if (target.kind !== "dir") {
        const rect = getRect(`e${target.id}`);
        if (rect) flyToRect(rect, target.rootId, 0.12);
      }
    } catch (e) {
      get().notify("error", errorMessage(e));
    }
  },

  runSearch: async (q) => {
    const seq = ++searchSeq;
    set({ query: q });
    if (!q.trim()) {
      set({ results: [], searching: false });
      return;
    }
    set({ searching: true, resultsOpen: true });
    try {
      const results = await api.search(q, 200);
      if (seq === searchSeq) set({ results, searching: false });
    } catch (e) {
      if (seq === searchSeq) set({ results: [], searching: false });
      get().notify("error", errorMessage(e));
    }
  },

  setViewMode: (mode) => {
    savePref("viewMode", mode);
    set({ viewMode: mode, hovered: null, netHover: null });
  },

  /** Loads the network for the current roots and keeps the selection on it. */
  syncNetwork: async (force = false) => {
    try {
      await loadNetwork(get().roots, force);
      const sel = get().selected;
      if (sel && !netGraph().byId.has(sel.id)) await ensurePath(await api.locate(sel.id));
    } catch (e) {
      get().notify("error", `Could not load the network: ${errorMessage(e)}`);
    }
  },

  activateNetNode: (idx) => {
    const node = netGraph().nodes[idx];
    if (!node) return;
    const e = node.entry;
    remember(e);
    set({ selected: e, selectedKey: `e${e.id}`, highlightKey: `e${e.id}` });
    if (e.kind === "dir") {
      // Open the folder, then frame it together with everything inside.
      expandNode(idx)
        .then(() => {
          const v = branchView(idx);
          if (v && get().selected?.id === e.id) focusNetPoint(v.point, v.dist);
        })
        .catch((err) => get().notify("error", errorMessage(err)));
    } else {
      const p = nodePosition(idx);
      if (p) focusNetPoint(p, Math.min(netView.tDist, 1.8));
    }
  },

  goBack: () => {
    const st = get();
    if (st.codeView) {
      set({ codeView: null });
      return;
    }
    if (st.viewMode === "planet") {
      void st.goUp();
      return;
    }
    const stack = st.backStack;
    if (stack.length === 0) {
      // Nothing earlier: back to the overview.
      set({ selected: null, selectedKey: null, highlightKey: null });
      resetNetView();
      return;
    }
    const prev = stack[stack.length - 1];
    set({ backStack: stack.slice(0, -1) });
    restoring = true;
    const idx = netGraph().byId.get(prev.id);
    if (idx != null) {
      st.activateNetNode(idx);
      restoring = false;
    } else {
      // Not loaded any more: find it again (async), still without pushing.
      void st.revealEntry(prev).finally(() => (restoring = false));
    }
  },

  notify: (kind, text) => {
    const id = noticeId++;
    set({ notices: [...get().notices, { id, kind, text }] });
    setTimeout(() => set({ notices: get().notices.filter((n) => n.id !== id) }), kind === "error" ? 8000 : 4000);
  },

  ask: (req) =>
    new Promise<boolean>((resolve) => {
      set({
        confirm: {
          ...req,
          resolve: (ok) => {
            set({ confirm: null });
            resolve(ok);
          },
        },
      });
    }),
}));
