// The kit — which piece a pitch is, and what that piece sounds like.
//
// A drum kit is the one instrument where PITCH DOES NOT MEAN PITCH.  Note 36
// is not a low C, it is a kick; note 42 is not an F#, it is a closed hi-hat.
// Every other instrument in this engine takes the note number, turns it into
// a frequency and plays it; a kit that did that would answer a drum part with
// a chromatic run of bleeps, which is exactly what this app did until now —
// the drum map named the rows and ordered them and choked the hats, and then
// handed the part to a poly synth.
//
// So this module is two things:
//
//   · a TABLE from General MIDI pitch to a piece of a kit, and
//   · the numbers that make each piece sound like itself.
//
// The synthesis lives in `instruments.ts` with the others; what is here is
// everything that can be decided without an audio context, so the mapping and
// the tuning can be measured by a test rather than by ear.
//
// ── Why synthesised rather than sampled ─────────────────────────────────────
//
// The sampler landed first, and a sampled kit through it is genuinely better
// than this one — that is what the SFZ path is for.  But a sampled kit needs
// somebody to supply the samples, and a DAW whose drum track is silent until
// you go and find a library is a DAW you cannot start a song in.  Synthesised
// drums have one property no sample library has: they are always there.
//
// ── Deterministic noise ────────────────────────────────────────────────────
//
// Half the kit is filtered noise.  `Math.random()` would make every bounce
// differ from the preview it was auditioned against, and nothing downstream
// would notice.  The noise is seeded from the note, like the guitars, so the
// same hit is the same sound every time and two hits in a row are not.

/** The families, which is what decides HOW a piece is made. */
export type DrumFamily =
  | 'kick' | 'snare' | 'rim' | 'clap' | 'hat' | 'tom'
  | 'cymbal' | 'bell' | 'cowbell' | 'shaker';

export interface DrumSpec {
  family: DrumFamily;
  name: string;
  /** Fundamental for pitched pieces; noise band centre for the rest. */
  hz: number;
  /**
   * How long the hit rings at `decay = 1`, in seconds — to SILENCE, not to
   * inaudible.  The envelope is exponential, so the AUDIBLE tail is about
   * 0.55 of this: a cymbal written as 1.6 s here was measured dead at 0.88 s,
   * which is a splash, not a crash.  Real crashes ring for seconds, so the
   * cymbals carry numbers that look absurdly long and are not.
   */
  decay: number;
  /** This piece's loudness within the kit — a crash is not a cowbell. */
  level: number;
  /**
   * Stereo position, −1..1, DRUMMER's perspective — hi-hat left, floor tom
   * and ride right.  That is the default of nearly every drum library, and a
   * kit that is mono in the middle sounds like a drum machine even when the
   * pieces are right.
   */
  pan: number;
  /**
   * Pitched pieces: where the pitch sweep STARTS, as a multiple of `hz`.
   *
   * This is what makes a kick a kick rather than a low sine: the beater
   * arriving is a fast drop from about two octaves up, and without it the
   * same oscillator is a bass note.
   */
  sweep: number;
  /** Noise brightness: the highpass corner as a multiple of `hz`. */
  tone: number;
  /**
   * The ceiling, in Hz — a LOWPASS over the noise voices.
   *
   * `tone` alone cannot make a kit dark, and it took a measurement to see it:
   * every noise voice here is HIGHPASSED, so lowering that corner passes MORE
   * top, not less.  A 로파이 kit asked for "no air above 9 kHz" and measured
   * 2.3x K-POP's rather than a third of it.  Darkness needs its own control.
   *
   * Effectively open by default: 18 kHz is above anything these voices make.
   */
  air: number;
}

/**
 * General MIDI, covering every slot the built-in drum map names.
 *
 * The pitches are GM's, not a choice — a part written in any other program,
 * or imported from any .mid, arrives with these numbers.  The map's O-note
 * rewrite happens BEFORE this table is consulted (`playedNotes`), so a custom
 * kit that puts its kick on 24 still lands here as whatever it was mapped to.
 */
export const DRUM_KIT: Readonly<Record<number, DrumSpec>> = {
  // ── Kicks ────────────────────────────────────────────────────────────────
  35: { family: 'kick',  name: '킥 2',            hz: 48,   decay: 0.42, level: 1.00, pan:  0.00, sweep: 3.6, tone: 1, air: 18000 },
  36: { family: 'kick',  name: '킥',              hz: 55,   decay: 0.34, level: 1.00, pan:  0.00, sweep: 4.2, tone: 1, air: 18000 },
  // ── Snares and their relatives ───────────────────────────────────────────
  37: { family: 'rim',   name: '사이드 스틱',      hz: 1700, decay: 0.06, level: 0.55, pan: -0.05, sweep: 1, tone: 2.2, air: 18000 },
  38: { family: 'snare', name: '스네어',          hz: 190,  decay: 0.20, level: 0.90, pan: -0.05, sweep: 1, tone: 8.5, air: 18000 },
  39: { family: 'clap',  name: '핸드 클랩',        hz: 1000, decay: 0.24, level: 0.75, pan:  0.15, sweep: 1, tone: 1.6, air: 18000 },
  40: { family: 'snare', name: '스네어 (림)',      hz: 240,  decay: 0.16, level: 0.85, pan: -0.05, sweep: 1, tone: 11, air: 18000 },
  // ── Toms, low to high ────────────────────────────────────────────────────
  41: { family: 'tom',   name: '로우 플로어 톰',    hz: 72,   decay: 0.62, level: 0.85, pan:  0.34, sweep: 1.6, tone: 1, air: 18000 },
  43: { family: 'tom',   name: '하이 플로어 톰',    hz: 88,   decay: 0.56, level: 0.85, pan:  0.26, sweep: 1.6, tone: 1, air: 18000 },
  45: { family: 'tom',   name: '로우 톰',          hz: 105,  decay: 0.50, level: 0.85, pan:  0.14, sweep: 1.6, tone: 1, air: 18000 },
  47: { family: 'tom',   name: '로우-미드 톰',      hz: 128,  decay: 0.45, level: 0.85, pan:  0.02, sweep: 1.6, tone: 1, air: 18000 },
  48: { family: 'tom',   name: '하이-미드 톰',      hz: 156,  decay: 0.40, level: 0.85, pan: -0.10, sweep: 1.6, tone: 1, air: 18000 },
  50: { family: 'tom',   name: '하이 톰',          hz: 190,  decay: 0.36, level: 0.85, pan: -0.22, sweep: 1.6, tone: 1, air: 18000 },
  // ── Hats.  The map chokes them; the decays are what make them different. ─
  42: { family: 'hat',   name: '클로즈드 하이햇',   hz: 7600, decay: 0.045, level: 0.55, pan: -0.28, sweep: 1, tone: 1, air: 18000 },
  44: { family: 'hat',   name: '페달 하이햇',       hz: 6400, decay: 0.085, level: 0.50, pan: -0.28, sweep: 1, tone: 1, air: 18000 },
  46: { family: 'hat',   name: '오픈 하이햇',       hz: 7000, decay: 0.90,  level: 0.55, pan: -0.28, sweep: 1, tone: 1, air: 18000 },
  // ── Cymbals ──────────────────────────────────────────────────────────────
  49: { family: 'cymbal', name: '크래시 1',        hz: 5200, decay: 3.20, level: 0.70, pan: -0.42, sweep: 1, tone: 1, air: 18000 },
  57: { family: 'cymbal', name: '크래시 2',        hz: 4600, decay: 3.60, level: 0.70, pan:  0.40, sweep: 1, tone: 1, air: 18000 },
  51: { family: 'bell',  name: '라이드',           hz: 5800, decay: 2.00, level: 0.55, pan:  0.36, sweep: 1, tone: 1, air: 18000 },
  59: { family: 'bell',  name: '라이드 2',         hz: 5400, decay: 2.20, level: 0.55, pan:  0.36, sweep: 1, tone: 1, air: 18000 },
  53: { family: 'bell',  name: '라이드 벨',        hz: 6200, decay: 1.50, level: 0.60, pan:  0.36, sweep: 1, tone: 1, air: 18000 },
  52: { family: 'cymbal', name: '차이니즈',        hz: 3800, decay: 2.60, level: 0.65, pan:  0.46, sweep: 1, tone: 1, air: 18000 },
  55: { family: 'cymbal', name: '스플래시',        hz: 6800, decay: 1.10, level: 0.55, pan: -0.36, sweep: 1, tone: 1, air: 18000 },
  // ── Hand percussion ──────────────────────────────────────────────────────
  54: { family: 'shaker', name: '탬버린',          hz: 8200, decay: 0.16, level: 0.45, pan:  0.22, sweep: 1, tone: 1, air: 18000 },
  56: { family: 'cowbell', name: '카우벨',         hz: 540,  decay: 0.30, level: 0.50, pan:  0.18, sweep: 1, tone: 1, air: 18000 },
  58: { family: 'shaker', name: '비브라슬랩',       hz: 3200, decay: 0.45, level: 0.45, pan:  0.30, sweep: 1, tone: 1, air: 18000 },
};

/**
 * The piece a note plays.
 *
 * An unmapped pitch takes the NEAREST mapped one rather than silence.  A drum
 * part that came from somewhere else can easily name 60 or 70; a kit that
 * answered those with nothing would read as "the drums are broken", and the
 * nearest neighbour is at least the right family — 60 is a bongo in GM and
 * lands on the nearest tom-ish neighbour here.
 */
export function drumSpecFor(pitch: number): DrumSpec {
  const exact = DRUM_KIT[pitch];
  if (exact) return exact;
  let best: DrumSpec | undefined;
  let bestDistance = Infinity;
  for (const key of Object.keys(DRUM_KIT)) {
    const p = Number(key);
    const d = Math.abs(p - pitch);
    if (d < bestDistance) { bestDistance = d; best = DRUM_KIT[p]; }
  }
  // The table is a non-empty literal, so this fallback is unreachable in
  // practice — it exists so the return type is not a lie.
  return best ?? DRUM_KIT[36]!;
}

/** Every pitch the kit answers to, ascending. */
export function kitPitches(): number[] {
  return Object.keys(DRUM_KIT).map(Number).sort((a, b) => a - b);
}

/**
 * A seeded PRNG — the same one the strings use.
 *
 * Small, fast, and above all REPEATABLE, which is the whole point: a bounce
 * has to sound like the preview it was approved from.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White noise, deterministic for a given seed. */
export function noiseSamples(length: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rnd() * 2 - 1;
  return out;
}

/**
 * The clap's bursts, as offsets in seconds.
 *
 * A clap is not one noise burst — it is several hands not quite together,
 * and it is the SPREAD that makes it read as a clap rather than as a short
 * snare.  Three quick repeats and then the room.
 */
export const CLAP_OFFSETS: readonly number[] = [0, 0.011, 0.023, 0.036];
