// The modulation matrix — what makes a synth deep rather than merely large.
//
// A synth with fifty knobs and no matrix is fifty knobs.  A synth with the
// same fifty and a matrix is fifty knobs each of which can be driven by any
// of sixteen things, and THAT is the difference between a preset you loaded
// and a sound you made.  Everything below exists to make one sentence true:
// any source can reach any destination, by any amount, per voice.
//
// ── Why it is numbers and not objects ───────────────────────────────────────
//
// A track carries `instrumentParams: Record<string, number>` and nothing
// else, and that is not a limitation to work around — it is why save, undo,
// templates, freeze, bounce and automation all work on any instrument without
// being taught what its parameters mean.  So a matrix row is three numbers:
//
//     m3src = 5      LFO 2
//     m3dst = 5      Cutoff
//     m3amt = -0.62  down, hard
//
// and eight rows are twenty-four ordinary parameters that every one of those
// systems already handles.  The same trick the drum kit's `kit` index and the
// poly synth's `wave` index use, for the same reason.
//
// ── Why the source list has a RANDOM in it ──────────────────────────────────
//
// Per NOTE, not per sample.  A new random value each time a key goes down is
// the cheapest way to stop a repeated part sounding like a loop, and it is
// deterministic here — seeded from the note — because this engine's standing
// rule is that a bounce sounds like the preview.  A `Math.random()` in a
// modulation source would break that on every render.

/** A modulation source, in the order `mNsrc` indexes them. */
export interface ModSource {
  id: string;
  name: string;
  /**
   * Whether the source swings either side of zero.
   *
   * It decides what a depth MEANS.  An envelope at depth 1 on cutoff opens
   * the filter by the full amount and never closes it below where the knob
   * is; an LFO at depth 1 does half of each.  Getting this wrong makes every
   * LFO assignment sound like it is half the depth you asked for.
   */
  bipolar: boolean;
}

export const MOD_SOURCES: readonly ModSource[] = [
  { id: 'off',   name: '—',        bipolar: false },
  { id: 'env1',  name: 'ENV 1',    bipolar: false },
  { id: 'env2',  name: 'ENV 2',    bipolar: false },
  { id: 'env3',  name: 'ENV 3',    bipolar: false },
  { id: 'lfo1',  name: 'LFO 1',    bipolar: true },
  { id: 'lfo2',  name: 'LFO 2',    bipolar: true },
  { id: 'lfo3',  name: 'LFO 3',    bipolar: true },
  { id: 'lfo4',  name: 'LFO 4',    bipolar: true },
  { id: 'vel',   name: 'VELO',     bipolar: false },
  { id: 'note',  name: 'NOTE',     bipolar: true },
  { id: 'rand',  name: 'RAND',     bipolar: true },
  { id: 'mac1',  name: 'MACRO 1',  bipolar: false },
  { id: 'mac2',  name: 'MACRO 2',  bipolar: false },
  { id: 'mac3',  name: 'MACRO 3',  bipolar: false },
  { id: 'mac4',  name: 'MACRO 4',  bipolar: false },
  { id: 'wheel', name: 'MOD WHL',  bipolar: false },
  { id: 'press', name: 'PRESSURE', bipolar: false },
];

/**
 * A modulation destination.
 *
 * `span` is what a depth of 1 is worth, in the destination's own unit — so a
 * depth is always −1…1 and the knob under it never has to know whether it is
 * driving cents, hertz or a level.  That uniformity is the whole reason a
 * matrix can be a grid of identical rows.
 */
export interface ModDest {
  id: string;
  name: string;
  span: number;
  unit: string;
}

export const MOD_DESTS: readonly ModDest[] = [
  { id: 'off',      name: '—',          span: 0,    unit: '' },
  { id: 'aPos',     name: 'A WT POS',   span: 7,    unit: 'fr' },
  { id: 'bPos',     name: 'B WT POS',   span: 7,    unit: 'fr' },
  { id: 'aPitch',   name: 'A PITCH',    span: 2400, unit: 'ct' },
  { id: 'bPitch',   name: 'B PITCH',    span: 2400, unit: 'ct' },
  { id: 'cutoff',   name: 'CUTOFF',     span: 96,   unit: 'st' },
  { id: 'res',      name: 'RES',        span: 1,    unit: '' },
  { id: 'aLevel',   name: 'A LEVEL',    span: 1,    unit: '' },
  { id: 'bLevel',   name: 'B LEVEL',    span: 1,    unit: '' },
  { id: 'subLevel', name: 'SUB LEVEL',  span: 1,    unit: '' },
  { id: 'noise',    name: 'NOISE',      span: 1,    unit: '' },
  { id: 'aPan',     name: 'A PAN',      span: 1,    unit: '' },
  { id: 'bPan',     name: 'B PAN',      span: 1,    unit: '' },
  { id: 'aDetune',  name: 'A DETUNE',   span: 50,   unit: 'ct' },
  { id: 'bDetune',  name: 'B DETUNE',   span: 50,   unit: 'ct' },
  { id: 'drive',    name: 'DRIVE',      span: 1,    unit: '' },
  { id: 'aPhase',   name: 'A PHASE',    span: 1,    unit: '' },
  { id: 'bPhase',   name: 'B PHASE',    span: 1,    unit: '' },
  { id: 'amp',      name: 'AMP',        span: 1,    unit: '' },
];

/** How many rows the matrix has.  Eight is what fits on one screen. */
export const MATRIX_ROWS = 8;

export interface MatrixRow {
  src: number;
  dst: number;
  amt: number;
}

/** The parameter ids one row occupies. */
export function rowParams(row: number): { src: string; dst: string; amt: string } {
  return { src: `m${row + 1}src`, dst: `m${row + 1}dst`, amt: `m${row + 1}amt` };
}

/**
 * The rows that are actually doing something.
 *
 * A row with no source, no destination or no depth is skipped rather than
 * evaluated to zero — eight rows evaluated per sample when one is in use is
 * eight times the work for the same silence.
 */
export function activeRows(params: Readonly<Record<string, number>>): MatrixRow[] {
  const out: MatrixRow[] = [];
  for (let r = 0; r < MATRIX_ROWS; r++) {
    const ids = rowParams(r);
    const src = Math.round(params[ids.src] ?? 0);
    const dst = Math.round(params[ids.dst] ?? 0);
    const amt = params[ids.amt] ?? 0;
    if (src <= 0 || dst <= 0 || Math.abs(amt) < 0.0005) continue;
    if (src >= MOD_SOURCES.length || dst >= MOD_DESTS.length) continue;
    out.push({ src, dst, amt });
  }
  return out;
}

/** A readable line for the UI and for tests: "LFO 2 → CUTOFF −60%". */
export function describeRow(row: MatrixRow): string {
  const s = MOD_SOURCES[row.src]?.name ?? '?';
  const d = MOD_DESTS[row.dst]?.name ?? '?';
  return `${s} → ${d} ${row.amt >= 0 ? '+' : ''}${Math.round(row.amt * 100)}%`;
}

// ── LFO shapes ──────────────────────────────────────────────────────────────

export const LFO_SHAPES = ['sine', 'triangle', 'saw up', 'saw down', 'square', 'S&H'] as const;
export type LfoShape = typeof LFO_SHAPES[number];

/**
 * One LFO cycle, −1…1, from a phase in turns.
 *
 * `skew` bends the shape without changing what it is: it warps the phase
 * before the shape is read, so a triangle at skew 0.9 is a saw and a sine at
 * skew 0.1 is a sharp swell.  One knob covering the space between the named
 * shapes is worth more than four more named shapes, because the useful
 * settings are mostly between them.
 *
 * `seed` is only read by sample-and-hold, and it makes that shape repeatable:
 * the same note renders the same steps every time, which is this engine's
 * rule and is also what lets a S&H part be double-tracked.
 */
export function lfoValue(shape: number, phase: number, skew: number, seed: number): number {
  const s = Math.max(0, Math.min(LFO_SHAPES.length - 1, Math.round(shape)));
  let p = phase - Math.floor(phase);
  // Warp: below 0.5 the first half of the cycle is compressed, above it the
  // second half is.  At exactly 0.5 this is the identity.
  const k = Math.max(0.02, Math.min(0.98, skew));
  p = p < k ? (p / k) * 0.5 : 0.5 + ((p - k) / (1 - k)) * 0.5;

  switch (s) {
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return p < 0.5 ? -1 + 4 * p : 3 - 4 * p;
    case 2: return -1 + 2 * p;
    case 3: return 1 - 2 * p;
    case 4: return p < 0.5 ? 1 : -1;
    default: {
      // Sample and hold: sixteen steps a cycle, from a hash of the step
      // index and the seed.  A hash rather than a running PRNG so that
      // jumping into the middle of a note — which an offline render does —
      // gives the same step it would have reached by playing up to it.
      const step = Math.floor(phase * 16);
      let h = (step * 374761393 + seed * 668265263) >>> 0;
      h = (h ^ (h >>> 13)) >>> 0;
      h = Math.imul(h, 1274126177) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
    }
  }
}

/**
 * A note's own random value, −1…1.
 *
 * Deterministic in the note's pitch and start, so the same bar renders the
 * same way every time and two renders of a part can be layered.
 */
export function noteRandom(pitch: number, startBeat: number, salt = 0): number {
  let h = ((pitch * 2654435761) ^ (Math.round(startBeat * 960) * 40503) ^ (salt * 2246822519)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 2147483648 - 1;
}
