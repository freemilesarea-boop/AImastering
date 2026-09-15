// The sampler — which recording plays, and at what speed.
//
// This is the half of a sampler that has to be exactly right.  Everything
// else about a sampled instrument is the quality of the recordings; these two
// decisions are the difference between a library that plays and one that
// plays the wrong note, or the right note in the wrong octave, or the same
// note forever because a round robin never advances.
//
// ── Why a synthesised piano was not an option ───────────────────────────────
//
// The two guitars in `string-model.ts` are physically modelled and sound like
// guitars, because a plucked string genuinely IS a delay line and the model
// is the instrument.  A piano is not that.  Its tone comes from a hammer
// striking three slightly detuned strings coupled through a soundboard whose
// resonances are the instrument's identity, plus sympathetic ringing from
// every undamped string in the case.  Synthesising it convincingly is a
// decade of specialist work; synthesising it quickly gives you a 1985
// keyboard.  So a piano is recordings, and recordings need this.

import type { SfzInstrument, SfzRegion } from './sfz.js';

export interface SampleZone extends SfzRegion {
  /** Where the audio actually lives, once the library root is known. */
  resolvedPath: string;
}

export interface SampleSet {
  name: string;
  zones: SampleZone[];
  /** Opcodes the reader did not act on, carried through for the report. */
  unsupported: Record<string, number>;
}

/**
 * Join a library root, an SFZ `default_path` and a region's sample path.
 *
 * The root keeps its leading slash.  Trimming both ends of every part is the
 * obvious way to write this and it silently turns `/lib/piano` into
 * `lib/piano` — an absolute path becomes relative to wherever the process
 * happens to be, so a library loads on Windows and cannot be found on macOS
 * or Linux.
 */
export function resolveSamplePath(root: string, defaultPath: string, sample: string): string {
  const clean = (p: string): string => p.replace(/\\/g, '/');
  const head = clean(root).replace(/\/+$/, '');
  const rest = [defaultPath, sample]
    .map((p) => clean(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '');
  if (head === '') return rest.join('/');
  return [head, ...rest].join('/');
}

export function buildSampleSet(name: string, root: string, sfz: SfzInstrument): SampleSet {
  return {
    name,
    unsupported: sfz.unsupported,
    zones: sfz.regions.map((r) => ({
      ...r,
      resolvedPath: resolveSamplePath(root, sfz.defaultPath, r.sample),
    })),
  };
}

/**
 * How fast to play a recording so it sounds at the pitch asked for.
 *
 * A sample recorded at C4 played at C5 must run twice as fast.  `tune` is in
 * cents and `transpose` in semitones, and both belong in the exponent — a
 * library that fine-tunes a note by 8 cents means 8 cents at every pitch it is
 * stretched to, not 8 cents at the root and something else elsewhere.
 */
export function playbackRateFor(zone: SampleZone, pitch: number): number {
  const semitones = (pitch - zone.keyCenter) + zone.transpose + zone.tuneCents / 100;
  return Math.pow(2, semitones / 12);
}

/**
 * Every zone that answers to this key and velocity.
 *
 * Velocity arrives 0..1 from the note model and SFZ counts 1..127, so the
 * conversion happens here, once.  Doing it at each call site is how a
 * library's quietest layer ends up unreachable because one place rounded
 * down to 0.
 */
export function zonesFor(
  set: SampleSet, pitch: number, velocity01: number,
  trigger: 'attack' | 'release' = 'attack',
): SampleZone[] {
  const vel = Math.max(1, Math.min(127, Math.round(velocity01 * 127)));
  return set.zones.filter((z) =>
    z.trigger === trigger
    && pitch >= z.loKey && pitch <= z.hiKey
    && vel >= z.loVel && vel <= z.hiVel);
}

/**
 * Pick one zone, advancing the round robin.
 *
 * A round robin is why a repeated note on a good library does not sound like
 * a machine gun: the same key plays a different take each time.  The counter
 * belongs to the CALLER — one per instrument instance — because a shared
 * counter would make two tracks advance each other's takes, and a counter
 * reset per note would defeat the whole point by always choosing take 1.
 */
export function pickZone(
  candidates: readonly SampleZone[], sequenceCount: number,
): SampleZone | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Libraries express a round robin as seq_length/seq_position.  Where they
  // do, honour it; where several zones simply overlap, cycle them.
  const seq = candidates.filter((z) => z.seqPosition > 0);
  if (seq.length > 0) {
    const length = Math.max(...seq.map((z) => z.seqLength));
    const want = (sequenceCount % Math.max(1, length)) + 1;
    return seq.find((z) => z.seqPosition === want) ?? seq[0];
  }
  return candidates[sequenceCount % candidates.length];
}

/**
 * What the set can and cannot play, as plain facts.
 *
 * A library with a hole in it is common — half of them stop at C7, several
 * only cover one velocity — and a sampler that silently plays nothing there
 * is indistinguishable from a broken one.
 */
export interface SampleSetReport {
  zones: number;
  lowestKey: number;
  highestKey: number;
  /** Keys inside the range that no zone answers to. */
  gaps: number[];
  velocityLayers: number;
  roundRobin: number;
  releaseZones: number;
  unsupported: string[];
}

export function describeSampleSet(set: SampleSet): SampleSetReport {
  const attack = set.zones.filter((z) => z.trigger === 'attack');
  if (attack.length === 0) {
    return {
      zones: set.zones.length, lowestKey: 0, highestKey: 0, gaps: [],
      velocityLayers: 0, roundRobin: 0,
      releaseZones: set.zones.filter((z) => z.trigger === 'release').length,
      unsupported: Object.keys(set.unsupported).sort(),
    };
  }
  const lowest = Math.min(...attack.map((z) => z.loKey));
  const highest = Math.max(...attack.map((z) => z.hiKey));
  const gaps: number[] = [];
  for (let k = lowest; k <= highest; k++) {
    if (!attack.some((z) => k >= z.loKey && k <= z.hiKey)) gaps.push(k);
  }
  const bands = new Set(attack.map((z) => `${z.loVel}-${z.hiVel}`));
  return {
    zones: set.zones.length,
    lowestKey: lowest,
    highestKey: highest,
    gaps,
    velocityLayers: bands.size,
    roundRobin: Math.max(1, ...attack.map((z) => z.seqLength)),
    releaseZones: set.zones.filter((z) => z.trigger === 'release').length,
    unsupported: Object.keys(set.unsupported).sort(),
  };
}
