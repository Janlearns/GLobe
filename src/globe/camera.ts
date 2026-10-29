/**
 * Camera state, kept outside React so the render loop can mutate it every
 * frame. The camera looks straight down at the surface point (lon, lat) of
 * one planet from altitude `h` (in that planet's radii). Because the view is
 * stored relative to the planet, the camera follows the planet along its
 * orbit. Moving the camera never changes anything about the files themselves.
 */

import * as THREE from "three";
import { angularSize, rectCenter, type Rect } from "./layout";
import { mainPlanetId, planetFrame, systemExtent } from "./planets";

export interface View {
  planet: number;
  lon: number;
  lat: number;
  h: number;
}

export const FOV_DEG = 45;
export const MIN_H = 2e-7;
export const MAX_H = 4.5;
export const WORLD_H = 2.4;
export const MAX_LAT = (80 * Math.PI) / 180;

export const view: View = { planet: 0, lon: 0.35, lat: 0.25, h: WORLD_H };

export interface Pose {
  eye: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  near: number;
}

const newPose = (): Pose => ({ eye: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(), near: 0.01 });

interface LocalFlight {
  kind: "local";
  from: View;
  to: View;
  start: number;
  duration: number;
  peak: number;
}

/** Flight between two planets, interpolated in world space. */
interface WorldFlight {
  kind: "world";
  from: Pose;
  to: View;
  start: number;
  duration: number;
}

let flight: LocalFlight | WorldFlight | null = null;
const flightPose = newPose();
export let lastInteraction = performance.now();

export function markInteraction() {
  lastInteraction = performance.now();
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function unit(lon: number, lat: number): [number, number, number] {
  const c = Math.cos(lat);
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)];
}

function angleBetween(a: View, b: View): number {
  const u = unit(a.lon, a.lat);
  const v = unit(b.lon, b.lat);
  return Math.acos(Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));
}

/** Overview altitude: the whole planetary system in view. */
export function systemH(): number {
  // Altitude is measured in radii of the central planet.
  const R = planetFrame(mainPlanetId()).radius;
  return Math.max(WORLD_H, (systemExtent() * 1.75) / R);
}

/** Largest zoom-out on `planet`, enough to see the whole system. */
function maxH(planet: number): number {
  const R = planetFrame(planet).radius;
  return Math.max(MAX_H, (systemExtent() * 2.6 + 2) / R);
}

/** Altitude at which a region of angular size `s` fills most of the view. */
export function altitudeFor(rect: Rect, fill = 0.8): number {
  const s = angularSize(rect);
  const visible = 2 * Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
  return Math.min(WORLD_H, Math.max(MIN_H * 5, s / (visible * fill)));
}

/** World-space camera pose for a planet-relative view. */
function localPose(v: View, out: Pose): Pose {
  const { center, radius } = planetFrame(v.planet);
  const [x, y, z] = unit(v.lon, v.lat);
  out.target.set(center.x + x * radius, center.y + y * radius, center.z + z * radius);
  out.eye.set(center.x + x * radius * (1 + v.h), center.y + y * radius * (1 + v.h), center.z + z * radius * (1 + v.h));
  out.up.set(-x * y, 1 - y * y, -z * y).normalize();
  out.near = Math.max(1e-10, v.h * radius * 0.05);
  return out;
}

export function currentPose(out: Pose): Pose {
  if (flight?.kind === "world") {
    out.eye.copy(flightPose.eye);
    out.target.copy(flightPose.target);
    out.up.copy(flightPose.up);
    out.near = flightPose.near;
    return out;
  }
  return localPose(view, out);
}

export function flyTo(target: View, duration?: number) {
  const to = { planet: target.planet, lon: target.lon, lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, target.lat)), h: target.h };
  const now = performance.now();
  if (to.planet !== view.planet || flight?.kind === "world") {
    const from = currentPose(newPose());
    flight = { kind: "world", from, to, start: now, duration: duration ?? 2400 };
    Object.assign(flightPose, { near: from.near });
    flightPose.eye.copy(from.eye);
    flightPose.target.copy(from.target);
    flightPose.up.copy(from.up);
  } else {
    const from = { ...view };
    const dist = angleBetween(from, to);
    // Arc: rise high enough to see both ends of a long trip.
    const peak = Math.max(from.h, to.h, Math.min(WORLD_H, dist * 0.9));
    const zoomSpan = Math.abs(Math.log(Math.max(from.h, 1e-9) / Math.max(to.h, 1e-9)));
    const dur = duration ?? Math.min(2600, 700 + dist * 650 + zoomSpan * 90);
    flight = { kind: "local", from, to, start: now, duration: dur, peak };
  }
  markInteraction();
}

export function flyToRect(rect: Rect, planet: number, fill = 0.8, duration?: number) {
  const c = rectCenter(rect);
  flyTo({ planet, lon: c.lon, lat: c.lat, h: altitudeFor(rect, fill) }, duration);
}

/** Stops a flight. A trip between planets is completed instantly instead. */
export function cancelFlight() {
  if (flight?.kind === "world") Object.assign(view, flight.to);
  flight = null;
}

export function isFlying() {
  return flight !== null;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const endPose = newPose();
const dirA = new THREE.Vector3();
const dirB = new THREE.Vector3();

function stepWorld(f: WorldFlight, t: number, raw: number) {
  const to = localPose(f.to, endPose); // live: the destination planet keeps moving
  const d0 = f.from.eye.distanceTo(f.from.target);
  const d1 = to.eye.distanceTo(to.target);
  const travel = f.from.target.distanceTo(to.target);
  flightPose.target.lerpVectors(f.from.target, to.target, t);
  // Pull back mid-flight so both planets are in view, then descend.
  const peak = Math.max(d0, d1, travel * 0.75);
  const base = Math.log(d0) + (Math.log(d1) - Math.log(d0)) * t;
  const lift = Math.max(0, Math.log(peak) - base) * Math.sin(Math.PI * t);
  const dist = Math.exp(base + lift);
  dirA.subVectors(f.from.eye, f.from.target).normalize();
  dirB.subVectors(to.eye, to.target).normalize();
  const dir = dirA.lerp(dirB, t);
  if (dir.lengthSq() < 1e-9) dir.copy(dirB);
  dir.normalize();
  flightPose.eye.copy(flightPose.target).addScaledVector(dir, dist);
  flightPose.up.lerpVectors(f.from.up, to.up, t).normalize();
  flightPose.near = Math.max(1e-10, dist * 0.05);
  if (raw >= 1) {
    Object.assign(view, f.to);
    flight = null;
  }
}

/** Advances the active flight. Returns true while animating. */
export function stepFlight(now: number, reducedMotion: boolean): boolean {
  if (!flight) return false;
  const f = flight;
  const raw = reducedMotion ? 1 : Math.min(1, (now - f.start) / f.duration);
  const t = ease(raw);
  if (f.kind === "world") {
    stepWorld(f, t, raw);
    return true;
  }
  // Great-circle interpolation of the look-at point.
  const a = unit(f.from.lon, f.from.lat);
  const b = unit(f.to.lon, f.to.lat);
  const omega = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  let p: number[];
  if (omega < 1e-9) {
    p = b;
  } else {
    const s = Math.sin(omega);
    const wa = Math.sin((1 - t) * omega) / s;
    const wb = Math.sin(t * omega) / s;
    p = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
  }
  const len = Math.hypot(p[0], p[1], p[2]);
  view.lat = Math.asin(p[1] / len);
  view.lon = omega < 1e-9 ? f.from.lon + wrap(f.to.lon - f.from.lon) * t : Math.atan2(p[0], p[2]);
  // Log-space altitude with a smooth rise to `peak` in the middle.
  const l0 = Math.log(f.from.h);
  const l1 = Math.log(f.to.h);
  const lp = Math.log(f.peak);
  const base = l0 + (l1 - l0) * t;
  const lift = Math.max(0, lp - Math.max(l0, l1)) * Math.sin(Math.PI * t);
  const up = Math.max(0, lp - base) * Math.sin(Math.PI * t) * 0.5;
  view.h = Math.exp(base + Math.max(lift, up));
  if (raw >= 1) {
    view.lon = f.to.lon;
    view.lat = f.to.lat;
    view.h = f.to.h;
    flight = null;
  }
  return true;
}

/** Drag to rotate: pixel deltas relative to the viewport height. */
export function rotateBy(dxFrac: number, dyFrac: number) {
  cancelFlight();
  markInteraction();
  const visible = 2 * Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
  const k = visible * Math.min(view.h, 1.1);
  view.lon = wrap(view.lon - (dxFrac * k) / Math.max(0.2, Math.cos(view.lat)));
  view.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, view.lat + dyFrac * k));
}

export function zoomBy(factor: number, minH = MIN_H) {
  cancelFlight();
  markInteraction();
  view.h = Math.max(minH, Math.min(maxH(view.planet), view.h * factor));
}

export function idleRotate(dtSec: number, speed = 0.03) {
  view.lon = wrap(view.lon + dtSec * speed);
}
