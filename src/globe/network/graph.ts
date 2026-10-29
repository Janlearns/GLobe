/**
 * Network Mode data: a lazily loaded slice of the real folder tree (from the
 * same index the planet view uses), laid out as a radial tree on a sphere.
 * Folders are hubs, files hang off their folder, every edge is a real
 * parent -> child relation. Kept outside React; the scene subscribes.
 */
import { api } from "../../api";
import type { ChildPage, Entry, LocateStep, RootInfo } from "../../types";
import { innerRect, squarify, type Rect } from "../layout";

export const NET_PAGE = 64;
const HARD_CAP = 9000;

/** Shell radii: folders float a little above files. */
export const R_DIR = 1.012;
export const R_FILE = 1.0;

export interface NetNode {
  entry: Entry;
  /** Index of the parent node, -1 for roots. */
  parent: number;
  depth: number;
  children: number[];
  /** Children have been listed (first page at least). */
  loaded: boolean;
  /** Seconds (performance clock) when the node appeared, for fade-in. */
  born: number;
}

export interface NetGraph {
  nodes: NetNode[];
  byId: Map<number, number>;
  /** Unit directions (n*3), recomputed whenever the graph changes. */
  dirs: Float32Array;
  version: number;
}

let graph: NetGraph = { nodes: [], byId: new Map(), dirs: new Float32Array(0), version: 0 };
let loadedFor: RootInfo[] | null = null;
let loadSeq = 0;
const listeners = new Set<() => void>();

export const netGraph = () => graph;
export const graphVersion = () => graph.version;
export function subscribeGraph(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function publish(g: NetGraph) {
  if (g !== graph) return;
  g.dirs = layoutNetwork(g.nodes);
  g.version++;
  listeners.forEach((l) => l());
}

const now = () => performance.now() / 1000;

function addNode(g: NetGraph, entry: Entry, parent: number): number {
  const known = g.byId.get(entry.id);
  if (known != null) return known;
  const idx = g.nodes.length;
  g.nodes.push({ entry, parent, depth: parent < 0 ? 0 : g.nodes[parent].depth + 1, children: [], loaded: false, born: now() });
  g.byId.set(entry.id, idx);
  if (parent >= 0) g.nodes[parent].children.push(idx);
  return idx;
}

/** Adds a listed page under `parent`: every folder, and up to `maxFiles` files. */
function addPage(g: NetGraph, parent: number, page: ChildPage, maxFiles: number): number[] {
  const newDirs: number[] = [];
  let files = g.nodes[parent].children.filter((c) => g.nodes[c].entry.kind !== "dir").length;
  for (const e of page.items) {
    if (g.nodes.length >= HARD_CAP) break;
    if (e.kind === "dir") {
      const had = g.byId.has(e.id);
      const i = addNode(g, e, parent);
      if (!had && e.fileCount + e.dirCount > 0) newDirs.push(i);
    } else if (files < maxFiles && !g.byId.has(e.id)) {
      addNode(g, e, parent);
      files++;
    }
  }
  if (page.offset === 0) g.nodes[parent].loaded = true;
  return newDirs;
}

/**
 * Loads the network for `roots`: every root folder and its first page of
 * items. Deeper folders load when they are opened (clicked or searched).
 */
export async function loadNetwork(roots: RootInfo[], force = false): Promise<void> {
  if (!force && loadedFor === roots) return;
  loadedFor = roots;
  const seq = ++loadSeq;
  const g: NetGraph = { nodes: [], byId: new Map(), dirs: new Float32Array(0), version: graph.version };
  graph = g;
  for (const r of roots) if (r.entry) addNode(g, r.entry, -1);
  publish(g);
  const rootIdx = g.nodes.map((_, i) => i);
  const pages = await Promise.all(rootIdx.map((i) => api.listChildren(g.nodes[i].entry.id, 0, NET_PAGE).catch(() => null)));
  if (seq !== loadSeq) return;
  rootIdx.forEach((i, k) => {
    const page = pages[k];
    if (page) addPage(g, i, page, NET_PAGE);
  });
  publish(g);
}

/** Lists a folder's first page (all of it) if that has not happened yet. */
export async function expandNode(idx: number): Promise<void> {
  const g = graph;
  const n = g.nodes[idx];
  if (!n || n.entry.kind !== "dir" || n.loaded) return;
  const page = await api.listChildren(n.entry.id, 0, NET_PAGE);
  if (g !== graph) return;
  addPage(g, idx, page, NET_PAGE);
  publish(g);
}

/**
 * Makes sure every folder on the way to the last step is in the graph,
 * loading the page that holds each next step. Returns the target's index.
 */
export async function ensurePath(steps: LocateStep[]): Promise<number> {
  const g = graph;
  let idx = g.byId.get(steps[0]?.entry.id ?? -1);
  if (idx == null) return -1;
  let changed = false;
  for (let i = 1; i < steps.length; i++) {
    const { entry } = steps[i];
    let next = g.byId.get(entry.id);
    if (next == null) {
      const offset = Math.floor(steps[i].rank / NET_PAGE) * NET_PAGE;
      const page = await api.listChildren(g.nodes[idx].entry.id, offset, NET_PAGE);
      if (g !== graph) return -1;
      addPage(g, idx, page, offset === 0 ? NET_PAGE : 0);
      next = g.byId.get(entry.id) ?? addNode(g, entry, idx);
      changed = true;
    }
    idx = next;
  }
  if (changed) publish(g);
  return idx;
}

/** Ancestors of a node, root first, the node itself last. */
export function pathTo(idx: number): number[] {
  const out: number[] = [];
  for (let i = idx; i >= 0; i = graph.nodes[i].parent) out.unshift(i);
  return out;
}

/**
 * What the globe shows, like a tree in Explorer: the root folders and their
 * sub-folders, plus the contents of every opened folder. Opened = the
 * selected folder and the folders above it (not the roots, whose files only
 * show when the root itself is selected).
 */
export function visibleNodes(nodes: NetNode[], selected: number): Uint8Array {
  const v = new Uint8Array(nodes.length);
  nodes.forEach((n, i) => {
    if (n.depth === 0 || (n.depth === 1 && n.entry.kind === "dir")) v[i] = 1;
  });
  const open = (i: number) => {
    v[i] = 1;
    for (const c of nodes[i].children) v[c] = 1;
  };
  if (selected >= 0 && selected < nodes.length) {
    if (nodes[selected].entry.kind === "dir") open(selected);
    for (let a = nodes[selected].parent; a >= 0; a = nodes[a].parent) if (nodes[a].depth >= 1) open(a);
    v[selected] = 1;
  }
  return v;
}

/* ---------------------------------------------------------------- layout */

/**
 * The whole sphere, nearly pole to pole, in equal-area (lon, sin lat) space:
 * equal rect areas are equal areas on the globe.
 */
const NET_WORLD: Rect = { lon0: -Math.PI, lon1: Math.PI, z0: -0.985, z1: 0.985 };

/** Room a sub-folder gets: busier subtrees get more. */
const folderWeight = (e: Entry) => 1 + Math.sqrt(e.fileCount + 3 * e.dirCount);

/** Small deterministic hash in [0, 1) from an entry id. */
export const hash01 = (id: number) => {
  let x = (id ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

function setDir(out: Float32Array, i: number, lon: number, z: number) {
  const c = Math.sqrt(Math.max(0, 1 - z * z));
  out[i * 3] = c * Math.sin(lon);
  out[i * 3 + 1] = z;
  out[i * 3 + 2] = c * Math.cos(lon);
}

/**
 * Unit direction of every node. The sphere is split between the roots, and
 * every folder's region is split again (equal-area treemap) between its
 * sub-folders and a "home" tile where the folder itself sits with its files
 * scattered around it. So the network covers the whole globe, every link is
 * a real parent -> child relation, and the weights come from the index (not
 * from what is loaded), so loading more never moves existing folders.
 */
export function layoutNetwork(nodes: NetNode[]): Float32Array {
  const out = new Float32Array(nodes.length * 3);
  const roots = nodes.map((n, i) => (n.parent < 0 ? i : -1)).filter((i) => i >= 0);
  if (roots.length === 0) return out;

  const visit = (i: number, rect: Rect) => {
    const n = nodes[i];
    const dirs = n.children.filter((ch) => nodes[ch].entry.kind === "dir");
    const files = n.children.filter((ch) => nodes[ch].entry.kind !== "dir");
    // Files directly in this folder, from the index (not just the loaded ones).
    const direct = Math.max(files.length, n.entry.fileCount - dirs.reduce((s, ch) => s + nodes[ch].entry.fileCount, 0));
    const home = { key: "home", weight: 1 + Math.sqrt(direct) * 0.8, data: -1 };
    const tiles = dirs.length
      ? squarify([home, ...dirs.map((ch) => ({ key: String(ch), weight: folderWeight(nodes[ch].entry), data: ch }))], innerRect(rect, 0.06))
      : [{ key: "home", rect, data: -1 }];
    for (const t of tiles) {
      if (t.data >= 0) {
        visit(t.data, t.rect);
        continue;
      }
      // Home tile: the folder in the middle, its files spread evenly around
      // it (a low-discrepancy sequence, so they never clump).
      const r = innerRect(t.rect, 0.12);
      const lonC = (r.lon0 + r.lon1) / 2;
      const zC = (r.z0 + r.z1) / 2;
      setDir(out, i, lonC, zC);
      const jitter = hash01(n.entry.id);
      files.forEach((f, j) => {
        const u = (jitter + (j + 1) * 0.7548776662) % 1;
        const v = (jitter * 0.5 + (j + 1) * 0.5698402910) % 1;
        // Pull a little towards the folder so the cluster reads as a star.
        const k = 0.82;
        setDir(out, f, lonC + (r.lon0 + u * (r.lon1 - r.lon0) - lonC) * k, zC + (r.z0 + v * (r.z1 - r.z0) - zC) * k);
      });
    }
  };

  const top = roots.length === 1
    ? [{ key: "root", rect: NET_WORLD, data: roots[0] }]
    : squarify(roots.map((ri) => ({ key: String(ri), weight: folderWeight(nodes[ri].entry), data: ri })), NET_WORLD);
  for (const t of top) visit(t.data, t.rect);
  return out;
}

/**
 * Camera framing for an opened folder: the middle of the folder and its
 * contents, and a distance at which all of it fits on screen.
 */
export function branchView(idx: number): { point: [number, number, number]; dist: number } | null {
  const g = graph;
  const n = g.nodes[idx];
  if (!n) return null;
  const ids = [idx, ...n.children];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of ids) {
    x += g.dirs[i * 3];
    y += g.dirs[i * 3 + 1];
    z += g.dirs[i * 3 + 2];
  }
  const l = Math.hypot(x, y, z);
  if (l < 1e-6) return { point: [g.dirs[idx * 3], g.dirs[idx * 3 + 1], g.dirs[idx * 3 + 2]], dist: 3.4 };
  const c: [number, number, number] = [x / l, y / l, z / l];
  let spread = 0;
  for (const i of ids) {
    const d = c[0] * g.dirs[i * 3] + c[1] * g.dirs[i * 3 + 1] + c[2] * g.dirs[i * 3 + 2];
    spread = Math.max(spread, Math.acos(Math.max(-1, Math.min(1, d))));
  }
  return { point: c, dist: Math.max(1.6, Math.min(3.6, 1.45 + spread * 1.9)) };
}

/** World-space (globe-local) position of a node: its direction on its shell. */
export function nodePosition(idx: number): [number, number, number] | null {
  const g = graph;
  if (idx < 0 || idx >= g.nodes.length) return null;
  const r = g.nodes[idx].entry.kind === "dir" ? R_DIR : R_FILE;
  return [g.dirs[idx * 3] * r, g.dirs[idx * 3 + 1] * r, g.dirs[idx * 3 + 2] * r];
}
