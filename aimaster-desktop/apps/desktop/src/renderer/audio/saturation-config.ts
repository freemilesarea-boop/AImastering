// saturation-config — shared saturation/exciter config + helpers.
//
// One source of truth for the saturation shape used by the store, the UI
// panel, the offline-render request, the WASM `setSaturation` binding, and
// the WebAudio preview curve.  Mirrors the Rust SaturationConfig (dsp-core).
// Default = bypassed with drive 0 → no-op until enabled.

export type SaturationCharacter = 'warm' | 'tape' | 'tube' | 'modern';

/** WASM enum code: 0=Warm 1=Tape 2=Tube 3=Modern. */
export const CHARACTER_CODE: Record<SaturationCharacter, number> = { warm: 0, tape: 1, tube: 2, modern: 3 };
export const CHARACTERS: SaturationCharacter[] = ['warm', 'tape', 'tube', 'modern'];
export const CHARACTER_LABEL: Record<SaturationCharacter, string> = {
  warm: 'Warm', tape: 'Tape', tube: 'Tube', modern: 'Modern',
};

export interface SaturationConfig {
  bypass: boolean;
  character: SaturationCharacter;
  /** Drive 0..100 (%). 0 = clean. */
  drive: number;
  /** Dry/wet mix 0..100 (% wet). */
  mixPct: number;
  multibandEnabled: boolean;
  /** Per-band drive scaling %, [low, low-mid, high-mid, high]. */
  bandDrivesPct: [number, number, number, number];
  xoverLoHz: number;
  xoverMidHz: number;
  xoverHiHz: number;
}

export const SAT_RANGES = {
  drive: { min: 0, max: 100 },
  mixPct: { min: 0, max: 100 },
  bandDrivePct: { min: 0, max: 200 },
  xoverLoHz: { min: 20, max: 500 },
  xoverMidHz: { min: 200, max: 4000 },
  xoverHiHz: { min: 2000, max: 16000 },
} as const;

export const SAT_BAND_LABELS = ['저역', '저중역', '고중역', '고역'] as const;

/** Max pre-gain pushed into the shaper at drive 100 (dB) — matches Rust. */
const MAX_DRIVE_DB = 18.0;

const clamp = (v: number, lo: number, hi: number, fb: number): number => {
  const x = Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, x));
};

export function defaultSaturationConfig(): SaturationConfig {
  return {
    bypass: true, character: 'tape', drive: 0, mixPct: 100,
    multibandEnabled: false, bandDrivesPct: [100, 100, 100, 100],
    xoverLoHz: 120, xoverMidHz: 1000, xoverHiHz: 6000,
  };
}

export function sanitizeSaturation(cfg: SaturationConfig): SaturationConfig {
  let lo = clamp(cfg.xoverLoHz, SAT_RANGES.xoverLoHz.min, SAT_RANGES.xoverLoHz.max, 120);
  let mid = clamp(cfg.xoverMidHz, SAT_RANGES.xoverMidHz.min, SAT_RANGES.xoverMidHz.max, 1000);
  let hi = clamp(cfg.xoverHiHz, SAT_RANGES.xoverHiHz.min, SAT_RANGES.xoverHiHz.max, 6000);
  if (mid <= lo) mid = lo * 1.5;
  if (hi <= mid) hi = mid * 1.5;
  const character: SaturationCharacter = CHARACTERS.includes(cfg.character) ? cfg.character : 'tape';
  return {
    bypass: !!cfg.bypass,
    character,
    drive: clamp(cfg.drive, SAT_RANGES.drive.min, SAT_RANGES.drive.max, 0),
    mixPct: clamp(cfg.mixPct, SAT_RANGES.mixPct.min, SAT_RANGES.mixPct.max, 100),
    multibandEnabled: !!cfg.multibandEnabled,
    bandDrivesPct: cfg.bandDrivesPct.map((d) => clamp(d, SAT_RANGES.bandDrivePct.min, SAT_RANGES.bandDrivePct.max, 100)) as [number, number, number, number],
    xoverLoHz: lo, xoverMidHz: mid, xoverHiHz: hi,
  };
}

/** True when the stage would not alter the signal. */
export function isSaturationUnity(cfg: SaturationConfig): boolean {
  if (cfg.bypass || cfg.drive <= 0 || cfg.mixPct <= 0) return true;
  if (cfg.multibandEnabled) return cfg.bandDrivesPct.every((d) => d <= 0);
  return false;
}

/** Per-band drives as a Float64Array for the WASM `setSaturation`. */
export function packSaturationBandDrives(cfg: SaturationConfig): Float64Array {
  return Float64Array.from(sanitizeSaturation(cfg).bandDrivesPct);
}

// ── Shared waveshaper math (matches Rust `shape` exactly) ──────────────────

const db2lin = (db: number): number => Math.pow(10, db / 20);

/** Unit-slope-at-origin shaper for a character (matches dsp-core). */
export function shapeSample(character: SaturationCharacter, t: number): number {
  switch (character) {
    case 'warm': return t / (1 + Math.abs(t));
    case 'tape': return Math.tanh(t);
    case 'tube': return t >= 0 ? Math.tanh(t) : 0.85 * Math.tanh(t / 0.85);
    case 'modern': return t / Math.pow(1 + t * t * t * t, 0.25);
  }
}

/** Saturate one sample at a drive % (drive ≤ 0 → passthrough). */
export function saturateSample(character: SaturationCharacter, x: number, drivePct: number): number {
  if (drivePct <= 0) return x;
  const driveGain = db2lin((drivePct / 100) * MAX_DRIVE_DB);
  return shapeSample(character, x * driveGain) / driveGain;
}

/**
 * A WaveShaperNode curve (length `n`) for a character + drive, sampling the
 * shaper over the input range [-1, 1].  Used by the WebAudio preview so the
 * preview colour matches the Rust export.
 */
export function makeSaturationCurve(character: SaturationCharacter, drivePct: number, n = 1024) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // -1..1
    curve[i] = saturateSample(character, x, drivePct);
  }
  return curve;
}
