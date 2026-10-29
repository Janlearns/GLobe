/**
 * Equal-area spherical treemap.
 *
 * Regions are rectangles in (longitude, z = sin(latitude)) space. That
 * projection is area-preserving (Lambert cylindrical equal-area), so a
 * region's area on the globe is exactly proportional to the size it was given.
 * Each directory's children are laid out inside the directory's own region
 * (squarified, largest first), so the hierarchy nests geographically and any
 * file always appears at the same place for a given index.
 *
 * Children are paginated: a page shows `PAGE_SIZE` items plus one "more"
 * region that holds the next page, recursively.
 */

export const PAGE_SIZE = 64;
/** Latitude band used for the world: |z| <= Z_MAX keeps regions away from the poles. */
export const Z_MAX = 0.94;
/** Smallest share of the parent area a child may get, so empty files stay clickable. */
const MIN_SHARE = 0.0025;
/** Fraction of a region's shortest side kept free around its children. */
const PADDING = 0.035;

export interface Rect {
  lon0: number;
  lon1: number;
  z0: number;
  z1: number;
}

export interface LayoutItem<T> {
  key: string;
  weight: number;
  data: T;
}

export interface LaidOut<T> {
  key: string;
  rect: Rect;
  data: T;
}

export const WORLD_RECT: Rect = { lon0: -Math.PI, lon1: Math.PI, z0: -Z_MAX, z1: Z_MAX };

export function rectCenter(r: Rect): { lon: number; lat: number } {
  return { lon: (r.lon0 + r.lon1) / 2, lat: Math.asin((r.z0 + r.z1) / 2) };
}

/** Cosine of the latitude at the rect's center (the local lon/z aspect correction). */
function aspectCos(r: Rect): number {
  const z = (r.z0 + r.z1) / 2;
  return Math.max(0.15, Math.sqrt(1 - z * z));
}

/** Approximate angular extent (radians) of the rect: [width, height]. */
export function angularExtent(r: Rect): [number, number] {
  const c = aspectCos(r);
  const w = (r.lon1 - r.lon0) * c;
  const h = Math.asin(Math.min(1, r.z1)) - Math.asin(Math.max(-1, r.z0));
  return [Math.abs(w), Math.abs(h)];
}

export function angularSize(r: Rect): number {
  const [w, h] = angularExtent(r);
  return Math.max(w, h);
}

/** Shrinks a rect by `PADDING` of its shortest physical side on every edge. */
export function innerRect(r: Rect, padding = PADDING): Rect {
  const c = aspectCos(r);
  const wPhys = (r.lon1 - r.lon0) * c;
  const hPhys = (r.z1 - r.z0) / c;
  const pad = Math.min(wPhys, hPhys) * padding;
  return {
    lon0: r.lon0 + pad / c,
    lon1: r.lon1 - pad / c,
    z0: r.z0 + pad * c,
    z1: r.z1 - pad * c,
  };
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk) of `items` into `rect`.
 * Works in locally aspect-corrected coordinates so tiles look square on the
 * sphere. Items must already be sorted (largest first) for best results; the
 * order is preserved, which keeps the layout deterministic.
 */
export function squarify<T>(items: LayoutItem<T>[], rect: Rect): LaidOut<T>[] {
  if (items.length === 0) return [];
  const c = aspectCos(rect);
  // Physical (approximately isotropic) frame.
  const W = (rect.lon1 - rect.lon0) * c;
  const H = (rect.z1 - rect.z0) / c;
  const total = items.reduce((s, i) => s + i.weight, 0);
  const area = W * H;
  const scaled = items.map((i) => (total > 0 ? (i.weight / total) * area : area / items.length));

  const out: LaidOut<T>[] = [];
  let x = 0;
  let y = 0;
  let w = W;
  let h = H;
  let i = 0;

  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    if (s <= 0) return Infinity;
    let max = -Infinity;
    let min = Infinity;
    for (const r of row) {
      max = Math.max(max, r);
      min = Math.min(min, r);
    }
    const s2 = s * s;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * Math.max(min, 1e-300)));
  };

  const emit = (idx: number, px: number, py: number, pw: number, ph: number) => {
    out.push({
      key: items[idx].key,
      data: items[idx].data,
      rect: {
        lon0: rect.lon0 + px / c,
        lon1: rect.lon0 + (px + pw) / c,
        z0: rect.z0 + py * c,
        z1: rect.z0 + (py + ph) * c,
      },
    });
  };

  while (i < scaled.length) {
    const side = Math.min(w, h);
    const row: number[] = [scaled[i]];
    let j = i + 1;
    while (j < scaled.length && worst([...row, scaled[j]], side) <= worst(row, side)) {
      row.push(scaled[j]);
      j++;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    const last = j >= scaled.length;
    if (w >= h) {
      // Column on the left of the remaining space.
      const colW = last ? w : rowSum / h;
      let cy = y;
      for (let k = 0; k < row.length; k++) {
        const ch = k === row.length - 1 ? y + h - cy : (row[k] / rowSum) * h;
        emit(i + k, x, cy, colW, ch);
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = last ? h : rowSum / w;
      let cx = x;
      for (let k = 0; k < row.length; k++) {
        const cw = k === row.length - 1 ? x + w - cx : (row[k] / rowSum) * w;
        emit(i + k, cx, y, cw, rowH);
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
  return out;
}

/** Applies the minimum share so tiny/empty items remain visible. */
export function weightsWithFloor(sizes: number[]): number[] {
  const total = sizes.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return sizes.map(() => 1);
  const floor = total * MIN_SHARE;
  return sizes.map((s) => Math.max(s, floor));
}

/** Node key helpers. */
export const entryKey = (id: number) => `e${id}`;
export const moreKey = (parentId: number, offset: number) => `m${parentId}@${offset}`;
