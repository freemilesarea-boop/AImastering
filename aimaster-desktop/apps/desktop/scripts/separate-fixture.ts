// A mix whose four parts are known, so separation can be MEASURED.
//
// Every part is synthesised separately and then summed, which means the test
// has the ground truth the real problem never does.  The parts are built to
// carry the cues the separator actually looks for, and — just as important —
// to carry the ways those cues go wrong:
//
//   the bass repeats on a two-bar loop and lives under 300 Hz, but its
//   harmonics run up past a kilohertz where the vocal is;
//   the kick is centred and low, which is the bass's territory;
//   the hats are panned wide, which is the "other" stem's;
//   the pad is loud, centred in level but decorrelated in phase, which is the
//   trap the panning cue falls into if it only looks at balance;
//   the voice is centred, has consonants that are transients rather than
//   notes, and can be asked to either cycle like a chorus or keep moving.
//
// Nothing is random from a global source: the noise generator is seeded and
// deterministic, so a run that fails fails the same way twice.

export const FIXTURE_SR = 44100;

export interface Fixture {
  mix: Float32Array[];
  parts: Record<'vocals' | 'drums' | 'bass' | 'other', Float32Array[]>;
  length: number;
  sampleRate: number;
}

export function buildFixture(
  seconds = 20, options: { vocalCycles?: boolean } = {},
): Fixture {
  const sr = FIXTURE_SR;
  const n = Math.round(sr * seconds);
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const pair = (): Float32Array[] => [new Float32Array(n), new Float32Array(n)];
  const parts = { vocals: pair(), drums: pair(), bass: pair(), other: pair() };
  const add = (part: Float32Array[], c: number, i: number, v: number): void => {
    if (i >= 0 && i < n) part[c]![i] = (part[c]![i] ?? 0) + v;
  };

  const beat = 60 / 120;

  // BASS — two-bar loop, centred, harmonics up to ~400 Hz.
  const notes = [55, 55, 82.41, 65.41];
  for (let step = 0; step * beat < seconds; step++) {
    const f0 = notes[step % notes.length]!;
    const at = Math.round(step * beat * sr);
    for (let i = 0; i < beat * sr * 0.9; i++) {
      const env = Math.min(1, i / 200) * Math.exp(-i / (sr * 0.35));
      let v = 0;
      for (let k = 1; k <= 5; k++) v += (0.5 / k) * Math.sin((2 * Math.PI * f0 * k * i) / sr);
      add(parts.bass, 0, at + i, 0.35 * env * v);
      add(parts.bass, 1, at + i, 0.35 * env * v);
    }
  }

  // DRUMS — kick and snare centred, hats panned wide.
  for (let step = 0; step * beat < seconds; step++) {
    const at = Math.round(step * beat * sr);
    const kick = step % 2 === 0;
    for (let i = 0; i < 3000; i++) {
      const env = Math.exp(-i / (kick ? 900 : 500));
      const v = kick
        ? 0.8 * env * Math.sin((2 * Math.PI * (60 - (25 * i) / 3000) * i) / sr)
        : 0.5 * env * (rnd() * 0.8 + 0.4 * Math.sin((2 * Math.PI * 190 * i) / sr));
      add(parts.drums, 0, at + i, v);
      add(parts.drums, 1, at + i, v);
    }
    for (const off of [0, 0.5]) {
      const h = at + Math.round(off * beat * sr);
      for (let i = 0; i < 1200; i++) {
        const env = Math.exp(-i / 260) * 0.12 * rnd();
        add(parts.drums, 0, h + i, env * 1.25);
        add(parts.drums, 1, h + i, env * 0.55);
      }
    }
  }

  // OTHER — a sustained pad, equal in level but decorrelated in phase.
  for (let i = 0; i < n; i++) {
    for (const f of [261.63, 329.63, 392.0]) {
      parts.other[0]![i] = (parts.other[0]![i] ?? 0) + 0.09 * Math.sin((2 * Math.PI * f * i) / sr);
      parts.other[1]![i] = (parts.other[1]![i] ?? 0) + 0.09 * Math.sin((2 * Math.PI * f * i) / sr + 1.9);
    }
  }

  // VOCALS — centred, vibrato, a consonant at each entry.
  const chorus = [392, 440, 349.23, 293.66, 329.63, 440, 493.88, 392, 261.63, 349.23];
  const verse = Array.from({ length: 200 }, (_, i) =>
    260 * Math.pow(2, ((i * 7) % 12) / 12) * (1 + (i % 3) * 0.02));
  const melody = options.vocalCycles === false ? verse : chorus;
  for (let note = 0; note * 0.9 < seconds; note++) {
    const f0 = melody[note % melody.length]!;
    const at = Math.round(note * 0.9 * sr);
    for (let i = 0; i < 0.75 * sr; i++) {
      const env = Math.min(1, i / 1500) * Math.min(1, (0.75 * sr - i) / 3000);
      const vib = 1 + 0.006 * Math.sin((2 * Math.PI * 5.5 * i) / sr);
      let v = 0;
      for (let k = 1; k <= 6; k++) v += (0.42 / k) * Math.sin((2 * Math.PI * f0 * k * vib * i) / sr);
      add(parts.vocals, 0, at + i, 0.5 * env * v);
      add(parts.vocals, 1, at + i, 0.5 * env * v);
    }
    for (let i = 0; i < 900; i++) {
      const v = 0.25 * Math.exp(-i / 220) * rnd();
      add(parts.vocals, 0, at + i, v);
      add(parts.vocals, 1, at + i, v);
    }
  }

  const mix = pair();
  for (const key of Object.keys(parts) as (keyof typeof parts)[]) {
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) mix[c]![i] = (mix[c]![i] ?? 0) + (parts[key][c]![i] ?? 0);
    }
  }
  return { mix, parts, length: n, sampleRate: sr };
}

export function toMono(channels: readonly Float32Array[]): Float32Array[] {
  const a = channels[0]!;
  const b = channels[1] ?? a;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = ((a[i] ?? 0) + (b[i] ?? 0)) * 0.5;
  return [out];
}

/**
 * How much of each true part ended up in each stem.
 *
 * `<stem, part> / <part, part>` is the gain of that part inside that stem, so
 * the diagonal is "how much of this instrument came back" and everything off
 * it is leakage.  Rows can total over 100 %: a part correlated with two stems
 * is counted in both, which is exactly what leakage means.
 */
export function leakageMatrix(
  parts: Fixture['parts'],
  stems: readonly { kind: string; channels: Float32Array[] }[],
): Record<string, Record<string, number>> {
  const kinds = ['vocals', 'drums', 'bass', 'other'] as const;
  const dot = (a: readonly Float32Array[], b: readonly Float32Array[]): number => {
    let sum = 0;
    for (let c = 0; c < Math.min(a.length, b.length); c++) {
      const x = a[c]!;
      const y = b[c]!;
      for (let i = 0; i < Math.min(x.length, y.length); i++) sum += (x[i] ?? 0) * (y[i] ?? 0);
    }
    return sum;
  };
  const out: Record<string, Record<string, number>> = {};
  for (const truth of kinds) {
    const self = dot(parts[truth], parts[truth]);
    out[truth] = {};
    for (const kind of kinds) {
      const stem = stems.find((s) => s.kind === kind);
      out[truth]![kind] = stem && self > 0 ? (100 * dot(stem.channels, parts[truth])) / self : 0;
    }
  }
  return out;
}
