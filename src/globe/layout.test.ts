import { describe, expect, it } from "vitest";
import { WORLD_RECT, innerRect, squarify, weightsWithFloor, type Rect } from "./layout";

const area = (r: Rect) => (r.lon1 - r.lon0) * (r.z1 - r.z0);
const inside = (a: Rect, b: Rect, eps = 1e-12) =>
  a.lon0 >= b.lon0 - eps && a.lon1 <= b.lon1 + eps && a.z0 >= b.z0 - eps && a.z1 <= b.z1 + eps;

describe("squarify", () => {
  const sizes = [500, 300, 120, 50, 20, 7, 2, 1];
  const items = sizes.map((s, i) => ({ key: `k${i}`, weight: s, data: i }));
  const out = squarify(items, WORLD_RECT);

  it("keeps every item, in order", () => {
    expect(out.map((o) => o.key)).toEqual(items.map((i) => i.key));
  });

  it("gives areas proportional to weights (equal-area projection)", () => {
    const total = sizes.reduce((a, b) => a + b, 0);
    out.forEach((o, i) => {
      expect(area(o.rect) / area(WORLD_RECT)).toBeCloseTo(sizes[i] / total, 9);
    });
  });

  it("tiles stay inside the parent and do not overlap", () => {
    for (const o of out) expect(inside(o.rect, WORLD_RECT)).toBe(true);
    for (let a = 0; a < out.length; a++)
      for (let b = a + 1; b < out.length; b++) {
        const A = out[a].rect;
        const B = out[b].rect;
        const ow = Math.min(A.lon1, B.lon1) - Math.max(A.lon0, B.lon0);
        const oh = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
        expect(ow <= 1e-12 || oh <= 1e-12).toBe(true);
      }
  });

  it("is deterministic", () => {
    expect(squarify(items, WORLD_RECT)).toEqual(out);
  });

  it("nests inside an inner rect", () => {
    const parent = out[0].rect;
    const inner = innerRect(parent);
    expect(inside(inner, parent)).toBe(true);
    const kids = squarify([{ key: "a", weight: 1, data: 0 }, { key: "b", weight: 3, data: 1 }], inner);
    for (const k of kids) expect(inside(k.rect, inner)).toBe(true);
  });

  it("handles deep, tiny rects without collapsing", () => {
    let r: Rect = WORLD_RECT;
    for (let d = 0; d < 12; d++) {
      r = innerRect(squarify([{ key: "x", weight: 1, data: 0 }, { key: "y", weight: 30, data: 0 }], r)[0].rect);
      expect(area(r)).toBeGreaterThan(0);
    }
  });
});

describe("weightsWithFloor", () => {
  it("gives empty items a minimum share", () => {
    const w = weightsWithFloor([1000, 0, 0]);
    expect(w[1]).toBeGreaterThan(0);
    expect(weightsWithFloor([0, 0])).toEqual([1, 1]);
  });
});
