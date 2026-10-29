import * as THREE from "three";
import { angularSize, rectCenter, type Rect } from "./layout";
import { toVec } from "./geometry";
import { planetFrame } from "./planets";

/**
 * DOM labels positioned by the render loop. React renders the label elements
 * (see components/Labels.tsx) and registers them here; `projectLabels` moves
 * them every frame without re-rendering React.
 */
interface LabelEntry {
  el: HTMLElement;
  planet: number;
  /** Unit normal on the planet (local coordinates). */
  normal: THREE.Vector3;
  size: number;
  always: boolean;
  minPx: number;
}

const registry = new Map<string, LabelEntry>();
const pos = new THREE.Vector3();
const ndc = new THREE.Vector3();
const camDir = new THREE.Vector3();

export function registerLabel(key: string, el: HTMLElement | null, rect: Rect, planet: number, always: boolean, minPx = 34) {
  if (!el) {
    registry.delete(key);
    return;
  }
  const c = rectCenter(rect);
  const n = toVec(c.lon, c.lat);
  registry.set(key, { el, planet, normal: new THREE.Vector3(n[0], n[1], n[2]), size: angularSize(rect), always, minPx });
}

export function projectLabels(camera: THREE.PerspectiveCamera, width: number, height: number) {
  if (registry.size === 0) return;
  const k = 2 * Math.tan(((camera.fov / 2) * Math.PI) / 180);
  for (const l of registry.values()) {
    const { center, radius } = planetFrame(l.planet);
    pos.copy(l.normal).multiplyScalar(radius).add(center);
    camDir.copy(camera.position).sub(pos);
    const dist = Math.max(camDir.length(), 1e-12);
    const facing = camDir.divideScalar(dist).dot(l.normal);
    const px = ((l.size * radius) / (k * dist)) * height;
    ndc.copy(pos).project(camera);
    const onScreen = ndc.z < 1 && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1;
    const show = onScreen && facing > 0.12 && (l.always || px > l.minPx);
    if (!show) {
      if (l.el.style.visibility !== "hidden") l.el.style.visibility = "hidden";
      continue;
    }
    const x = (ndc.x * 0.5 + 0.5) * width;
    const y = (-ndc.y * 0.5 + 0.5) * height;
    l.el.style.visibility = "visible";
    l.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    l.el.style.maxWidth = `${Math.max(60, Math.min(220, px * 0.9)).toFixed(0)}px`;
    l.el.style.opacity = String(Math.min(1, Math.max(0.35, facing * 1.6)));
  }
}
