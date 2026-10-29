import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import { MUSIC_BANDS, music, musicStrength } from "./music";

/**
 * Star field. Each star listens to one band of the spectrum, so with music
 * sync on the sky twinkles like an equalizer and swells on every beat.
 */
export function Stars({ count }: { count: number }) {
  const { geom, material } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const band = new Float32Array(count);
    const size = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = 120 + Math.random() * 60;
      const c = Math.sqrt(1 - u * u);
      pos.set([r * c * Math.cos(t), r * u, r * c * Math.sin(t)], i * 3);
      const tint = Math.random();
      const b = 0.35 + Math.random() * 0.65;
      col.set(tint < 0.3 ? [0.7 * b, 0.8 * b, b] : tint < 0.4 ? [0.8 * b, 0.7 * b, b] : [b, b, b], i * 3);
      band[i] = Math.floor(Math.random() * MUSIC_BANDS);
      size[i] = 1.2 + Math.pow(Math.random(), 3) * 2.6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aBand", new THREE.BufferAttribute(band, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uBands: { value: new Float32Array(MUSIC_BANDS) },
        uBeat: { value: 0 },
        uStrength: { value: 0 },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aBand;
        attribute float aSize;
        uniform float uBands[${MUSIC_BANDS}];
        uniform float uBeat;
        uniform float uStrength;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vGlow;
        void main() {
          float b = uBands[int(aBand)];
          float twinkle = 0.78 + 0.22 * sin(uTime * (0.6 + fract(aBand * 0.37) * 1.4) + aSize * 37.0);
          float react = uStrength * (b * b * 1.8 + uBeat * 0.55);
          vGlow = twinkle + react;
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * (1.0 + react * 1.6);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vGlow;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vColor * vGlow, a * min(1.0, vGlow));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geom: g, material: m };
  }, [count]);
  useEffect(
    () => () => {
      geom.dispose();
      material.dispose();
    },
    [geom, material],
  );
  useFrame(({ clock, gl }) => {
    const u = material.uniforms;
    (u.uBands.value as Float32Array).set(music.bands);
    u.uBeat.value = music.beat;
    u.uStrength.value = musicStrength(useStore.getState().reducedMotion);
    u.uTime.value = clock.elapsedTime;
    u.uPixelRatio.value = gl.getPixelRatio();
  });
  return <points geometry={geom} material={material} renderOrder={-20} frustumCulled={false} />;
}
