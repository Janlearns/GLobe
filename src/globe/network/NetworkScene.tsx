/**
 * Network Mode: the indexed folders as a glowing 3D network. Folders are hub
 * nodes, files are small nodes wired to their folder, pulses of light travel
 * along the real parent -> child connections.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import * as THREE from "three";
import { useStore } from "../../state/store";
import { FOV_DEG } from "../camera";
import { MUSIC_BANDS, music, musicStrength, tickMusic } from "../music";
import { R_DIR, graphVersion, netGraph, pathTo, subscribeGraph, visibleNodes } from "./graph";
import { applyVisibility, buildNetGeometry, highlightEdges, type NetGeometry } from "./geometry";
import { netLabelEls } from "./labels";
import { dragNet, markNetInput, netView, stepNetView, zoomNet } from "./view";

const BODY_R = 0.975;
/** Node sizes are authored for this camera distance. */
const REF_DIST = 3.4;

/** Uniforms shared by every Network Mode material, updated once per frame by the rig. */
const U = {
  uTime: { value: 0 },
  uNow: { value: 0 },
  uFlow: { value: 0 },
  uPixelRatio: { value: 1 },
  uIntensity: { value: 1 },
  uMusic: { value: 0 },
  uPulse: { value: 1 },
  uHover: { value: -1 },
  uSelected: { value: -1 },
};

/** Fades things out towards the globe's edge (the back is hidden by the body). */
const FACING = /* glsl */ `
  float facingFade(vec3 world) {
    vec3 n = normalize(world);
    vec3 toCam = normalize(cameraPosition - world);
    return smoothstep(-0.12, 0.35, dot(n, toCam));
  }
`;

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

function useDispose(...items: { dispose: () => void }[]) {
  useEffect(() => () => items.forEach((i) => i.dispose()), items);
}

/** Dark core that hides the far side, with a thin blue rim. */
function Body() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: fresnelVertex,
        fragmentShader: /* glsl */ `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            float f = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.0);
            vec3 base = vec3(0.006, 0.014, 0.035);
            gl_FragColor = vec4(base + vec3(0.08, 0.35, 0.9) * f * 0.35, 1.0);
          }
        `,
      }),
    [],
  );
  useDispose(material);
  return (
    <mesh material={material} scale={BODY_R} renderOrder={-10} raycast={() => null}>
      <sphereGeometry args={[1, 96, 72]} />
    </mesh>
  );
}

function Atmosphere() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uIntensity: U.uIntensity, uMusic: U.uMusic },
        vertexShader: fresnelVertex,
        fragmentShader: /* glsl */ `
          uniform float uIntensity;
          uniform float uMusic;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            // Back faces: -dot is 0 at the halo's outer edge and ~0.55 at the
            // globe's limb, so the glow hugs the globe and fades outwards.
            float f = pow(clamp(-dot(vNormal, vView) / 0.58, 0.0, 1.0), 3.0);
            vec3 c = mix(vec3(0.1, 0.4, 1.0), vec3(0.3, 0.85, 1.0), f);
            gl_FragColor = vec4(c * f * 0.5 * (0.6 + 0.4 * uIntensity) * (1.0 + uMusic * 1.2), 1.0);
          }
        `,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  useDispose(material);
  return (
    <mesh material={material} scale={1.2} raycast={() => null}>
      <sphereGeometry args={[1, 64, 48]} />
    </mesh>
  );
}

/**
 * Decorative mesh covering the whole sphere so it always reads as a network,
 * even with one small folder. Not interactive; each point follows a music band.
 */
function AmbientMesh({ count }: { count: number }) {
  const { points, lines, pointMat, lineMat } = useMemo(() => {
    const R = 0.988;
    const pos = new Float32Array(count * 3);
    const band = new Float32Array(count);
    const seed = new Float32Array(count);
    // Seeded random points (organic, not a lattice), the same on every run.
    let state = 12345;
    const rnd = () => (state = (state * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < count; i++) {
      const y = rnd() * 2 - 1;
      const r = Math.sqrt(1 - y * y);
      const a = rnd() * Math.PI * 2;
      pos.set([Math.cos(a) * r * R, y * R, Math.sin(a) * r * R], i * 3);
      band[i] = Math.floor(rnd() * MUSIC_BANDS);
      seed[i] = rnd() * 6.283;
    }
    // Each point links to its three nearest neighbours: a loose triangle mesh.
    const seg: number[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const best: [number, number][] = [];
      for (let k = 0; k < count; k++) {
        if (k === i) continue;
        const dx = pos[i * 3] - pos[k * 3];
        const dy = pos[i * 3 + 1] - pos[k * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[k * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (best.length < 3 || d < best[best.length - 1][0]) {
          best.push([d, k]);
          best.sort((x, y) => x[0] - y[0]);
          if (best.length > 3) best.pop();
        }
      }
      for (const [, k] of best) {
        const key = Math.min(i, k) * count + Math.max(i, k);
        if (seen.has(key)) continue;
        seen.add(key);
        seg.push(...pos.subarray(i * 3, i * 3 + 3), ...pos.subarray(k * 3, k * 3 + 3));
      }
    }
    const points = new THREE.BufferGeometry();
    points.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    points.setAttribute("aBand", new THREE.BufferAttribute(band, 1));
    points.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    const bands = { value: music.bands };
    const pointMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uBands: bands },
      vertexShader: /* glsl */ `
        attribute float aBand;
        attribute float aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uIntensity;
        uniform float uMusic;
        uniform float uBands[${MUSIC_BANDS}];
        varying float vA;
        ${FACING}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float b = uBands[int(aBand)];
          float tw = 0.55 + 0.45 * sin(uTime * 0.9 + aSeed * 3.0);
          vA = facingFade(world.xyz) * (tw * 0.35 + b * b * uMusic * 2.5) * uIntensity;
          vec4 mv = viewMatrix * world;
          gl_PointSize = (1.6 + b * uMusic * 3.0) * uPixelRatio * (${REF_DIST.toFixed(1)} / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(vec3(0.3, 0.65, 1.0) * vA * (1.0 - d), 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lineMat = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */ `
        uniform float uIntensity;
        uniform float uMusic;
        varying float vA;
        ${FACING}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vA = facingFade(world.xyz) * (0.11 + uMusic * 0.12) * uIntensity;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() { gl_FragColor = vec4(vec3(0.12, 0.38, 0.85) * vA, 1.0); }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { points, lines, pointMat, lineMat };
  }, [count]);
  useDispose(points, lines, pointMat, lineMat);
  return (
    <>
      <lineSegments geometry={lines} material={lineMat} renderOrder={1} raycast={() => null} />
      <points geometry={points} material={pointMat} renderOrder={2} raycast={() => null} />
    </>
  );
}

function useNetMaterials() {
  const m = useMemo(() => {
    const edges = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aBorn;
        uniform float uNow;
        uniform float uIntensity;
        uniform float uMusic;
        varying vec3 vColor;
        ${FACING}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float appear = clamp((uNow - aBorn) / 0.9, 0.0, 1.0);
          vColor = aColor * facingFade(world.xyz) * appear * uIntensity * (1.0 + uMusic * 0.8);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const nodes = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        attribute float aBorn;
        attribute float aIndex;
        uniform float uTime;
        uniform float uNow;
        uniform float uPixelRatio;
        uniform float uIntensity;
        uniform float uMusic;
        uniform float uPulse;
        uniform float uHover;
        uniform float uSelected;
        varying vec3 vColor;
        varying float vA;
        ${FACING}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float appear = clamp((uNow - aBorn) / 0.7, 0.0, 1.0);
          float hov = abs(aIndex - uHover) < 0.5 ? 1.0 : 0.0;
          float sel = abs(aIndex - uSelected) < 0.5 ? 1.0 : 0.0;
          float pulse = 1.0 + uPulse * 0.22 * sin(uTime * 1.7 + aPhase);
          float grow = 1.0 + hov * 0.9 + sel * 0.5 + uMusic * 0.45;
          vec4 mv = viewMatrix * world;
          gl_PointSize = min(aSize * grow * pulse * appear * uPixelRatio * (${REF_DIST.toFixed(1)} / -mv.z), 160.0);
          gl_Position = projectionMatrix * mv;
          vec3 c = mix(aColor, vec3(1.0, 0.72, 0.42), sel * 0.55);
          c = mix(c, vec3(1.0), hov * 0.45);
          vColor = c * (0.8 + 0.2 * pulse + hov * 0.7 + sel * 0.5 + uMusic * 0.6) * (0.55 + 0.45 * uIntensity);
          vA = facingFade(world.xyz) * appear;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float core = smoothstep(0.42, 0.18, d);
          float halo = exp(-d * d * 5.0) * 0.6;
          float a = (core + halo) * vA;
          gl_FragColor = vec4((vColor + core * 0.35) * a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particles = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */ `
        attribute vec3 aB;
        attribute float aLift;
        attribute float aSpeed;
        attribute float aOffset;
        attribute vec3 aColor;
        attribute float aBorn;
        uniform float uFlow;
        uniform float uNow;
        uniform float uPixelRatio;
        uniform float uIntensity;
        uniform float uMusic;
        varying vec3 vColor;
        varying float vA;
        ${FACING}
        void main() {
          float t = fract(uFlow * aSpeed + aOffset);
          float s = sin(3.14159265 * t);
          vec3 p = normalize(mix(position, aB, t)) * (${R_DIR.toFixed(3)} + aLift * s);
          vec4 world = modelMatrix * vec4(p, 1.0);
          float appear = clamp((uNow - aBorn) / 1.2, 0.0, 1.0);
          vA = facingFade(world.xyz) * appear * smoothstep(0.0, 0.25, s);
          vColor = aColor * (0.7 + 0.5 * uIntensity) * (1.0 + uMusic);
          vec4 mv = viewMatrix * world;
          gl_PointSize = (4.5 + uMusic * 4.0) * uPixelRatio * (${REF_DIST.toFixed(1)} / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float a = (smoothstep(0.5, 0.0, d) + exp(-d * d * 4.0) * 0.4) * vA;
          gl_FragColor = vec4(vColor * a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { edges, nodes, particles };
  }, []);
  useDispose(m.edges, m.nodes, m.particles);
  return m;
}

/** Rings for the selected node (dashed, orange), the hovered node and a search ripple. */
function Markers({ geo }: { geo: NetGeometry | null }) {
  const { geom, material } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(3), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array([0, 1, 2]), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...U, uRipple: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aKind;
        uniform float uPixelRatio;
        varying float vKind;
        varying float vFade;
        ${FACING}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vKind = aKind;
          vFade = facingFade(world.xyz);
          vec4 mv = viewMatrix * world;
          gl_PointSize = aSize * uPixelRatio * (aKind > 1.5 ? 1.0 : ${REF_DIST.toFixed(1)} / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uRipple;
        varying float vKind;
        varying float vFade;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          vec3 col;
          float a;
          if (vKind < 0.5) {
            float ring = smoothstep(0.1, 0.0, abs(d - 0.8));
            float dash = step(0.45, fract(atan(c.y, c.x) / 6.2831853 * 8.0 + uTime * 0.25));
            a = ring * (0.35 + 0.65 * dash) * (0.75 + 0.25 * sin(uTime * 4.0));
            col = vec3(1.0, 0.6, 0.22);
          } else if (vKind < 1.5) {
            a = smoothstep(0.08, 0.0, abs(d - 0.82)) * 0.8;
            col = vec3(0.6, 0.95, 1.0);
          } else {
            // Search hit: rings expanding outwards for a few seconds.
            float t = fract(uTime * 0.9);
            a = smoothstep(0.06, 0.0, abs(d - t)) * (1.0 - t) * uRipple;
            col = vec3(1.0, 0.7, 0.3);
          }
          gl_FragColor = vec4(col * a * vFade, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return { geom: g, material: m };
  }, []);
  useDispose(geom, material);

  useFrame(() => {
    const st = useStore.getState();
    const g = netGraph();
    const pos = geom.getAttribute("position") as THREE.BufferAttribute;
    const size = geom.getAttribute("aSize") as THREE.BufferAttribute;
    const sel = st.selected ? g.byId.get(st.selected.id) ?? -1 : -1;
    const found = st.netFound && st.netFound.idx === sel ? sel : -1;
    const slots = [sel, st.netHover ?? -1, found];
    slots.forEach((idx, k) => {
      if (!geo || idx < 0 || idx >= geo.count) {
        size.setX(k, 0);
        return;
      }
      const p = geo.nodes.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(k, p.getX(idx), p.getY(idx), p.getZ(idx));
      const s = geo.sizes[idx];
      size.setX(k, k === 0 ? s * 2.4 + 14 : k === 1 ? s * 2.1 + 10 : 170);
    });
    const age = st.netFound ? (performance.now() - st.netFound.at) / 1000 : 99;
    material.uniforms.uRipple.value = Math.max(0, 1 - Math.max(0, age - 2.5) / 1.5);
    pos.needsUpdate = true;
    size.needsUpdate = true;
  });
  return <points geometry={geom} material={material} renderOrder={60} raycast={() => null} frustumCulled={false} />;
}

/** Transparent orbit rings around the globe, each with a travelling light. */
function OrbitRings({ animate }: { animate: boolean }) {
  const group = useRef<THREE.Group>(null);
  const rings = useMemo(
    () =>
      [
        { r: 1.38, tilt: [1.2, 0, 0.25], color: "#3fa9ff", speed: 0.09, opacity: 0.2 },
        { r: 1.62, tilt: [1.85, 0.4, 0], color: "#ff9a3c", speed: -0.06, opacity: 0.13 },
        { r: 1.95, tilt: [1.4, -0.6, -0.35], color: "#5de0ff", speed: 0.04, opacity: 0.1 },
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
  useEffect(() => () => rings.forEach((r) => r.geom.dispose()), [rings]);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g || !animate) return;
    const boost = 1 + musicStrength(false) * music.level * 4;
    g.children.forEach((c, i) => (c.children[0].rotation.y += rings[i].speed * Math.min(dt, 0.1) * boost));
  });
  return (
    <group ref={group}>
      {rings.map((o, i) => (
        <group key={i} rotation={o.tilt as [number, number, number]}>
          <group>
            <line>
              <primitive object={o.geom} attach="geometry" />
              <lineBasicMaterial color={o.color} transparent opacity={o.opacity} depthWrite={false} blending={THREE.AdditiveBlending} />
            </line>
            <mesh position={[o.r, 0, 0]}>
              <sphereGeometry args={[0.014, 12, 8]} />
              <meshBasicMaterial color={o.color} toneMapped={false} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
}

const tmpV = new THREE.Vector3();
const tmpC = new THREE.Vector3();

/** Screen position (CSS px) of a node, or null when it is behind the globe. */
function projectNode(geo: NetGeometry, idx: number, group: THREE.Object3D, camera: THREE.Camera, w: number, h: number) {
  const p = geo.nodes.getAttribute("position") as THREE.BufferAttribute;
  tmpV.set(p.getX(idx), p.getY(idx), p.getZ(idx)).applyMatrix4(group.matrixWorld);
  tmpC.copy(camera.position).sub(tmpV);
  const dist = tmpC.length();
  const facing = tmpV.dot(tmpC) / (tmpV.length() * dist);
  if (facing < 0.05) return null;
  tmpV.project(camera);
  if (tmpV.z > 1) return null;
  return { x: ((tmpV.x + 1) / 2) * w, y: ((1 - tmpV.y) / 2) * h, dist, facing };
}

/** Rough label box (CSS px) for overlap tests: centred on x, above the node. */
type Box = [number, number, number, number];
const overlaps = (b: Box, placed: Box[]) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);

/**
 * Folder names, like opening the drive in Explorer: the root folders and
 * their direct sub-folders, plus the sub-folders of the selected folder.
 * A name that would overlap one already shown is skipped. Text is only
 * rewritten when a slot changes folder.
 */
function placeFolderLabels(geo: NetGeometry, group: THREE.Object3D, camera: THREE.Camera, w: number, h: number, selected: number, skip: number[]) {
  const pool = netLabelEls.folders;
  const nodes = netGraph().nodes;
  const opened = nodes[selected]?.entry.kind === "dir" ? nodes[selected].children.filter((c) => nodes[c].entry.kind === "dir" && nodes[c].depth > 1) : [];
  const order = opened.length ? [...geo.labelOrder, ...opened] : geo.labelOrder;
  const placed: Box[] = [];
  let k = 0;
  for (let o = 0; o < order.length && k < pool.length; o++) {
    const idx = order[o];
    if (skip.includes(idx) || !nodes[idx] || !geo.visible[idx]) continue;
    const at = projectNode(geo, idx, group, camera, w, h);
    if (!at || at.x < 0 || at.x > w || at.y < 60 || at.y > h - 30) continue;
    const n = nodes[idx];
    const root = n.parent < 0;
    const name = n.entry.name || n.entry.path;
    const bw = Math.min(root ? 220 : 150, name.length * (root ? 7.6 : 6.1) + 10);
    const bh = root ? 18 : 15;
    const lift = root ? 16 : 9;
    const box: Box = [at.x - bw / 2 - 3, at.y - lift - bh - 2, at.x + bw / 2 + 3, at.y - lift + 2];
    if (overlaps(box, placed)) continue;
    placed.push(box);
    const el = pool[k++];
    if (!el) continue;
    if (el.dataset.idx !== String(idx)) {
      el.dataset.idx = String(idx);
      el.textContent = name;
      el.title = n.entry.path;
      el.className = `net-label folder ${root ? "root" : n.depth === 1 ? "d1" : "deep"}`;
    }
    el.style.opacity = String(Math.min(1, (at.facing - 0.05) * 4));
    el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
  }
  for (; k < pool.length; k++) {
    const el = pool[k];
    if (el && el.style.opacity !== "0") {
      el.style.opacity = "0";
      el.dataset.idx = "";
    }
  }
}

function placeLabel(el: HTMLDivElement | null, at: { x: number; y: number } | null) {
  if (!el) return;
  if (!at) {
    el.style.opacity = "0";
    return;
  }
  el.style.opacity = "1";
  el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
}

/** Camera, input, picking, shared uniforms and label placement. */
function Rig({ group, geo }: { group: RefObject<THREE.Group | null>; geo: NetGeometry | null }) {
  const { camera, gl, size } = useThree();
  const geoRef = useRef(geo);
  geoRef.current = geo;

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number; id: number; t: number; moved: number; button: number } | null = null;
    let lastPick = 0;

    const pick = (clientX: number, clientY: number): number | null => {
      const geo = geoRef.current;
      const g = group.current;
      if (!geo || !g) return null;
      const r = el.getBoundingClientRect();
      const mx = clientX - r.left;
      const my = clientY - r.top;
      let best: number | null = null;
      let bestScore = Infinity;
      const dirCount = netGraph().nodes;
      for (let i = 0; i < geo.count; i++) {
        if (!geo.visible[i]) continue;
        const at = projectNode(geo, i, g, camera, r.width, r.height);
        if (!at) continue;
        const radius = Math.max(7, geo.sizes[i] * (REF_DIST / at.dist) * 0.45 + 3);
        const d = Math.hypot(at.x - mx, at.y - my);
        if (d > radius) continue;
        // Nearest wins; folders win ties against the files around them.
        const score = d / radius - (dirCount[i]?.entry.kind === "dir" ? 0.2 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      return best;
    };
    const setHover = (idx: number | null) => {
      if (useStore.getState().netHover !== idx) useStore.setState({ netHover: idx });
      el.style.cursor = idx != null ? "pointer" : "";
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, t: performance.now(), moved: 0, button: e.button };
      netView.dragging = true;
      netView.vYaw = netView.vPitch = 0;
      markNetInput();
    };
    const move = (e: PointerEvent) => {
      const now = performance.now();
      if (drag && drag.id === e.pointerId) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        const dt = (now - drag.t) / 1000;
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.t = now;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        // Closer in, the same drag turns the globe less.
        const k = (Math.PI * (netView.dist - 0.9)) / netView.dist / el.clientHeight;
        if (dx || dy) dragNet(dx * k, dy * k, dt);
        return;
      }
      if (e.target !== el || now - lastPick < 33) return;
      lastPick = now;
      setHover(pick(e.clientX, e.clientY));
    };
    const up = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      netView.dragging = false;
      // Held still before letting go: no throw.
      if (performance.now() - drag.t > 90) netView.vYaw = netView.vPitch = 0;
      if (drag.moved < 6 && drag.button === 0) {
        netView.vYaw = netView.vPitch = 0;
        const idx = pick(e.clientX, e.clientY);
        if (idx != null) useStore.getState().activateNetNode(idx);
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomNet(Math.exp(e.deltaY * 0.0012));
    };
    const leave = () => setHover(null);
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", ctx);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", ctx);
      el.style.cursor = "";
      netView.dragging = false;
    };
  }, [gl, camera, group]);

  const flow = useRef(0);
  useFrame(({ clock }, dt) => {
    const st = useStore.getState();
    const d = Math.min(dt, 0.1);
    tickMusic(dt);
    const k = musicStrength(st.reducedMotion);
    stepNetView(dt, st.netRotate ? (st.reducedMotion ? 0.025 : 0.07) : 0);

    const g = group.current;
    if (g) {
      g.rotation.set(netView.pitch, netView.yaw, 0, "XYZ");
      g.updateMatrixWorld();
    }
    const cam = camera as THREE.PerspectiveCamera;
    cam.position.set(0, 0, netView.dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    cam.near = 0.01;
    cam.far = 400;
    cam.fov = FOV_DEG;
    cam.updateProjectionMatrix();

    // Pulses speed up with the music; reduced motion keeps them slow.
    flow.current += d * (st.reducedMotion ? 0.35 : 1) * (1 + k * music.level * 2.5);
    U.uTime.value = clock.elapsedTime;
    U.uNow.value = performance.now() / 1000;
    U.uFlow.value = flow.current;
    U.uPixelRatio.value = gl.getPixelRatio();
    U.uIntensity.value = st.netIntensity;
    U.uMusic.value = k * (music.bass * 0.5 + music.beat * 0.6);
    U.uPulse.value = st.reducedMotion ? 0 : 1;
    const graph = netGraph();
    U.uHover.value = st.netHover ?? -1;
    U.uSelected.value = st.selected ? graph.byId.get(st.selected.id) ?? -1 : -1;

    // Labels: folder names (decluttered), plus the hovered and selected node.
    if (geo && g) {
      const at = (idx: number) => (idx >= 0 && idx < geo.count ? projectNode(geo, idx, g, cam, size.width, size.height) : null);
      placeFolderLabels(geo, g, cam, size.width, size.height, U.uSelected.value, [st.netHover ?? -1, U.uSelected.value]);
      placeLabel(netLabelEls.hover, at(st.netHover ?? -1));
      placeLabel(netLabelEls.selected, at(U.uSelected.value));
    }
  });
  return null;
}

export function NetworkScene() {
  const roots = useStore((s) => s.roots);
  const selected = useStore((s) => s.selected);
  const lowPower = useStore((s) => s.lowPower);
  const version = useSyncExternalStore(subscribeGraph, graphVersion);
  const group = useRef<THREE.Group>(null);
  const mats = useNetMaterials();

  useEffect(() => {
    void useStore.getState().syncNetwork();
  }, [roots]);

  const geo = useMemo(() => (netGraph().nodes.length ? buildNetGeometry(netGraph()) : null), [version]);
  useEffect(() => () => geo?.dispose(), [geo]);

  // Open the selected folder (and close the others), and draw the orange
  // trail from the root down to the selection.
  useLayoutEffect(() => {
    if (!geo) return;
    const g = netGraph();
    const idx = selected ? g.byId.get(selected.id) : undefined;
    applyVisibility(geo, g, visibleNodes(g.nodes, idx ?? -1));
    highlightEdges(geo, idx != null ? pathTo(idx) : []);
  }, [geo, selected]);

  useEffect(
    () => () => {
      useStore.setState({ netHover: null });
    },
    [],
  );

  return (
    <>
      <Rig group={group} geo={geo} />
      <OrbitRings animate={!lowPower} />
      <group ref={group}>
        <Body />
        <Atmosphere />
        <AmbientMesh count={lowPower ? 700 : 1500} />
        {geo && (
          <>
            <lineSegments geometry={geo.edges} material={mats.edges} renderOrder={3} raycast={() => null} frustumCulled={false} />
            {!lowPower && <points geometry={geo.particles} material={mats.particles} renderOrder={5} raycast={() => null} frustumCulled={false} />}
            <points geometry={geo.nodes} material={mats.nodes} renderOrder={4} raycast={() => null} frustumCulled={false} />
          </>
        )}
        <Markers geo={geo} />
      </group>
    </>
  );
}

