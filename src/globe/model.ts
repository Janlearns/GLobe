import { api } from "../api";
import type { ChildPage, Entry, RootInfo } from "../types";
import {
  PAGE_SIZE,
  WORLD_RECT,
  angularSize,
  entryKey,
  innerRect,
  moreKey,
  squarify,
  weightsWithFloor,
  type Rect,
} from "./layout";
import { allPlanets, mainPlanetId, syncPlanets } from "./planets";

/** One region on the globe: an entry (file/dir/link) or a "more" bucket. */
export interface Tile {
  key: string;
  rect: Rect;
  entry: Entry | null;
  more: { parentId: number; offset: number; count: number; size: number } | null;
}

export type LayerRole = "context" | "focus" | "preview";

export interface Layer {
  key: string;
  /** Root id of the planet this layer lives on. */
  planet: number;
  role: LayerRole;
  level: number;
  rect: Rect;
  tiles: Tile[];
}

/** A step of the navigation path: a directory and the page offset shown. */
export interface ChainItem {
  entry: Entry;
  offset: number;
}

const pageCache = new Map<string, Promise<ChildPage>>();
const rects = new Map<string, { rect: Rect; planet: number }>();

export function clearModelCache() {
  pageCache.clear();
  rects.clear();
}

export function getRect(key: string): Rect | undefined {
  return rects.get(key)?.rect;
}

/** Planet (root id) a laid-out region belongs to. */
export function getRectPlanet(key: string): number | undefined {
  return rects.get(key)?.planet;
}

function getPage(parentId: number, offset: number): Promise<ChildPage> {
  const k = `${parentId}@${offset}`;
  let p = pageCache.get(k);
  if (!p) {
    p = api.listChildren(parentId, offset, PAGE_SIZE);
    p.catch(() => pageCache.delete(k));
    pageCache.set(k, p);
  }
  return p;
}

export const focusKeyOf = (c: ChainItem) => (c.offset === 0 ? entryKey(c.entry.id) : moreKey(c.entry.id, c.offset));

function layoutPage(rect: Rect, page: ChildPage, planet: number): Tile[] {
  const sizes = page.items.map((e) => e.size);
  const hasMore = page.remainingCount > 0;
  if (hasMore) sizes.push(page.remainingSize);
  const weights = weightsWithFloor(sizes);
  const items = page.items.map((e, i) => ({
    key: entryKey(e.id),
    weight: weights[i],
    data: { entry: e as Entry | null, more: null as Tile["more"] },
  }));
  if (hasMore) {
    const off = page.offset + page.items.length;
    items.push({
      key: moreKey(page.parentId, off),
      weight: weights[weights.length - 1],
      data: { entry: null, more: { parentId: page.parentId, offset: off, count: page.remainingCount, size: page.remainingSize } },
    });
  }
  const tiles = squarify(items, innerRect(rect)).map((t) => ({ key: t.key, rect: t.rect, ...t.data }));
  for (const t of tiles) rects.set(t.key, { rect: t.rect, planet });
  return tiles;
}

/** One layer per planet holding that planet's root folder, covering the whole globe. */
function planetLayers(roots: RootInfo[], role: LayerRole): Layer[] {
  syncPlanets(roots);
  const byId = new Map(roots.map((r) => [r.id, r]));
  return allPlanets().map((p) => {
    const entry = byId.get(p.rootId)!.entry!;
    const tile: Tile = { key: entryKey(entry.id), rect: WORLD_RECT, entry, more: null };
    rects.set(tile.key, { rect: WORLD_RECT, planet: p.rootId });
    return { key: `world:${p.rootId}`, planet: p.rootId, role, level: 0, rect: WORLD_RECT, tiles: [tile] };
  });
}

/** Rect of a page container: the dir itself for page 0, otherwise its "more" bucket. */
async function pageRect(dirId: number, offset: number): Promise<Rect> {
  const k = offset === 0 ? entryKey(dirId) : moreKey(dirId, offset);
  const r = rects.get(k);
  if (!r) throw new Error(`Region ${k} is not laid out yet`);
  return r.rect;
}

/**
 * Builds every layer needed to display `chain`: every planet's root, each
 * ancestor's pages (context), the focused page and previews of its
 * sub-folders. With an empty chain (the overview) every planet is in focus.
 */
export async function buildLayers(
  roots: RootInfo[],
  chain: ChainItem[],
): Promise<{ layers: Layer[]; focusRect: Rect; focusPlanet: number }> {
  const layers: Layer[] = planetLayers(roots, chain.length === 0 ? "focus" : "context");
  const planet = chain[0]?.entry.rootId ?? mainPlanetId();

  let level = 1;
  for (let ci = 0; ci < chain.length; ci++) {
    const { entry, offset } = chain[ci];
    for (let off = 0; off <= offset; off += PAGE_SIZE) {
      const page = await getPage(entry.id, off);
      const rect = await pageRect(entry.id, off);
      const isFocus = ci === chain.length - 1 && off === offset;
      layers.push({ key: `${entry.id}@${off}`, planet, role: isFocus ? "focus" : "context", level: level++, rect, tiles: layoutPage(rect, page, planet) });
      if (page.remainingCount === 0) break;
    }
  }

  const focusLayers = layers.filter((l) => l.role === "focus");
  const focus = focusLayers[focusLayers.length - 1];
  const focusSize = angularSize(focus.rect);
  // Level-of-detail preview: the first page of the larger sub-folders.
  const previewDirs = focusLayers
    .flatMap((l) => l.tiles.map((t) => ({ t, planet: l.planet })))
    .filter(({ t }) => t.entry?.kind === "dir" && t.entry.fileCount + t.entry.dirCount > 0 && angularSize(t.rect) > focusSize * 0.03)
    .slice(0, 40);
  const previews = await Promise.all(
    previewDirs.map(async ({ t, planet: p }) => {
      try {
        const page = await getPage(t.entry!.id, 0);
        return { key: `${t.entry!.id}@0`, planet: p, role: "preview" as const, level, rect: t.rect, tiles: layoutPage(t.rect, page, p) };
      } catch {
        return null;
      }
    }),
  );
  for (const p of previews) if (p) layers.push(p);
  return { layers, focusRect: focus.rect, focusPlanet: chain.length ? planet : mainPlanetId() };
}

/** Chain of pages to reach an entry from `locate` steps (root first, entry last). */
export function chainFromSteps(steps: { entry: Entry; rank: number }[]): { chain: ChainItem[]; target: Entry } {
  const chain: ChainItem[] = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const childRank = steps[i + 1].rank;
    chain.push({ entry: steps[i].entry, offset: Math.floor(childRank / PAGE_SIZE) * PAGE_SIZE });
  }
  const target = steps[steps.length - 1].entry;
  if (target.kind === "dir") chain.push({ entry: target, offset: 0 });
  return { chain, target };
}
