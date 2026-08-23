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

export type FixturePart =
  | 'vocals' | 'lead' | 'backing'
  | 'drums' | 'kick' | 'kit' | 'snare' | 'toms' | 'cymbals'
  | 'bass' | 'other';

export interface Fixture {
  mix: Float32Array[];
  /**
   * Every part, at every level of the tree — the leaves are what was actually
   * synthesised and the parents are their sums, so a test can measure a split
   * at whichever depth it cares about.
   */
  parts: Record<FixturePart, Float32Array[]>;
  length: number;
  sampleRate: number;
}

export interface FixtureOptions {
  /** A melody that cycles like a chorus, or one that keeps moving like a verse. */
  vocalCycles?: boolean;
  /**
   * Make it as hard as a record.
   *
   * The easy fixture scored the separator at 4.7 dB.  The same separator, run
   * on a real song's stems, scored −2.03 dB — the test was seven decibels
   * optimistic, which is the difference between "usable" and "barely better
   * than doing nothing".  Three things were missing, and each was measured
   * against the real run rather than guessed:
   *
   *   A KICK THAT SUSTAINS.  The easy kick decays in 70 ms and lives under
   *   100 Hz.  A modern kick is compressed until its low tail holds for a
   *   quarter of a second, straight through the bass note underneath it.  On
   *   the real song 58 % of the drums came back inside the bass stem.
   *
   *   REVERB.  Everything on a record is in a room.  A tail turns a transient
   *   into something that is partly sustained and smears the panning cue that
   *   the vocal separation runs on.
   *
   *   A CROWDED "그 외".  The easy fixture puts one pad there.  The real song
   *   puts guitar, keys, strings, brass, woodwinds and synth there — most of
   *   the arrangement, spread across the whole spectrum.
   */
  hard?: boolean;
}

export function buildFixture(
  seconds = 20, options: FixtureOptions = {},
): Fixture {
  const hard = options.hard === true;
  const sr = FIXTURE_SR;
  const n = Math.round(sr * seconds);
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const pair = (): Float32Array[] => [new Float32Array(n), new Float32Array(n)];
  const parts: Record<FixturePart, Float32Array[]> = {
    vocals: pair(), lead: pair(), backing: pair(),
    drums: pair(), kick: pair(), kit: pair(),
    snare: pair(), toms: pair(), cymbals: pair(),
    bass: pair(), other: pair(),
  };
  const add = (part: Float32Array[], c: number, i: number, v: number): void => {
    if (i >= 0 && i < n) part[c]![i] = (part[c]![i] ?? 0) + v;
  };

  const beat = 60 / 120;

  // BASS — two-bar loop, centred, harmonics up to ~400 Hz.
  //
  // The hard loop is an octave down.  Measured on the real song, 26 % of the
  // bass's energy is below 45 Hz; the easy loop's lowest note is 55 Hz, which
  // puts 1 % there — so in the easy fixture the bottom octave is 55 % kick and
  // 1 % bass and telling them apart is not a problem at all.  That is why
  // 드럼→베이스 was 24 % here and 58 % on the record.
  const notes = hard ? [41.2, 41.2, 55.0, 49.0] : [55, 55, 82.41, 65.41];
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

  // DRUMS — a kit, one piece at a time, so a test can ask where each went.
  //
  // KICK: a pitch-dropping sine, centred, all of it under 100 Hz.
  // SNARE: shell around 190 Hz plus the wires as broadband noise, centred.
  // HATS: short metallic noise every eighth, panned wide.
  // TOMS: a four-hit fill in the last bar of every four — pitched, low-mid,
  //       almost no noise, which is exactly why it is the hard one.
  for (let step = 0; step * beat < seconds; step++) {
    const at = Math.round(step * beat * sr);
    if (step % 2 === 0) {
      // A compressed kick: the pitch drop is the same, but the envelope holds
      // instead of decaying, so its low end sits on top of the bass note for a
      // quarter of a second the way a modern record's does.
      const tail = hard ? 11000 : 3000;
      // The easy kick sweeps 60 → 35 Hz, which puts 71 % of it below 45 Hz.
      // A real one measured on the record is 4 % below 45, 52 % at 63 and 29 %
      // at 125: it starts as a click up at 150 and SETTLES at its note, and
      // the beater's punch in the low mids is most of what a listener hears.
      // Sweeping down past the note instead of onto it is a 1980s drum machine,
      // and it made the bottom octave far easier than it is.
      let phase = 0;
      for (let i = 0; i < tail; i++) {
        const env = hard
          ? Math.exp(-i / 5200) * (1 - 0.55 * Math.exp(-i / 300))
          : Math.exp(-i / 900);
        let v: number;
        if (hard) {
          const hz = 55 + 105 * Math.exp(-i / 700);
          phase += (2 * Math.PI * hz) / sr;
          // The punch: a second, shorter voice an octave and a half up, which
          // is what fills 125–250 Hz.
          v = 0.8 * env * Math.sin(phase)
            + 0.85 * Math.exp(-i / 1300) * Math.sin(phase * 2.4);
        } else {
          v = 0.8 * env * Math.sin((2 * Math.PI * (60 - (25 * i) / 3000) * i) / sr);
        }
        add(parts.kick, 0, at + i, v);
        add(parts.kick, 1, at + i, v);
      }
    } else {
      const hp = { lp: 0 };
      for (let i = 0; i < 3000; i++) {
        const env = Math.exp(-i / 500);
        const body = 0.4 * env * Math.sin((2 * Math.PI * 190 * i) / sr);
        const wires = 0.9 * Math.exp(-i / 1400) * highpass(hp, rnd());
        add(parts.snare, 0, at + i, body + wires);
        add(parts.snare, 1, at + i, body + wires);
      }
    }
    for (const off of [0, 0.5]) {
      const h = at + Math.round(off * beat * sr);
      const hp = { lp: 0 };
      for (let i = 0; i < 1200; i++) {
        const env = Math.exp(-i / 260) * 0.25 * highpass(hp, rnd());
        add(parts.cymbals, 0, h + i, env * 1.25);
        add(parts.cymbals, 1, h + i, env * 0.55);
      }
    }
    if (step % 16 >= 12) {
      const tom = [140, 118, 96, 82][step % 4] ?? 110;
      for (let i = 0; i < 5000; i++) {
        const env = Math.exp(-i / 1600) * Math.min(1, i / 60);
        const v = 0.55 * env * (Math.sin((2 * Math.PI * tom * i) / sr)
          + 0.35 * Math.sin((2 * Math.PI * tom * 2.1 * i) / sr));
        add(parts.toms, 0, at + i, v);
        add(parts.toms, 1, at + i, v);
      }
    }
  }

  // OTHER — a pad, and on the hard setting the rest of an arrangement with it.
  for (let i = 0; i < n; i++) {
    for (const f of [261.63, 329.63, 392.0]) {
      parts.other[0]![i] = (parts.other[0]![i] ?? 0) + 0.09 * Math.sin((2 * Math.PI * f * i) / sr);
      parts.other[1]![i] = (parts.other[1]![i] ?? 0) + 0.09 * Math.sin((2 * Math.PI * f * i) / sr + 1.9);
    }
  }
  if (hard) {
    // Guitar: eighth-note chords, panned left, with a plucked transient — so
    // part of it reads as percussive and part as harmonic, like the real thing.
    for (let step = 0; step * (beat / 2) < seconds; step++) {
      const at = Math.round(step * (beat / 2) * sr);
      for (const f of [196.0, 246.94, 293.66]) {
        for (let i = 0; i < 0.4 * sr; i++) {
          const env = Math.exp(-i / 3500) * Math.min(1, i / 40);
          const v = 0.12 * env * (Math.sin((2 * Math.PI * f * i) / sr)
            + 0.4 * Math.sin((2 * Math.PI * f * 2 * i) / sr)
            + 0.25 * Math.sin((2 * Math.PI * f * 3 * i) / sr));
          add(parts.other, 0, at + i, v * 1.3);
          add(parts.other, 1, at + i, v * 0.5);
        }
      }
    }
    // Keys: a centred piano-ish figure, right where a vocal lives.
    const figure = [523.25, 659.26, 587.33, 493.88];
    for (let step = 0; step * beat < seconds; step++) {
      const f = figure[step % figure.length]!;
      const at = Math.round(step * beat * sr);
      for (let i = 0; i < 0.55 * sr; i++) {
        const env = Math.exp(-i / 6000) * Math.min(1, i / 60);
        const v = 0.1 * env * (Math.sin((2 * Math.PI * f * i) / sr)
          + 0.3 * Math.sin((2 * Math.PI * f * 2.01 * i) / sr));
        add(parts.other, 0, at + i, v);
        add(parts.other, 1, at + i, v);
      }
    }
    // Strings and brass: sustained, wide, filling the mid and the top.
    // Bowed strings and a brass section are BRIGHT — the harmonic series of a
    // sawtooth runs to the end of hearing — and leaving them as pure sines
    // stopped the whole arrangement at 1.4 kHz.  Measured on the record, 그 외
    // reaches 16 k and 85–90 % of it up there was landing in the drums stem;
    // a fixture with nothing up there cannot show that at all.
    for (let i = 0; i < n; i++) {
      const swell = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (sr * 4));
      for (const f of [440.0, 554.37, 659.26, 880.0]) {
        for (let k = 1; k <= 14; k++) {
          if (f * k > sr * 0.45) break;
          const v = (0.045 / k) * swell * Math.sin((2 * Math.PI * f * k * i) / sr);
          parts.other[0]![i] = (parts.other[0]![i] ?? 0) + v;
          parts.other[1]![i] = (parts.other[1]![i] ?? 0) + v * Math.cos(f * k * 0.003);
        }
      }
    }
    // Synth: sixteenth-note bright stabs, wide.  This is the part that looks
    // most like a hi-hat to anything that only asks "was this brief and
    // broadband" — which is the point of putting it here.
    const shimmer = { lp: 0 };
    for (let step = 0; step * (beat / 4) < seconds; step++) {
      const at = Math.round(step * (beat / 4) * sr);
      for (let i = 0; i < 0.16 * sr; i++) {
        const env = Math.exp(-i / 1500) * Math.min(1, i / 30);
        const bright = 0.16 * env * highpass(shimmer, highpass(shimmer, rnd()));
        let tone = 0;
        for (const f of [1174.66, 1567.98, 2093.0]) {
          tone += 0.02 * env * Math.sin((2 * Math.PI * f * i) / sr);
        }
        add(parts.other, 0, at + i, (tone + bright) * 0.7);
        add(parts.other, 1, at + i, (tone + bright) * 1.3);
      }
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
      add(parts.lead, 0, at + i, 0.5 * env * v);
      add(parts.lead, 1, at + i, 0.5 * env * v);
    }
    // A consonant, in two parts.  The plosive is the transient that was always
    // here.  The SIBILANT was not, and it is the whole of the third defect the
    // record showed: an "s" is a couple of hundred milliseconds of noise above
    // 4 kHz, and the vocal was allowed to claim 35 % of a percussive bin, so
    // half of every one of them was going to the drums stem.  A fixture whose
    // vocal has nothing above 2.8 kHz cannot show that.
    const sib = { lp: 0 };
    for (let i = 0; i < 900; i++) {          // plosive: a click, not a note
      const v = 0.25 * Math.exp(-i / 220) * rnd();
      add(parts.lead, 0, at + i, v);
      add(parts.lead, 1, at + i, v);
    }
    if (hard) {
      for (let i = 0; i < Math.round(0.22 * sr); i++) {
        const env = Math.min(1, i / 600) * Math.exp(-i / 3200);
        // Twice-highpassed, so it is hiss and not a full-band burst.
        const v = 0.5 * env * highpass(sib, highpass(sib, rnd()));
        add(parts.lead, 0, at + i, v);
        add(parts.lead, 1, at + i, v);
      }
    }
    // 코러스: the same line a third and a fifth up, doubled, each double
    // pushed to one side and detuned against the other — which is how they
    // are actually recorded, and why they stop reading as "centred".
    for (const [ratio, pan] of [[1.26, -1], [1.5, 1]] as const) {
      for (let i = 0; i < 0.75 * sr; i++) {
        const env = Math.min(1, i / 2600) * Math.min(1, (0.75 * sr - i) / 4200);
        let v = 0;
        for (let k = 1; k <= 4; k++) {
          v += (0.2 / k) * Math.sin((2 * Math.PI * f0 * ratio * k * i) / sr);
        }
        const l = 0.5 - 0.34 * pan;
        add(parts.backing, 0, at + i, env * v * l);
        add(parts.backing, 1, at + i, env * v * (1 - l));
      }
    }
  }

  if (hard) {
    // A room, on everything except the kick.
    //
    // This is the setting that matters most and is easiest to leave out.  A
    // reverb tail turns a transient into something partly sustained, so the
    // harmonic/percussive split gets less certain; and it decorrelates the two
    // channels, so the panning cue the whole vocal separation runs on gets
    // blurred.  Both are exactly what makes a record harder than a synthesis.
    const roomed: FixturePart[] = ['lead', 'backing', 'snare', 'toms', 'cymbals', 'other'];
    for (const part of roomed) reverb(parts[part], sr, part === 'other' ? 0.22 : 0.16);
  }

  // Parents are the sum of their leaves, so a test can measure at any depth
  // and the two levels cannot disagree about what the truth is.
  const roll = (parent: FixturePart, children: FixturePart[]): void => {
    for (const child of children) {
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < n; i++) {
          parts[parent][c]![i] = (parts[parent][c]![i] ?? 0) + (parts[child][c]![i] ?? 0);
        }
      }
    }
  };
  roll('vocals', ['lead', 'backing']);
  roll('kit', ['snare', 'toms', 'cymbals']);
  roll('drums', ['kick', 'kit']);

  const mix = pair();
  for (const key of ['vocals', 'drums', 'bass', 'other'] as const) {
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) mix[c]![i] = (mix[c]![i] ?? 0) + (parts[key][c]![i] ?? 0);
    }
  }
  return { mix, parts, length: n, sampleRate: sr };
}

/**
 * A one-pole high-pass, applied to the noise itself.
 *
 * It has to take the sample as an argument.  The first version took only the
 * index and filtered a constant, which made it an ENVELOPE that decayed over
 * twenty samples rather than a filter — so the "wires" and the "hats" it was
 * shaping came out as half-millisecond clicks with a flat spectrum, and the
 * drum classifier was being tuned against a kit that did not exist.
 */
/**
 * A small stereo room, added in place.
 *
 * Four early reflections and a decaying tail, different per channel so the
 * result is wide — which is the point.  Not a good reverb; a sufficient one.
 * What the test needs is a tail that smears transients and decorrelates the
 * channels, and this is the cheapest thing that does both.
 */
function reverb(channels: Float32Array[], sr: number, wet: number): void {
  const taps = [
    { delay: 0.0231, gain: 0.62 }, { delay: 0.0411, gain: 0.48 },
    { delay: 0.0673, gain: 0.36 }, { delay: 0.0977, gain: 0.28 },
  ];
  for (let c = 0; c < channels.length; c++) {
    const dry = channels[c]!;
    const out = new Float32Array(dry.length);
    // Offset one channel so the two rooms are not the same room.
    const skew = c === 0 ? 1 : 1.17;
    for (const tap of taps) {
      const d = Math.round(tap.delay * skew * sr);
      for (let i = d; i < dry.length; i++) out[i] = (out[i] ?? 0) + (dry[i - d] ?? 0) * tap.gain;
    }
    // A comb tail on top, so the decay keeps going past the reflections.
    const loop = Math.round(0.037 * skew * sr);
    for (let i = loop; i < out.length; i++) out[i] = (out[i] ?? 0) + (out[i - loop] ?? 0) * 0.55;
    for (let i = 0; i < dry.length; i++) dry[i] = (dry[i] ?? 0) + (out[i] ?? 0) * wet;
  }
}

function highpass(state: { lp: number }, x: number): number {
  state.lp = 0.82 * state.lp + 0.18 * x;
  return x - state.lp;
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
  over: readonly FixturePart[] = ['vocals', 'drums', 'bass', 'other'],
): Record<string, Record<string, number>> {
  const kinds = over;
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
