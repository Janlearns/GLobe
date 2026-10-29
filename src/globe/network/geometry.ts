/**
 * GPU buffers for Network Mode, rebuilt only when the graph changes (never
 * per frame). Nodes, edges and travelling particles are one draw call each.
 */
import * as THREE from "three";
import { categoryColor } from "../../fileTypes";
import { R_DIR, R_FILE, hash01, type NetGraph } from "./graph";

export const NET_COLORS = {
  root: new THREE.Color("#e9fbff"),
  dirNear: new THREE.Color("#2a9dff"),
  dirFar: new THREE.Color("#5de0ff"),
  edgeFrom: new THREE.Color("#1f6fff"),
  edgeTo: new THREE.Color("#5de0ff"),
  fileEdge: new THREE.Color("#2a8cff"),
  orange: new THREE.Color("#ff9a3c"),
  cyan: new THREE.Color("#7ff0ff"),
};

const ARC_SEGMENTS = 14;
const MAX_PARTICLES = 1600;

export interface NetGeometry {
  count: number;
  nodes: THREE.BufferGeometry;
  /** On-screen size of each node in px at the reference distance (also used for picking). */
  sizes: Float32Array;
  edges: THREE.BufferGeometry;
  edgeBase: Float32Array;
  /** Per node: first vertex and vertex count of the edge to its parent (-1 for roots). */
  edgeStart: Int32Array;
  edgeCount: Int32Array;
  particles: THREE.BufferGeometry;
  /** Per particle: the node whose edge it travels (its visibility follows that node). */
  particleNode: Int32Array;
  /** Nodes currently shown (see `applyVisibility`). */
  visible: Uint8Array;
  /** Folders that always get a name: the roots and their direct sub-folders, biggest first. */
  labelOrder: Int32Array;
  dispose: () => void;
}

const log10 = (v: number) => Math.log10(Math.max(1, v));
const tmp = new THREE.Color();

/** Point on the edge a -> b at t, lifted into an arc. The particle shader uses the same formula. */
function arcPoint(a: number[], b: number[], ra: number, rb: number, lift: number, t: number, out: number[]) {
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  const z = a[2] + (b[2] - a[2]) * t;
  const l = Math.hypot(x, y, z) || 1;
  const r = ra + (rb - ra) * t + lift * Math.sin(Math.PI * t);
  out[0] = (x / l) * r;
  out[1] = (y / l) * r;
  out[2] = (z / l) * r;
}

export function buildNetGeometry(g: NetGraph): NetGeometry {
  const n = g.nodes.length;
  const dir = (i: number) => [g.dirs[i * 3], g.dirs[i * 3 + 1], g.dirs[i * 3 + 2]];
  const isDir = (i: number) => g.nodes[i].entry.kind === "dir";

  /* ---- nodes ---- */
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  const born = new Float32Array(n);
  const index = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const node = g.nodes[i];
    const e = node.entry;
    const r = isDir(i) ? R_DIR : R_FILE;
    pos.set([g.dirs[i * 3] * r, g.dirs[i * 3 + 1] * r, g.dirs[i * 3 + 2] * r], i * 3);
    if (node.parent < 0) {
      tmp.copy(NET_COLORS.root);
      size[i] = 30;
    } else if (isDir(i)) {
      tmp.copy(NET_COLORS.dirNear).lerp(NET_COLORS.dirFar, Math.min(1, (node.depth - 1) / 3));
      size[i] = 8 + Math.min(6, Math.max(0, log10(e.size) - 4)) * 1.7;
    } else {
      // Category color, pulled a little towards the cyan theme.
      tmp.set(categoryColor(e.category)).lerp(NET_COLORS.cyan, 0.2);
      size[i] = 3.2 + Math.min(7, Math.max(0, log10(e.size) - 3)) * 0.55;
    }
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    phase[i] = hash01(e.id) * Math.PI * 2;
    born[i] = node.born;
    index[i] = i;
  }
  const nodes = new THREE.BufferGeometry();
  nodes.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  nodes.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  nodes.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  nodes.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  nodes.setAttribute("aBorn", new THREE.BufferAttribute(born, 1));
  nodes.setAttribute("aIndex", new THREE.BufferAttribute(index, 1));
  nodes.computeBoundingSphere();

  /* ---- edges (parent -> child) ---- */
  let verts = 0;
  for (let i = 0; i < n; i++) if (g.nodes[i].parent >= 0) verts += isDir(i) ? ARC_SEGMENTS * 2 : 2;
  const ePos = new Float32Array(verts * 3);
  const eCol = new Float32Array(verts * 3);
  const eBorn = new Float32Array(verts);
  const edgeStart = new Int32Array(n).fill(-1);
  const edgeCount = new Int32Array(n);
  const pA = [0, 0, 0];
  const pB = [0, 0, 0];
  const cA = new THREE.Color();
  const cB = new THREE.Color();
  let v = 0;
  const particleEdges: { a: number; b: number; lift: number; len: number; depth: number }[] = [];
  for (let i = 0; i < n; i++) {
    const node = g.nodes[i];
    if (node.parent < 0) continue;
    const a = dir(node.parent);
    const b = dir(i);
    const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    edgeStart[i] = v;
    if (isDir(i)) {
      const lift = 0.015 + ang * 0.05;
      // Brighter near the root, fading with depth.
      const k = Math.max(0.28, 0.75 - (node.depth - 1) * 0.14);
      cA.copy(NET_COLORS.edgeFrom).multiplyScalar(k);
      cB.copy(NET_COLORS.edgeTo).multiplyScalar(k * 0.8);
      for (let s = 0; s < ARC_SEGMENTS; s++) {
        const t0 = s / ARC_SEGMENTS;
        const t1 = (s + 1) / ARC_SEGMENTS;
        arcPoint(a, b, R_DIR, R_DIR, lift, t0, pA);
        arcPoint(a, b, R_DIR, R_DIR, lift, t1, pB);
        ePos.set(pA, v * 3);
        ePos.set(pB, v * 3 + 3);
        tmp.copy(cA).lerp(cB, t0);
        eCol.set([tmp.r, tmp.g, tmp.b], v * 3);
        tmp.copy(cA).lerp(cB, t1);
        eCol.set([tmp.r, tmp.g, tmp.b], v * 3 + 3);
        eBorn[v] = eBorn[v + 1] = node.born;
        v += 2;
      }
      particleEdges.push({ a: node.parent, b: i, lift, len: ang, depth: node.depth });
    } else {
      arcPoint(a, b, R_DIR, R_FILE, 0, 0, pA);
      arcPoint(a, b, R_DIR, R_FILE, 0, 1, pB);
      ePos.set(pA, v * 3);
      ePos.set(pB, v * 3 + 3);
      tmp.copy(NET_COLORS.fileEdge).multiplyScalar(0.22);
      eCol.set([tmp.r, tmp.g, tmp.b], v * 3);
      tmp.multiplyScalar(0.5);
      eCol.set([tmp.r, tmp.g, tmp.b], v * 3 + 3);
      eBorn[v] = eBorn[v + 1] = node.born;
      v += 2;
    }
    edgeCount[i] = v - edgeStart[i];
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
  edges.setAttribute("aColor", new THREE.BufferAttribute(eCol, 3).setUsage(THREE.DynamicDrawUsage));
  edges.setAttribute("aBorn", new THREE.BufferAttribute(eBorn, 1));
  edges.computeBoundingSphere();

  /* ---- particles travelling along folder edges ---- */
  // Shallow edges first (they are the backbone), at most two pulses per edge.
  particleEdges.sort((x, y) => x.depth - y.depth);
  const pick: { e: (typeof particleEdges)[number]; k: number }[] = [];
  for (const e of particleEdges) {
    pick.push({ e, k: 0 });
    if (e.depth <= 2) pick.push({ e, k: 1 });
    if (pick.length >= MAX_PARTICLES) break;
  }
  const m = pick.length;
  const qA = new Float32Array(m * 3);
  const qB = new Float32Array(m * 3);
  const qLift = new Float32Array(m);
  const qSpeed = new Float32Array(m);
  const qOffset = new Float32Array(m);
  const qColor = new Float32Array(m * 3);
  const qBorn = new Float32Array(m);
  const particleNode = new Int32Array(m);
  pick.forEach(({ e, k }, j) => {
    particleNode[j] = e.b;
    const h = hash01(g.nodes[e.b].entry.id * 7 + k * 131);
    // Mostly outward (root -> leaves); some flow back home.
    const back = h < 0.3;
    qA.set(dir(back ? e.b : e.a), j * 3);
    qB.set(dir(back ? e.a : e.b), j * 3);
    qLift[j] = e.lift;
    // Constant ground speed: shorter edges cycle faster.
    qSpeed[j] = (0.16 + h * 0.12) / Math.max(0.12, e.len);
    qOffset[j] = (h * 7.31 + k * 0.5) % 1;
    tmp.copy(h > 0.68 ? NET_COLORS.orange : NET_COLORS.cyan);
    qColor.set([tmp.r, tmp.g, tmp.b], j * 3);
    qBorn[j] = g.nodes[e.b].born;
  });
  const particles = new THREE.BufferGeometry();
  particles.setAttribute("position", new THREE.BufferAttribute(qA, 3));
  particles.setAttribute("aB", new THREE.BufferAttribute(qB, 3));
  particles.setAttribute("aLift", new THREE.BufferAttribute(qLift, 1));
  particles.setAttribute("aSpeed", new THREE.BufferAttribute(qSpeed, 1));
  particles.setAttribute("aOffset", new THREE.BufferAttribute(qOffset, 1));
  particles.setAttribute("aColor", new THREE.BufferAttribute(qColor, 3));
  particles.setAttribute("aBorn", new THREE.BufferAttribute(qBorn, 1));
  particles.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.6);

  const folders: number[] = [];
  for (let i = 0; i < n; i++) if (isDir(i) && g.nodes[i].depth <= 1) folders.push(i);
  folders.sort((x, y) => g.nodes[x].depth - g.nodes[y].depth || g.nodes[y].entry.size - g.nodes[x].entry.size);

  return {
    count: n,
    particleNode,
    visible: new Uint8Array(n),
    labelOrder: Int32Array.from(folders),
    nodes,
    sizes: size,
    edges,
    edgeBase: eCol.slice(),
    edgeStart,
    edgeCount,
    particles,
    dispose: () => {
      nodes.dispose();
      edges.dispose();
      particles.dispose();
    },
  };
}

/** Lights up the edges from the roots down to the given nodes in orange. */
export function highlightEdges(geo: NetGeometry, path: number[]) {
  const attr = geo.edges.getAttribute("aColor") as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  arr.set(geo.edgeBase);
  for (const i of path) {
    const s = geo.edgeStart[i];
    if (s < 0) continue;
    for (let v = s; v < s + geo.edgeCount[i]; v++) {
      arr[v * 3] = NET_COLORS.orange.r * 0.95;
      arr[v * 3 + 1] = NET_COLORS.orange.g * 0.95;
      arr[v * 3 + 2] = NET_COLORS.orange.b * 0.95;
    }
  }
  attr.needsUpdate = true;
}

/** When each shown node appeared (by entry id), so rebuilding the geometry does not replay the animation. */
const shownSince = new Map<number, number>();
const HIDDEN = 1e9;

/**
 * Shows exactly the `visible` nodes. Newly shown ones appear one after the
 * other (folders first, then files) through their fade-in time; hidden ones
 * get a fade-in time in the far future, so nothing is rebuilt.
 */
export function applyVisibility(geo: NetGeometry, g: NetGraph, visible: Uint8Array) {
  const now = performance.now() / 1000;
  const born = new Float32Array(geo.count).fill(HIDDEN);
  let step = 0;
  for (const wantDirs of [true, false]) {
    for (let i = 0; i < geo.count; i++) {
      const node = g.nodes[i];
      if (!node || (node.entry.kind === "dir") !== wantDirs) continue;
      const id = node.entry.id;
      if (!visible[i]) {
        shownSince.delete(id);
        continue;
      }
      let t = shownSince.get(id);
      if (t == null) {
        t = now + Math.min(step++ * (wantDirs ? 0.07 : 0.025), 2.2);
        shownSince.set(id, t);
      }
      born[i] = t;
    }
  }
  geo.visible = visible;

  const nb = geo.nodes.getAttribute("aBorn") as THREE.BufferAttribute;
  (nb.array as Float32Array).set(born);
  nb.needsUpdate = true;
  const eb = geo.edges.getAttribute("aBorn") as THREE.BufferAttribute;
  const ea = eb.array as Float32Array;
  for (let i = 0; i < geo.count; i++) {
    const s = geo.edgeStart[i];
    if (s >= 0) ea.fill(born[i], s, s + geo.edgeCount[i]);
  }
  eb.needsUpdate = true;
  const pb = geo.particles.getAttribute("aBorn") as THREE.BufferAttribute;
  const pa = pb.array as Float32Array;
  for (let j = 0; j < pa.length; j++) pa[j] = born[geo.particleNode[j]] + 0.4;
  pb.needsUpdate = true;
}
