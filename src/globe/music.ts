/**
 * Live music state for the visuals. Audio frames arrive from the backend at
 * ~30 Hz; the render loop calls `tickMusic` every frame to ease towards them,
 * so effects stay smooth at any frame rate. Kept outside React on purpose.
 */

export const MUSIC_BANDS = 32;

export interface AudioFrame {
  level: number;
  bass: number;
  mid: number;
  treble: number;
  beat: boolean;
  bands: number[];
}

export const music = {
  enabled: false,
  /** 0..1 user setting. */
  intensity: 0.7,
  level: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  /** 1 on a beat, decaying to 0. */
  beat: 0,
  /** Increments on every beat (for spawning shockwaves). */
  beatCount: 0,
  bands: new Float32Array(MUSIC_BANDS),
  /** Seconds since the last frame with sound (for fading effects out). */
  silentFor: 999,
};

const target = { level: 0, bass: 0, mid: 0, treble: 0, bands: new Float32Array(MUSIC_BANDS) };
let lastFrameAt = 0;

export function pushAudioFrame(f: AudioFrame) {
  target.level = f.level;
  target.bass = f.bass;
  target.mid = f.mid;
  target.treble = f.treble;
  for (let i = 0; i < MUSIC_BANDS; i++) target.bands[i] = f.bands[i] ?? 0;
  if (f.beat) {
    music.beat = 1;
    music.beatCount++;
  }
  lastFrameAt = performance.now();
}

const approach = (cur: number, to: number, up: number, down: number, dt: number) =>
  cur + (to - cur) * (1 - Math.exp(-(to > cur ? up : down) * dt));

export function tickMusic(dt: number) {
  const d = Math.min(dt, 0.1);
  // No frames for a while (silence or sync off): let everything settle.
  const stale = !music.enabled || performance.now() - lastFrameAt > 400;
  const k = stale ? 0 : 1;
  music.level = approach(music.level, target.level * k, 18, 5, d);
  music.bass = approach(music.bass, target.bass * k, 20, 6, d);
  music.mid = approach(music.mid, target.mid * k, 16, 5, d);
  music.treble = approach(music.treble, target.treble * k, 22, 7, d);
  for (let i = 0; i < MUSIC_BANDS; i++) music.bands[i] = approach(music.bands[i], target.bands[i] * k, 24, 6, d);
  music.beat = Math.max(0, music.beat - d * 3.2);
  music.silentFor = music.level > 0.02 ? 0 : music.silentFor + d;
}

/** Effect strength: user intensity, faded out after a few seconds of silence. */
export function musicStrength(reducedMotion: boolean): number {
  if (!music.enabled) return 0;
  const fade = Math.max(0, 1 - Math.max(0, music.silentFor - 1.5) / 2);
  return music.intensity * fade * (reducedMotion ? 0.35 : 1);
}

/** Band average over a 0..1 slice of the spectrum. */
export function bandRange(from: number, to: number): number {
  const a = Math.floor(from * MUSIC_BANDS);
  const b = Math.max(a + 1, Math.floor(to * MUSIC_BANDS));
  let s = 0;
  for (let i = a; i < b; i++) s += music.bands[i];
  return s / (b - a);
}
