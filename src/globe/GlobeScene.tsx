import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import {
  FOV_DEG,
  altitudeFor,
  currentPose,
  idleRotate,
  isFlying,
  lastInteraction,
  markInteraction,
  rotateBy,
  stepFlight,
  view,
  zoomBy,
  type Pose,
} from "./camera";
import { buildLayerGeometry, buildOutline, rectOrigin, toVec, type Satellites } from "./geometry";
import { angularSize } from "./layout";
import { getRect, getRectPlanet, type Layer, type Tile } from "./model";
import { projectLabels } from "./labels";
import { ATMOSPHERE, allPlanets, mainPlanetId, orbitPath, planetFrame, tickPlanets, type Planet } from "./planets";
import { MUSIC_BANDS, bandRange, music, musicStrength, tickMusic } from "./music";
import { Stars } from "./Stars";
import { NetworkScene } from "./network/NetworkScene";

const GLOBE_R = 0.99;

/** Body rim / atmosphere tint per planet: the central planet is blue, the others vary. */
const PLANET_TINTS = ["#2f7bff", "#8f6bff", "#2fd6c0", "#ff6fb5", "#ffb86b", "#6bffb8"];

/** Camera altitude above a planet, in that planet's radii. */
const camPos = new THREE.Vector3();
function altitudeAbove(planet: number, camera: THREE.Camera): number {
  const { center, radius } = planetFrame(planet);
  return camPos.copy(camera.position).distanceTo(center) / radius - 1;
}

const fresnelVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

function GlobeBody({ tint }: { tint: string }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { rim: { value: new THREE.Color(tint) } },
        vertexShader: fresnelVertex,
        fragmentShader: /* glsl */ `
          uniform vec3 rim;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            float f = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.5);
            vec3 base = vec3(0.012, 0.025, 0.06);
            gl_FragColor = vec4(base + rim * f * 0.5, 1.0);
          }
        `,
      }),
    [tint],
  );
  return (
    <mesh material={material} renderOrder={-10}>
      <sphereGeometry args={[GLOBE_R, 160, 120]} />
    </mesh>
  );
}

/** Spectrum slice (0..1) each planet's aura reacts to: the central one to the bass. */
function auraBand(index: number): [number, number] {
  if (index === 0) return [0, 0.16];
  const start = 0.15 + ((index * 0.29) % 0.7);
  return [start, Math.min(1, start + 0.18)];
}

const AURA_ACCENT = new THREE.Color("#ff4fd8");

function Atmosphere({ planet, tint, index }: { planet: number; tint: string; index: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const base = useMemo(() => new THREE.Color(tint).lerp(new THREE.Color("#ffffff"), 0.15), [tint]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { glow: { value: base.clone() }, pulse: { value: 0 } },
        vertexShader: fresnelVertex,
        fragmentShader: /* glsl */ `
          uniform vec3 glow;
          uniform float pulse;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            float f = pow(0.75 - dot(vNormal, vView), 3.0);
            gl_FragColor = vec4(glow, 1.0) * clamp(f, 0.0, 1.0) * 0.9 * (1.0 + pulse);
          }
        `,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    [base],
  );
  const range = auraBand(index);
  useFrame(({ camera }) => {
    const m = ref.current;
    if (!m) return;
    m.visible = altitudeAbove(planet, camera) > 0.25;
    // Music: the aura swells with its band, flashes on beats and drifts
    // towards magenta when the track gets bright.
    const k = musicStrength(useStore.getState().reducedMotion);
    const e = bandRange(range[0], range[1]);
    material.uniforms.pulse.value = k * (e * 1.4 + music.beat * (index === 0 ? 0.9 : 0.4));
    (material.uniforms.glow.value as THREE.Color).copy(base).lerp(AURA_ACCENT, Math.min(0.7, k * music.treble * 0.8));
    m.scale.setScalar(ATMOSPHERE * (1 + k * (e * 0.07 + music.beat * 0.03)));
  });
  return (
    <mesh ref={ref} material={material} scale={ATMOSPHERE}>
      <sphereGeometry args={[1, 64, 48]} />
    </mesh>
  );
}

function Graticule({ planet }: { planet: number }) {
  const ref = useRef<THREE.LineSegments>(null);
  const geom = useMemo(() => {
    const pts: number[] = [];
    const R = GLOBE_R + 0.0015;
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let lon = 0; lon < 360; lon += 3) {
        const a = toVec((lon * Math.PI) / 180, (lat * Math.PI) / 180, R);
        const b = toVec(((lon + 3) * Math.PI) / 180, (lat * Math.PI) / 180, R);
        pts.push(...a, ...b);
      }
    }
    for (let lon = 0; lon < 360; lon += 15) {
      for (let lat = -80; lat < 80; lat += 3) {
        const a = toVec((lon * Math.PI) / 180, (lat * Math.PI) / 180, R);
        const b = toVec((lon * Math.PI) / 180, ((lat + 3) * Math.PI) / 180, R);
        pts.push(...a, ...b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  useFrame(({ camera }) => {
    if (ref.current) ref.current.visible = altitudeAbove(planet, camera) > 0.05;
  });
  return (
    <lineSegments ref={ref} geometry={geom} renderOrder={-5}>
      <lineBasicMaterial color="#1d4c8f" transparent opacity={0.22} depthWrite={false} />
    </lineSegments>
  );
}

function Orbits({ animate }: { animate: boolean }) {
  const group = useRef<THREE.Group>(null);
  const rings = useMemo(
    () =>
      [
        { r: 1.32, tilt: [0.35, 0, 0.2], color: "#3fa9ff", speed: 0.02 },
        { r: 1.55, tilt: [-0.5, 0.3, 0], color: "#8f6bff", speed: -0.013 },
        { r: 1.85, tilt: [0.15, 0.8, -0.3], color: "#5de0ff", speed: 0.008 },
      ].map((o) => {
        const pts: number[] = [];
        for (let i = 0; i <= 256; i++) {
          const a = (i / 256) * Math.PI * 2;
          pts.push(Math.cos(a) * o.r, 0, Math.sin(a) * o.r);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        return { ...o, geom: g };
      }),
    [],
  );
  useFrame(({ camera }, dt) => {
    const g = group.current;
    if (!g) return;
    // Decorative rings hug the central planet, whatever its size.
    const R = planetFrame(mainPlanetId()).radius;
    g.scale.setScalar(R);
    g.visible = camera.position.length() > 1.35 * R;
    if (!animate) return;
    const boost = 1 + musicStrength(false) * music.level * 6;
    g.children.forEach((c, i) => (c.rotation.y += rings[i].speed * dt * 3 * boost));
  });
  return (
    <group ref={group}>
      {rings.map((o, i) => (
        <group key={i} rotation={o.tilt as [number, number, number]}>
          <line>
            <primitive object={o.geom} attach="geometry" />
            <lineBasicMaterial color={o.color} transparent opacity={0.16} depthWrite={false} blending={THREE.AdditiveBlending} />
          </line>
          <mesh position={[o.r, 0, 0]}>
            <sphereGeometry args={[0.012, 12, 8]} />
            <meshBasicMaterial color={o.color} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Faint orbit paths of the planets circling the central one. */
function OrbitPaths({ planets }: { planets: Planet[] }) {
  const paths = useMemo(
    () =>
      planets
        .filter((p) => p.orbitRadius > 0)
        .map((p) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(orbitPath(p), 3));
          return { id: p.rootId, geom: g, color: PLANET_TINTS[p.index % PLANET_TINTS.length] };
        }),
    [planets],
  );
  useEffect(() => () => paths.forEach((p) => p.geom.dispose()), [paths]);
  return (
    <>
      {paths.map((p) => (
        <line key={p.id}>
          <primitive object={p.geom} attach="geometry" />
          <lineBasicMaterial color={p.color} transparent opacity={0.22} depthWrite={false} blending={THREE.AdditiveBlending} />
        </line>
      ))}
    </>
  );
}

const SAT_CORE = new THREE.IcosahedronGeometry(1, 2);
const SAT_HALO = new THREE.IcosahedronGeometry(1, 1);
const SAT_RING = new THREE.TorusGeometry(1, 0.045, 6, 48);
const SPIN_AXIS = new THREE.Vector3(0, 0, 1);
const TILT_AXIS = new THREE.Vector3(1, 0, 0);

const ROLE_ORDER = { context: 0, preview: 1, focus: 2 } as const;

export interface PickInfo {
  layerIndex: number;
  kind: "fill" | "node";
  map: Int32Array;
}

function LayerView({ layer, index }: { layer: Layer; index: number }) {
  const geo = useMemo(() => buildLayerGeometry(layer), [layer]);
  useEffect(
    () => () => {
      geo.fill.dispose();
      geo.lines.dispose();
    },
    [geo],
  );
  const order = layer.level * 3 + ROLE_ORDER[layer.role];
  const fillMat = useRef<THREE.MeshBasicMaterial>(null);
  const lineMat = useRef<THREE.LineBasicMaterial>(null);
  // Regions breathe gently with the bass (the material color multiplies the vertex colors).
  useFrame(() => {
    const k = musicStrength(useStore.getState().reducedMotion) * (layer.role === "context" ? 0.4 : 1);
    const v = 1 + k * (music.bass * 0.35 + music.beat * 0.3);
    fillMat.current?.color.setScalar(v);
    lineMat.current?.color.setScalar(1 + k * (music.mid * 0.4 + music.beat * 0.5));
  });
  return (
    <group position={geo.origin}>
      <mesh geometry={geo.fill} renderOrder={order} userData={{ pick: { layerIndex: index, kind: "fill", map: geo.triTile } satisfies PickInfo }}>
        <meshBasicMaterial ref={fillMat} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <lineSegments geometry={geo.lines} renderOrder={order + 1} raycast={() => null}>
        <lineBasicMaterial ref={lineMat} vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </lineSegments>
      {geo.satellites.count > 0 && <SatelliteSwarm sats={geo.satellites} index={index} animate={layer.role === "focus"} />}
    </group>
  );
}

/**
 * File satellites: a glowing core, a soft halo (also the click target) and a
 * tilted ring, orbiting slowly above their region in the focused folder.
 */
function SatelliteSwarm({ sats, index, animate }: { sats: Satellites; index: number; animate: boolean }) {
  const core = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.InstancedMesh>(null);
  const ring = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(
    () => ({ m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), spin: new THREE.Quaternion(), tilt: new THREE.Quaternion(), id: new THREE.Quaternion(), s: new THREE.Vector3() }),
    [],
  );

  const place = (time: number) => {
    const { m, p, q, spin, tilt, id, s } = tmp;
    for (let i = 0; i < sats.count; i++) {
      const a = sats.phase[i] + time * (0.35 + (sats.phase[i] % 1) * 0.25);
      const r = sats.orbit[i];
      const ca = Math.cos(a) * r;
      const sa = Math.sin(a) * r;
      p.set(
        sats.anchor[i * 3] + sats.axisA[i * 3] * ca + sats.axisB[i * 3] * sa,
        sats.anchor[i * 3 + 1] + sats.axisA[i * 3 + 1] * ca + sats.axisB[i * 3 + 1] * sa,
        sats.anchor[i * 3 + 2] + sats.axisA[i * 3 + 2] * ca + sats.axisB[i * 3 + 2] * sa,
      );
      const sc = sats.scale[i];
      s.setScalar(sc);
      m.compose(p, id, s);
      core.current?.setMatrixAt(i, m);
      s.setScalar(sc * 2.1);
      m.compose(p, id, s);
      halo.current?.setMatrixAt(i, m);
      q.set(sats.ringQuat[i * 4], sats.ringQuat[i * 4 + 1], sats.ringQuat[i * 4 + 2], sats.ringQuat[i * 4 + 3]);
      // Tilted ring precessing around the globe normal.
      spin.setFromAxisAngle(SPIN_AXIS, sats.phase[i] + time * 0.5);
      tilt.setFromAxisAngle(TILT_AXIS, 0.45 + ((sats.phase[i] * 7) % 1) * 0.45);
      q.multiply(spin).multiply(tilt);
      s.set(sc * 1.9, sc * 1.9, sc * 1.9);
      m.compose(p, q, s);
      ring.current?.setMatrixAt(i, m);
    }
    for (const mesh of [core.current, halo.current, ring.current]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  };

  useEffect(() => {
    for (const mesh of [core.current, halo.current, ring.current]) {
      if (mesh) mesh.instanceColor = new THREE.InstancedBufferAttribute(sats.colors, 3);
    }
    place(0);
  }, [sats]);

  useFrame(({ clock }) => {
    if (animate && !useStore.getState().reducedMotion) place(clock.elapsedTime);
  });

  return (
    <>
      <instancedMesh ref={core} args={[SAT_CORE, undefined, sats.count]} raycast={() => null}>
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={halo}
        args={[SAT_HALO, undefined, sats.count]}
        userData={{ pick: { layerIndex: index, kind: "node", map: sats.tileIndex } satisfies PickInfo }}
      >
        <meshBasicMaterial transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={ring} args={[SAT_RING, undefined, sats.count]} raycast={() => null}>
        <meshBasicMaterial transparent opacity={0.75} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

/** Pulsing outline around the selected tile, plus a hover outline. */
function Markers({ planet }: { planet: number }) {
  const selectedKey = useStore((s) => s.selectedKey);
  const hovered = useStore((s) => s.hovered);
  const layers = useStore((s) => s.layers);
  const sel = useMemo(() => {
    const rect = selectedKey ? getRect(selectedKey) : undefined;
    if (!rect || getRectPlanet(selectedKey!) !== planet) return null;
    const o = rectOrigin(rect);
    return { origin: o, geom: buildOutline(rect, o) };
  }, [selectedKey, layers, planet]);
  const hov = useMemo(() => {
    if (!hovered || hovered.planet !== planet) return null;
    const o = rectOrigin(hovered.tile.rect);
    return { origin: o, geom: buildOutline(hovered.tile.rect, o, 8) };
  }, [hovered, planet]);
  const selMat = useRef<THREE.LineBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (selMat.current) selMat.current.opacity = 0.65 + 0.35 * Math.sin(clock.elapsedTime * 4);
  });
  return (
    <>
      {sel && (
        <lineSegments geometry={sel.geom} position={sel.origin} renderOrder={1000} raycast={() => null}>
          <lineBasicMaterial ref={selMat} color="#ffffff" transparent depthTest={false} toneMapped={false} />
        </lineSegments>
      )}
      {hov && (
        <lineSegments geometry={hov.geom} position={hov.origin} renderOrder={999} raycast={() => null}>
          <lineBasicMaterial color="#9fe8ff" transparent opacity={0.7} depthTest={false} toneMapped={false} />
        </lineSegments>
      )}
    </>
  );
}

function CameraRig() {
  const { camera, gl, size } = useThree();
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      markInteraction();
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (dx || dy) rotateBy(dx / el.clientHeight, dy / el.clientHeight);
    };
    const up = (e: PointerEvent) => {
      if (drag.current?.id === e.pointerId) drag.current = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const fs = useStore.getState().focusSize;
      zoomBy(Math.exp(e.deltaY * 0.0012), Math.max(2e-7, fs * 0.002));
    };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", ctx);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", ctx);
    };
  }, [gl]);

  const autoUpAt = useRef(0);
  const orbitTime = useRef(0);
  const pose = useMemo<Pose>(() => ({ eye: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(), near: 0.01 }), []);
  useFrame((_, dt) => {
    const st = useStore.getState();
    const now = performance.now();
    // Planets move first; everything else this frame reads their positions.
    if (!st.reducedMotion) orbitTime.current += Math.min(dt, 0.1);
    tickPlanets(orbitTime.current);
    tickMusic(dt);
    stepFlight(now, st.reducedMotion);
    const wallpaperMode = st.desktopMode === "wallpaper";
    if (!isFlying() && !drag.current && (wallpaperMode || (st.chain.length === 0 && !st.lowPower && now - lastInteraction > 20000))) {
      idleRotate(Math.min(dt, 0.1), wallpaperMode ? 0.05 : 0.03);
    }
    // Zooming far out of the focused folder returns to its parent.
    if (!isFlying() && st.chain.length > 0 && now > autoUpAt.current) {
      const focus = st.layers.find((l) => l.role === "focus");
      if (focus && view.h > altitudeFor(focus.rect) * 4 && view.h > 0.02) {
        autoUpAt.current = now + 800;
        const chain = st.chain;
        const last = chain[chain.length - 1];
        st.setChain(last.offset > 0 ? [...chain.slice(0, -1), { entry: last.entry, offset: 0 }] : chain.slice(0, -1), { fly: false });
      }
    }

    currentPose(pose);
    const cam = camera as THREE.PerspectiveCamera;
    cam.position.copy(pose.eye);
    cam.up.copy(pose.up);
    cam.lookAt(pose.target);
    cam.near = pose.near;
    cam.far = 400;
    cam.fov = FOV_DEG;
    cam.updateProjectionMatrix();
    projectLabels(cam, size.width, size.height);
  });
  return null;
}

function pickTile(e: ThreeEvent<PointerEvent | MouseEvent>, layers: Layer[]): { tile: Tile; layer: Layer } | null {
  let best: { score: number; tile: Tile; layer: Layer } | null = null;
  // Anything farther than where the ray first enters a planet body is hidden.
  let maxDist = Infinity;
  const hitPoint = new THREE.Vector3();
  for (const p of allPlanets()) {
    if (e.ray.intersectSphere(new THREE.Sphere(p.center, GLOBE_R * p.radius), hitPoint)) {
      maxDist = Math.min(maxDist, hitPoint.distanceTo(e.ray.origin));
    }
  }
  for (const hit of e.intersections) {
    if (hit.distance > maxDist) continue;
    const info = hit.object.userData?.pick as PickInfo | undefined;
    if (!info) continue;
    const layer = layers[info.layerIndex];
    if (!layer) continue;
    let ti: number | undefined;
    if (info.kind === "fill" && hit.faceIndex != null) ti = info.map[hit.faceIndex];
    if (info.kind === "node" && hit.instanceId != null) ti = info.map[hit.instanceId];
    if (ti == null) continue;
    const tile = layer.tiles[ti];
    if (!tile) continue;
    // Prefer file nodes, then the focused layer, then deeper/smaller regions.
    const score =
      (info.kind === "node" ? 1e6 : 0) +
      ROLE_ORDER[layer.role] * 1e4 +
      layer.level * 10 +
      (1 - Math.min(1, angularSize(tile.rect)));
    if (!best || score > best.score) best = { score, tile, layer };
  }
  return best ? { tile: best.tile, layer: best.layer } : null;
}

const RING_BARS = 128;
const ringColor = new THREE.Color();

/**
 * Circular spectrum around the central planet: bars radiate out from just
 * beyond its atmosphere, mirrored left/right, always facing the camera.
 */
function SpectrumRing() {
  const group = useRef<THREE.Group>(null);
  const { geom, pos, col } = useMemo(() => {
    const pos = new Float32Array(RING_BARS * 4 * 3);
    const col = new Float32Array(RING_BARS * 4 * 3);
    const idx: number[] = [];
    for (let i = 0; i < RING_BARS; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    return { geom: g, pos, col };
  }, []);
  useEffect(() => () => geom.dispose(), [geom]);

  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    const main = mainPlanetId();
    const k = musicStrength(useStore.getState().reducedMotion);
    g.visible = k > 0.01 && music.level > 0.01 && altitudeAbove(main, camera) > 0.6;
    if (!g.visible) return;
    const { center, radius } = planetFrame(main);
    g.position.copy(center);
    g.quaternion.copy(camera.quaternion);
    const r0 = radius * (ATMOSPHERE + 0.08);
    const half = (Math.PI / RING_BARS) * 0.62;
    for (let i = 0; i < RING_BARS; i++) {
      // Mirror: bass at the top, treble at the bottom on both sides.
      const t = i < RING_BARS / 2 ? i / (RING_BARS / 2) : (RING_BARS - 1 - i) / (RING_BARS / 2);
      const f = t * (MUSIC_BANDS - 1);
      const lo = Math.floor(f);
      const v = music.bands[lo] + (music.bands[Math.min(MUSIC_BANDS - 1, lo + 1)] - music.bands[lo]) * (f - lo);
      const len = radius * (0.015 + k * (v * v * 0.55 + music.beat * 0.04));
      const a = Math.PI / 2 - (i / RING_BARS) * Math.PI * 2;
      const r1 = r0 + len;
      const pts = [
        [Math.cos(a - half) * r0, Math.sin(a - half) * r0],
        [Math.cos(a + half) * r0, Math.sin(a + half) * r0],
        [Math.cos(a - half) * r1, Math.sin(a - half) * r1],
        [Math.cos(a + half) * r1, Math.sin(a + half) * r1],
      ];
      ringColor.setHSL(0.52 + t * 0.38, 0.9, 0.35 + v * 0.35);
      for (let q = 0; q < 4; q++) {
        pos.set([pts[q][0], pts[q][1], 0], (i * 4 + q) * 3);
        const fade = q < 2 ? 0.55 : 1;
        col.set([ringColor.r * fade * k, ringColor.g * fade * k, ringColor.b * fade * k], (i * 4 + q) * 3);
      }
    }
    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    geom.computeBoundingSphere();
  });
  return (
    <group ref={group} visible={false}>
      <mesh geometry={geom} renderOrder={50} raycast={() => null}>
        <meshBasicMaterial vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

const SHOCK_GEOM = new THREE.RingGeometry(0.985, 1, 160);

/** A ring of light expanding from the central planet on every beat. */
function BeatShockwaves() {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const state = useRef({ seen: 0, next: 0, age: [9, 9, 9, 9] });
  useFrame(({ camera }, dt) => {
    const st = state.current;
    const main = mainPlanetId();
    const k = musicStrength(useStore.getState().reducedMotion);
    if (music.beatCount !== st.seen) {
      st.seen = music.beatCount;
      if (k > 0.05) {
        st.age[st.next] = 0;
        st.next = (st.next + 1) % st.age.length;
      }
    }
    const { center, radius } = planetFrame(main);
    const far = altitudeAbove(main, camera) > 0.6;
    st.age.forEach((age, i) => {
      const m = refs.current[i];
      if (!m) return;
      st.age[i] = age + Math.min(dt, 0.1);
      const t = st.age[i] / 1.1;
      m.visible = far && t < 1;
      if (!m.visible) return;
      m.position.copy(center);
      m.quaternion.copy(camera.quaternion);
      m.scale.setScalar(radius * (ATMOSPHERE + 0.05 + t * 1.5));
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (1 - t) * 0.55 * k;
    });
  });
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => void (refs.current[i] = m)} geometry={SHOCK_GEOM} visible={false} renderOrder={51} raycast={() => null}>
          <meshBasicMaterial color="#9fe8ff" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

/** Shown before any folder has been scanned, so there is always a globe. */
const EMPTY_PLANET: Planet = {
  rootId: 0,
  index: 0,
  radius: 1,
  orbitRadius: 0,
  period: 1,
  phase: 0,
  tilt: 0,
  node: 0,
  center: new THREE.Vector3(),
};

/** One planet: follows its orbit and holds its body, regions and markers. */
function PlanetView({ planet, layers }: { planet: Planet; layers: { layer: Layer; index: number }[] }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.position.copy(planet.center);
    g.scale.setScalar(planet.radius);
  });
  const tint = PLANET_TINTS[planet.index % PLANET_TINTS.length];
  return (
    <group ref={group} position={planet.center} scale={planet.radius}>
      <GlobeBody tint={tint} />
      <Graticule planet={planet.rootId} />
      <Atmosphere planet={planet.rootId} tint={tint} index={planet.index} />
      {layers.map(({ layer, index }) => (
        <LayerView key={`${layer.key}:${layer.role}`} layer={layer} index={index} />
      ))}
      <Markers planet={planet.rootId} />
    </group>
  );
}

function PlanetSystem() {
  const layers = useStore((s) => s.layers);
  const lastHover = useRef(0);
  // `layers` is rebuilt whenever the roots change, which also re-syncs planets.
  const planets = useMemo(() => [...allPlanets()], [layers]);
  return (
    <>
      <OrbitPaths planets={planets} />
      <SpectrumRing />
      <BeatShockwaves />
      <group
        onClick={(e) => {
          e.stopPropagation();
          if (e.delta > 6) return; // it was a drag
          const hit = pickTile(e, layers);
          if (hit) useStore.getState().activateTile(hit.tile, hit.layer);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          const now = performance.now();
          if (now - lastHover.current < 40) return;
          lastHover.current = now;
          const hit = pickTile(e, layers);
          const cur = useStore.getState().hovered;
          if (!hit) {
            if (cur) useStore.setState({ hovered: null });
          } else {
            useStore.setState({ hovered: { tile: hit.tile, planet: hit.layer.planet, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } });
          }
        }}
        onPointerOut={() => useStore.setState({ hovered: null })}
      >
        {planets.length === 0 && <PlanetView planet={EMPTY_PLANET} layers={[]} />}
        {planets.map((p) => (
          <PlanetView
            key={p.rootId}
            planet={p}
            layers={layers.map((layer, index) => ({ layer, index })).filter(({ layer }) => layer.planet === p.rootId)}
          />
        ))}
      </group>
    </>
  );
}

/**
 * While the wallpaper is idle the scene renders on demand at a capped frame
 * rate, and not at all while another app covers the desktop.
 */
function FrameDriver({ throttled }: { throttled: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const covered = useStore((s) => s.covered);
  const lowPower = useStore((s) => s.lowPower);
  useEffect(() => {
    if (!throttled || covered) return;
    const id = setInterval(() => invalidate(), 1000 / (lowPower ? 15 : 30));
    return () => clearInterval(id);
  }, [throttled, covered, lowPower, invalidate]);
  return null;
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}

export function GlobeScene() {
  const lowPower = useStore((s) => s.lowPower);
  const wallpaperMode = useStore((s) => s.desktopMode === "wallpaper");
  const behindIcons = useStore((s) => s.desktopInfo?.wallpaperStyle === "behindIcons");
  const network = useStore((s) => s.viewMode === "network");
  const windowMode = useStore((s) => s.desktopMode === "window");
  const focused = useWindowFocused();
  // Interactive wallpaper runs at full rate while you use it; an app window
  // in the background drops to the capped rate too.
  const throttled = (wallpaperMode && (behindIcons || !focused)) || (windowMode && !focused);
  return (
    <Canvas
      frameloop={throttled ? "demand" : "always"}
      className="globe-canvas"
      dpr={lowPower ? 1 : [1, 2]}
      gl={{ antialias: !lowPower, powerPreference: lowPower ? "low-power" : "high-performance", logarithmicDepthBuffer: false }}
      camera={{ fov: FOV_DEG, near: 0.01, far: 400, position: [0, 0, 3.4] }}
      raycaster={{ params: { Line: { threshold: 0 }, Points: { threshold: 0 }, Mesh: {}, LOD: {}, Sprite: {} } }}
      onPointerMissed={() => useStore.setState({ hovered: null })}
    >
      <color attach="background" args={[network ? "#02040b" : "#03050c"]} />
      <FrameDriver throttled={throttled} />
      <Stars count={lowPower ? 800 : 2600} />
      {network ? (
        <NetworkScene />
      ) : (
        <>
          <CameraRig />
          <Orbits animate={!lowPower} />
          <PlanetSystem />
        </>
      )}
    </Canvas>
  );
}
