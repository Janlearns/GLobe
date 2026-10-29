import { describe, expect, it } from "vitest";
import type { Entry } from "../../types";
import { layoutNetwork, visibleNodes, type NetNode } from "./graph";

function entry(id: number, kind: "dir" | "file", fileCount = 0, dirCount = 0): Entry {
  return {
    id,
    rootId: 1,
    parentId: null,
    name: `n${id}`,
    ext: "",
    kind,
    size: 1000 * id,
    fileCount,
    dirCount,
    modified: null,
    created: null,
    category: kind === "dir" ? "folder" : "document",
    depth: 0,
    path: `C:\\n${id}`,
  };
}

function tree(extraFiles: number): NetNode[] {
  const nodes: NetNode[] = [];
  const add = (e: Entry, parent: number) => {
    nodes.push({ entry: e, parent, depth: parent < 0 ? 0 : nodes[parent].depth + 1, children: [], loaded: true, born: 0 });
    if (parent >= 0) nodes[parent].children.push(nodes.length - 1);
    return nodes.length - 1;
  };
  const root = add(entry(1, "dir", 40, 3), -1);
  const a = add(entry(2, "dir", 30, 1), root);
  add(entry(3, "dir", 5, 0), root);
  add(entry(4, "dir", 0, 0), a);
  for (let i = 0; i < 5 + extraFiles; i++) add(entry(100 + i, "file"), a);
  return nodes;
}

const at = (pos: Float32Array, i: number) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
const angle = (u: number[], v: number[]) => Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));

describe("network layout", () => {
  it("puts every node on the unit sphere", () => {
    const pos = layoutNetwork(tree(0));
    for (let i = 0; i < pos.length / 3; i++) expect(Math.hypot(...at(pos, i))).toBeCloseTo(1, 5);
  });

  it("does not move existing folders when more files load", () => {
    const before = layoutNetwork(tree(0));
    const after = layoutNetwork(tree(20));
    for (let i = 0; i < 4; i++) at(before, i).forEach((v, k) => expect(at(after, i)[k]).toBeCloseTo(v, 6));
  });

  it("keeps files near their own folder", () => {
    const nodes = tree(10);
    const pos = layoutNetwork(nodes);
    const folder = at(pos, 1);
    const sibling = at(pos, 2);
    for (let i = 4; i < nodes.length; i++) expect(angle(at(pos, i), folder)).toBeLessThan(angle(at(pos, i), sibling));
  });

  it("spreads folders over the whole globe", () => {
    const nodes: NetNode[] = [];
    nodes.push({ entry: entry(1, "dir", 0, 40), parent: -1, depth: 0, children: [], loaded: true, born: 0 });
    for (let i = 0; i < 40; i++) {
      nodes.push({ entry: entry(10 + i, "dir", 5, 0), parent: 0, depth: 1, children: [], loaded: true, born: 0 });
      nodes[0].children.push(i + 1);
    }
    const pos = layoutNetwork(nodes);
    const ys = nodes.map((_, i) => pos[i * 3 + 1]);
    const xs = nodes.map((_, i) => pos[i * 3]);
    expect(Math.min(...ys)).toBeLessThan(-0.6);
    expect(Math.max(...ys)).toBeGreaterThan(0.6);
    expect(Math.min(...xs)).toBeLessThan(-0.6);
    expect(Math.max(...xs)).toBeGreaterThan(0.6);
    // No two folders on top of each other.
    for (let i = 0; i < nodes.length; i++) for (let k = i + 1; k < nodes.length; k++) expect(angle(at(pos, i), at(pos, k))).toBeGreaterThan(0.05);
  });

  it("shows top-level folders, and opens only the selected branch", () => {
    // 0 root, 1 a, 2 b, 3 a/c, 4.. files of a
    const nodes = tree(2);
    const shown = (sel: number) => [...visibleNodes(nodes, sel)].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    expect(shown(-1)).toEqual([0, 1, 2]);
    expect(shown(1)).toEqual(nodes.map((_, i) => i));
    expect(shown(2)).toEqual([0, 1, 2]);
    // Selecting a file inside "a" keeps "a" open.
    expect(shown(4)).toContain(3);
  });
});
