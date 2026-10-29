import * as THREE from "three";
import { categoryColor } from "../fileTypes";
import { angularSize, innerRect, rectCenter, type Rect } from "./layout";
import type { Layer, LayerRole } from "./model";

/** Unit vector for (lon, lat); y is north. */
export function toVec(lon: number, lat: number, r = 1): [number, number, number] {
  const c = Math.cos(lat);
  return [r * c * Math.sin(lon), r * Math.sin(lat), r * c * Math.cos(lon)];
}

export function rectOrigin(r: Rect): [number, number, number] {
  const c = rectCenter(r);
  return toVec(c.lon, c.lat);
}

/**
 * Files are drawn as small satellites hovering above their region. Positions
 * are relative to the layer origin; the scene animates them along a small
 * orbit around `anchor`.
 */
export interface Satellites {
  count: number;
  /** Rest point above the tile center (x, y, z per satellite). */
  anchor: Float32Array;
  /** Orbit plane axes (tangent to the globe). */
  axisA: Float32Array;
  axisB: Float32Array;
  /** Ring orientation (quaternion x, y, z, w). */
  ringQuat: Float32Array;
  scale: Float32Array;
  orbit: Float32Array;
  phase: Float32Array;
  colors: Float32Array;
  tileIndex: Int32Array;
}

/** Largest satellite core radius (globe radius = 1), so huge files stay tidy. */
const MAX_SATELLITE = 0.02;

export interface LayerGeometry {
  /** World-space origin; every buffer below is relative to it. */
  origin: [number, number, number];
  fill: THREE.BufferGeometry;
  /** Triangle index -> tile index (for picking). */
  triTile: Int32Array;
  lines: THREE.BufferGeometry;
  satellites: Satellites;
}

const ROLE_FILL: Record<LayerRole, number> = { focus: 0.24, preview: 0.13, context: 0.05 };
const ROLE_LINE: Record<LayerRole, number> = { focus: 0.8, preview: 0.42, context: 0.26 };
const ROLE_NODE: Record<LayerRole, number> = { focus: 1, preview: 0.75, context: 0.45 };

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const tmpColor = new THREE.Color();

export function regionColor(id: number, level: number): THREE.Color {
  // Blue -> cyan -> violet family with per-folder variation.
  const hue = 0.5 + 0.27 * hash(id * 31 + level);
  return new THREE.Color().setHSL(hue, 0.7, 0.5);
}

/** Point on the unit sphere for (lon, z) relative to `o`. */
function pushPoint(out: number[], lon: number, z: number, o: [number, number, number], r = 1) {
  const c = Math.sqrt(Math.max(0, 1 - z * z));
  out.push(r * c * Math.sin(lon) - o[0], r * z - o[1], r * c * Math.cos(lon) - o[2]);
}

export function buildLayerGeometry(layer: Layer): LayerGeometry {
  const origin = rectOrigin(layer.rect);
  const role = layer.role;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const tri: number[] = [];
  const lpos: number[] = [];
  const lcol: number[] = [];
  const sat = { anchor: [] as number[], a: [] as number[], b: [] as number[], q: [] as number[], s: [] as number[], o: [] as number[], ph: [] as number[], c: [] as number[], t: [] as number[] };
  const quat = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const normal = new THREE.Vector3();
  const ta = new THREE.Vector3();
  const tb = new THREE.Vector3();

  layer.tiles.forEach((tile, ti) => {
    const r = innerRect(tile.rect, 0.05);
    const size = angularSize(r);
    const isFile = tile.entry != null && tile.entry.kind !== "dir";
    let base: THREE.Color;
    if (tile.more) base = tmpColor.set("#6a6f9a").clone();
    else if (isFile) base = new THREE.Color(categoryColor(tile.entry!.category));
    else base = regionColor(tile.entry!.id, layer.level);
    // A planet's root region covers the whole globe; keep it a subtle base tint.
    const fillK = ROLE_FILL[role] * (isFile ? 0.6 : 1) * (tile.more ? 0.6 : 1) * (layer.level === 0 ? 0.35 : 1);
    const lineK = ROLE_LINE[role] * (isFile ? 0.55 : 1);

    // Patch grid; segment size keeps the chord sag far below the globe gap.
    const step = Math.max(1e-12, Math.min(0.1, size / 6));
    const c = Math.max(0.15, Math.sqrt(1 - ((r.z0 + r.z1) / 2) ** 2));
    const minSeg = isFile ? 2 : 4;
    const nx = Math.max(minSeg, Math.min(24, Math.ceil(((r.lon1 - r.lon0) * c) / step)));
    const ny = Math.max(minSeg, Math.min(24, Math.ceil((Math.asin(r.z1) - Math.asin(r.z0)) / step)));
    const start = pos.length / 3;
    for (let j = 0; j <= ny; j++) {
      const z = r.z0 + ((r.z1 - r.z0) * j) / ny;
      for (let i = 0; i <= nx; i++) {
        const lon = r.lon0 + ((r.lon1 - r.lon0) * i) / nx;
        pushPoint(pos, lon, z, origin);
        // Neon rim: tinted center, bright edges, so neighbouring regions separate clearly.
        const edge = Math.max(Math.abs(i / nx - 0.5), Math.abs(j / ny - 0.5)) * 2;
        const k = fillK * (0.45 + 0.75 * edge * edge * edge);
        col.push(base.r * k, base.g * k, base.b * k);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = start + j * (nx + 1) + i;
        const b = a + 1;
        const d = a + nx + 1;
        const e = d + 1;
        idx.push(a, d, b, b, d, e);
        tri.push(ti, ti);
      }
    }

    // Border.
    const ring: [number, number][] = [];
    for (let i = 0; i <= nx; i++) ring.push([r.lon0 + ((r.lon1 - r.lon0) * i) / nx, r.z0]);
    for (let j = 1; j <= ny; j++) ring.push([r.lon1, r.z0 + ((r.z1 - r.z0) * j) / ny]);
    for (let i = nx - 1; i >= 0; i--) ring.push([r.lon0 + ((r.lon1 - r.lon0) * i) / nx, r.z1]);
    for (let j = ny - 1; j >= 0; j--) ring.push([r.lon0, r.z0 + ((r.z1 - r.z0) * j) / ny]);
    for (let k = 0; k < ring.length - 1; k++) {
      pushPoint(lpos, ring[k][0], ring[k][1], origin);
      pushPoint(lpos, ring[k + 1][0], ring[k + 1][1], origin);
      for (let q = 0; q < 2; q++) lcol.push(base.r * lineK, base.g * lineK, base.b * lineK);
    }

    // File satellite hovering above the tile center.
    if (isFile) {
      const center = rectCenter(r);
      const s = Math.max(1e-12, Math.min(size * 0.14, MAX_SATELLITE));
      const n = toVec(center.lon, center.lat);
      normal.set(n[0], n[1], n[2]);
      const alt = s * 2.6;
      sat.anchor.push(n[0] * (1 + alt) - origin[0], n[1] * (1 + alt) - origin[1], n[2] * (1 + alt) - origin[2]);
      // Tangent axes of the orbit plane.
      ta.set(0, 1, 0).cross(normal);
      if (ta.lengthSq() < 1e-12) ta.set(1, 0, 0);
      ta.normalize();
      tb.copy(normal).cross(ta).normalize();
      sat.a.push(ta.x, ta.y, ta.z);
      sat.b.push(tb.x, tb.y, tb.z);
      // Ring frame: the torus axis (Z) along the globe normal; the scene adds
      // a per-file tilt and a slow precession.
      const h = hash(tile.entry!.id);
      quat.setFromUnitVectors(zAxis, normal);
      sat.q.push(quat.x, quat.y, quat.z, quat.w);
      sat.s.push(s);
      sat.o.push(s * (0.8 + h * 0.6));
      sat.ph.push(h * Math.PI * 2);
      const k = ROLE_NODE[role];
      const nc = new THREE.Color(categoryColor(tile.entry!.category));
      sat.c.push(nc.r * k, nc.g * k, nc.b * k);
      sat.t.push(ti);
    }
  });

  const fill = new THREE.BufferGeometry();
  fill.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  fill.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  fill.setIndex(idx);
  fill.computeBoundingSphere();
  const lines = new THREE.BufferGeometry();
  lines.setAttribute("position", new THREE.Float32BufferAttribute(lpos, 3));
  lines.setAttribute("color", new THREE.Float32BufferAttribute(lcol, 3));
  lines.computeBoundingSphere();
  const satellites: Satellites = {
    count: sat.t.length,
    anchor: new Float32Array(sat.anchor),
    axisA: new Float32Array(sat.a),
    axisB: new Float32Array(sat.b),
    ringQuat: new Float32Array(sat.q),
    scale: new Float32Array(sat.s),
    orbit: new Float32Array(sat.o),
    phase: new Float32Array(sat.ph),
    colors: new Float32Array(sat.c),
    tileIndex: new Int32Array(sat.t),
  };
  return { origin, fill, triTile: new Int32Array(tri), lines, satellites };
}

/** Outline geometry for a single rect (hover / selection markers). */
export function buildOutline(rect: Rect, origin: [number, number, number], segments = 16): THREE.BufferGeometry {
  const r = innerRect(rect, 0.03);
  const pts: number[] = [];
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i++) ring.push([r.lon0 + ((r.lon1 - r.lon0) * i) / segments, r.z0]);
  for (let j = 1; j <= segments; j++) ring.push([r.lon1, r.z0 + ((r.z1 - r.z0) * j) / segments]);
  for (let i = segments - 1; i >= 0; i--) ring.push([r.lon0 + ((r.lon1 - r.lon0) * i) / segments, r.z1]);
  for (let j = segments - 1; j >= 0; j--) ring.push([r.lon0, r.z0 + ((r.z1 - r.z0) * j) / segments]);
  for (let k = 0; k < ring.length - 1; k++) {
    pushPoint(pts, ring[k][0], ring[k][1], origin);
    pushPoint(pts, ring[k + 1][0], ring[k + 1][1], origin);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
