/**
 * Network Mode camera. The camera sits on the +Z axis looking at the origin;
 * the globe itself turns (yaw around Y, then pitch around X). Targets are
 * eased towards with exponential smoothing, so motion is frame-rate independent.
 */

export const NET_DEFAULT = { yaw: 0, pitch: 0.22, dist: 3.4 };
export const NET_MIN_DIST = 1.22;
export const NET_MAX_DIST = 7.5;
const PITCH_LIMIT = 1.45;

export const netView = {
  yaw: NET_DEFAULT.yaw,
  pitch: NET_DEFAULT.pitch,
  dist: NET_DEFAULT.dist,
  tYaw: NET_DEFAULT.yaw,
  tPitch: NET_DEFAULT.pitch,
  tDist: NET_DEFAULT.dist,
  /** Drag inertia, radians per second. */
  vYaw: 0,
  vPitch: 0,
  dragging: false,
  lastInput: -1e9,
};

const clampPitch = (p: number) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function markNetInput() {
  netView.lastInput = performance.now();
}

export function dragNet(dYaw: number, dPitch: number, dt: number) {
  netView.tYaw += dYaw;
  netView.tPitch = clampPitch(netView.tPitch + dPitch);
  // Snap so dragging feels direct, and remember the speed for the throw.
  netView.yaw = netView.tYaw;
  netView.pitch = netView.tPitch;
  if (dt > 0) {
    const k = Math.min(1, dt * 12);
    netView.vYaw += (dYaw / dt - netView.vYaw) * k;
    netView.vPitch += (dPitch / dt - netView.vPitch) * k;
  }
  markNetInput();
}

export function zoomNet(factor: number) {
  netView.tDist = Math.max(NET_MIN_DIST, Math.min(NET_MAX_DIST, netView.tDist * factor));
  markNetInput();
}

export function resetNetView() {
  netView.tYaw = netView.yaw + wrap(NET_DEFAULT.yaw - netView.yaw);
  netView.tPitch = NET_DEFAULT.pitch;
  netView.tDist = NET_DEFAULT.dist;
  netView.vYaw = netView.vPitch = 0;
  markNetInput();
}

/** Turns the globe so a globe-local point faces the camera, optionally zooming to `dist`. */
export function focusNetPoint(p: readonly number[], dist?: number) {
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  const lon = Math.atan2(p[0], p[2]);
  const lat = Math.asin(p[1] / len);
  netView.tYaw = netView.yaw + wrap(-lon - netView.yaw);
  netView.tPitch = clampPitch(lat);
  if (dist != null) netView.tDist = Math.max(NET_MIN_DIST, Math.min(NET_MAX_DIST, dist));
  netView.vYaw = netView.vPitch = 0;
  markNetInput();
}

/** Advances the camera; `spin` is the idle auto-rotation speed (rad/s, 0 = paused). */
export function stepNetView(dt: number, spin: number) {
  const d = Math.min(dt, 0.1);
  const v = netView;
  if (!v.dragging) {
    // Throw: keep turning with the release speed, slowing down.
    if (Math.abs(v.vYaw) > 1e-4 || Math.abs(v.vPitch) > 1e-4) {
      v.tYaw += v.vYaw * d;
      v.tPitch = clampPitch(v.tPitch + v.vPitch * d);
      const decay = Math.exp(-3.2 * d);
      v.vYaw *= decay;
      v.vPitch *= decay;
    }
    if (spin && performance.now() - v.lastInput > 3500) v.tYaw += spin * d;
  }
  const k = 1 - Math.exp(-6 * d);
  v.yaw += (v.tYaw - v.yaw) * k;
  v.pitch += (v.tPitch - v.pitch) * k;
  v.dist += (v.tDist - v.dist) * (1 - Math.exp(-5 * d));
}
