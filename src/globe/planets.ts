import * as THREE from "three";
import type { RootInfo } from "../types";

/**
 * Planetary system: every scan folder is its own planet, sized by how much
 * data it holds. The first folder added is the central planet (at the
 * origin); the others travel on separate, non-intersecting orbits around it.
 *
 * Everything on a planet is laid out in that planet's local unit-sphere
 * coordinates; a planet is placed in the world with `center` + `radius`.
 */
export interface Planet {
  rootId: number;
  index: number;
  radius: number;
  orbitRadius: number;
  /** Seconds per revolution. */
  period: number;
  phase: number;
  /** Orbit plane: tilt about X, then ascending node about Y. */
  tilt: number;
  node: number;
  center: THREE.Vector3;
}

const planets = new Map<number, Planet>();
let ordered: Planet[] = [];
const ORIGIN = new THREE.Vector3();

/** Atmosphere shell radius relative to the planet (see GlobeScene). */
export const ATMOSPHERE = 1.16;
/** Free space between neighbouring planets' atmospheres. */
const ORBIT_MARGIN = 0.6;

const MB = 1024 * 1024;
/**
 * Planet radius from folder size on a log scale, so it keeps growing as the
 * folder grows: about 0.45 at 1 MB, 0.9 at 1 GB, 1.2 at 100 GB, 1.35 at 1 TB.
 */
export function radiusForSize(bytes: number): number {
  const mb = Math.max(bytes, 1) / MB;
  return Math.min(1.6, Math.max(0.45, 0.45 + 0.15 * Math.log10(Math.max(mb, 1))));
}

export function syncPlanets(roots: RootInfo[]) {
  const ready = roots.filter((r) => r.entry).sort((a, b) => a.addedAt - b.addedAt || a.id - b.id);
  planets.clear();
  // Concentric orbits spaced by the neighbours' atmosphere radii: two circles
  // with radii r1 < r2 are always at least r2 - r1 apart, whatever their
  // planes, so planets can never touch.
  let prevOrbit = 0;
  let prevRadius = 0;
  ordered = ready.map((r, i) => {
    const radius = radiusForSize(r.entry!.size);
    const orbitRadius = i === 0 ? 0 : prevOrbit + (prevRadius + radius) * ATMOSPHERE + ORBIT_MARGIN;
    prevOrbit = orbitRadius;
    prevRadius = radius;
    const p: Planet = {
      rootId: r.id,
      index: i,
      radius,
      orbitRadius,
      period: 300 + (i - 1) * 140,
      phase: i * 2.39996,
      tilt: (i % 2 ? 1 : -1) * (0.1 + 0.04 * i),
      node: i * 1.1,
      center: new THREE.Vector3(),
    };
    planets.set(r.id, p);
    return p;
  });
  tickPlanets(lastTime);
}

let lastTime = 0;
const euler = new THREE.Euler();

/** Moves every planet along its orbit. `timeSec` is shared by the whole frame. */
export function tickPlanets(timeSec: number) {
  lastTime = timeSec;
  for (const p of ordered) {
    if (p.orbitRadius === 0) {
      p.center.set(0, 0, 0);
      continue;
    }
    const a = p.phase + (timeSec * Math.PI * 2) / p.period;
    p.center.set(Math.cos(a) * p.orbitRadius, 0, Math.sin(a) * p.orbitRadius);
    euler.set(p.tilt, p.node, 0, "YXZ");
    p.center.applyEuler(euler);
  }
}

export function getPlanet(rootId: number): Planet | undefined {
  return planets.get(rootId);
}

export function allPlanets(): Planet[] {
  return ordered;
}

export function mainPlanetId(): number {
  return ordered[0]?.rootId ?? 0;
}

/** Center and radius used to place a planet (a unit sphere at the origin if unknown). */
export function planetFrame(rootId: number): { center: THREE.Vector3; radius: number } {
  const p = planets.get(rootId) ?? ordered[0];
  return p ? { center: p.center, radius: p.radius } : { center: ORIGIN, radius: 1 };
}

/** Distance from the system center to the outer edge of the outermost planet. */
export function systemExtent(): number {
  let ext = 0;
  for (const p of ordered) ext = Math.max(ext, p.orbitRadius + p.radius);
  return ext || 1;
}

/** Points of a planet's orbit path (world space, around the central planet). */
export function orbitPath(p: Planet, segments = 256): Float32Array {
  const pts = new Float32Array((segments + 1) * 3);
  const v = new THREE.Vector3();
  const e = new THREE.Euler(p.tilt, p.node, 0, "YXZ");
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    v.set(Math.cos(a) * p.orbitRadius, 0, Math.sin(a) * p.orbitRadius).applyEuler(e);
    pts.set([v.x, v.y, v.z], i * 3);
  }
  return pts;
}
