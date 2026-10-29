import { describe, expect, it } from "vitest";
import type { RootInfo } from "../types";
import { ATMOSPHERE, allPlanets, mainPlanetId, radiusForSize, syncPlanets, tickPlanets } from "./planets";

function root(id: number, size: number, addedAt: number): RootInfo {
  return {
    id,
    path: `C:\\r${id}`,
    addedAt,
    lastScan: 0,
    status: "ready",
    message: null,
    entry: {
      id: id * 100,
      rootId: id,
      parentId: null,
      name: `r${id}`,
      ext: "",
      kind: "dir",
      size,
      fileCount: 0,
      dirCount: 0,
      modified: null,
      created: null,
      category: "folder",
      depth: 0,
      path: `C:\\r${id}`,
    },
  };
}

describe("planet system", () => {
  // Deliberately unsorted, with folders much larger than the first one.
  const roots = [root(5, 9e12, 30), root(2, 1e6, 10), root(9, 5e11, 20), root(3, 4e12, 40), root(7, 1, 50), root(4, 8e9, 60)];

  it("makes the first added folder the central planet", () => {
    syncPlanets(roots);
    expect(mainPlanetId()).toBe(2);
    const main = allPlanets()[0];
    expect(main.orbitRadius).toBe(0);
  });

  it("makes bigger folders bigger planets", () => {
    expect(radiusForSize(1e12)).toBeGreaterThan(radiusForSize(1e9));
    expect(radiusForSize(1e9)).toBeGreaterThan(radiusForSize(1e6));
    expect(radiusForSize(0)).toBeGreaterThan(0);
  });

  it("never lets planets (including atmospheres) touch over a full orbit", () => {
    syncPlanets(roots);
    const ps = allPlanets();
    const atmosphere = ATMOSPHERE;
    let minGap = Infinity;
    for (let t = 0; t < 3600; t += 2) {
      tickPlanets(t);
      for (let a = 0; a < ps.length; a++)
        for (let b = a + 1; b < ps.length; b++) {
          const gap = ps[a].center.distanceTo(ps[b].center) - (ps[a].radius + ps[b].radius) * atmosphere;
          minGap = Math.min(minGap, gap);
        }
    }
    expect(minGap).toBeGreaterThan(0);
  });
});
