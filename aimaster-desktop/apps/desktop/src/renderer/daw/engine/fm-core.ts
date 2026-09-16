// What an FM synthesiser is made of.
//
// The third of the three synths in this rack, and deliberately the third KIND
// rather than a third flavour of the first two.  A wavetable synth stores the
// spectrum and reads it; an analogue synth makes a rich wave and takes parts
// away.  Neither can do what this does: an operator's output added to another
// operator's PHASE creates sidebands that exist nowhere in either wave, at
// spacings you choose, and that is the only way to build a bell, a tine, a
// clang or a real electric piano out of six sine waves.
//
// Strictly this is PHASE modulation and not frequency modulation.  Every
// so-called FM synthesiser since 1983 has been, because modulating phase
// keeps the carrier's pitch stable while the index changes and modulating
// frequency does not.  The name is historical and the maths is Chowning's
// either way; it is written down here rather than glossed over.

/** Control rate, as in the other two synths and for the same reason. */
export const FM_CONTROL_STRIDE = 16;

/** Six, because the instrument this idea comes from had six. */
export const FM_OPERATORS = 6;

// ── The operator's wave ─────────────────────────────────────────────────────

/**
 * The shapes an operator can output.
 *
 * A sine is the only wave whose FM sidebands are predictable — Bessel
 * functions of the index, and nothing else — which is why the original
 * instrument had only that one.  The seven after it are the trade its
 * successors made: each is a sine with a piece removed or folded, so it
 * already contains harmonics before any modulation, and modulating it gives
 * a denser spectrum for a lower index.  Cheaper brightness, less control.
 *
 * These are OURS, derived from a sine as described in each comment, and not
 * a copy of any particular machine's table.
 */
export const FM_WAVES = [
  'sine', 'half', 'abs', 'quarter', 'alt', 'saw', 'square', 'noise',
] as const;

export type FmWave = typeof FM_WAVES[number];

/**
 * A sine, from a table.
 *
 * `Math.sin` was the first version and it cost 178 ms to render a four-second
 * note — six operators times 192 000 samples is 1.15 million calls, and that
 * is before the panning.  A table of 4096 entries with linear interpolation
 * between them costs an add, a multiply and two loads.
 *
 * What it costs in accuracy, measured rather than assumed: the interpolation
 * error of a sine sampled at N points is about (2π/N)²/8, which at N = 4096
 * is 4.7 × 10⁻⁷, or −126 dB.  That is below the 24-bit noise floor and far
 * below anything this instrument's own aliasing does.  The selftest measures
 * it rather than taking the algebra's word for it.
 */
const SINE_BITS = 12;
const SINE_SIZE = 1 << SINE_BITS;
const SINE_TABLE = new Float64Array(SINE_SIZE + 1);
for (let i = 0; i <= SINE_SIZE; i++) SINE_TABLE[i] = Math.sin((2 * Math.PI * i) / SINE_SIZE);

/** A sine at a phase in cycles.  The phase may be any real number. */
export function fmSine(phase: number): number {
  const x = (phase - Math.floor(phase)) * SINE_SIZE;
  const i = x | 0;
  const f = x - i;
  const a = SINE_TABLE[i] ?? 0;
  return a + ((SINE_TABLE[i + 1] ?? 0) - a) * f;
}

/**
 * One operator wave at a phase in cycles.
 *
 * `phase` may be any real number, positive or negative: modulation moves it
 * by whole cycles routinely, and wrapping here rather than at every call site
 * is what keeps the render loop readable.
 *
 * `seed` only matters for the noise wave, which is a hash of the cycle number
 * rather than `Math.random` — this engine's bounces are bit-identical to its
 * previews and a random number generator would end that.
 */
export function fmWave(kind: number, phase: number, seed = 0): number {
  switch (kind) {
    case 0: return fmSine(phase);
    // The second half of the cycle silenced.  Adds even harmonics and a DC
    // component, which is exactly what makes it useful as a modulator.
    case 1: {
      const t = phase - Math.floor(phase);
      return t < 0.5 ? fmSine(phase) : 0;
    }
    // Both halves folded up: the full-wave rectified sine, an octave up with
    // a strong second harmonic.
    case 2: return Math.abs(fmSine(phase));
    // A quarter cycle, silent for the rest.
    case 3: {
      const t = phase - Math.floor(phase);
      return t < 0.25 ? fmSine(phase) : 0;
    }
    // Two sine bumps of alternating sign in the first half.
    case 4: {
      const t = phase - Math.floor(phase);
      return t < 0.5 ? fmSine(phase * 2) : 0;
    }
    // A saw and a square, band-limited nowhere.  As MODULATORS their
    // aliasing lands inside the sidebands and is part of the sound; as
    // CARRIERS they alias, which the panel says rather than prevents,
    // because preventing it would remove the reason they are here.
    case 5: return 2 * (phase - Math.floor(phase)) - 1;
    case 6: return (phase - Math.floor(phase)) < 0.5 ? 1 : -1;
    default: {
      // A hash of the cycle number and the seed: noise that is the same
      // noise on every render.
      const n = Math.floor(phase * 64) | 0;
      let h = (Math.imul(n ^ seed, 2654435761) ^ 0x9e3779b9) >>> 0;
      h = (h ^ (h >>> 15)) >>> 0;
      h = Math.imul(h, 2246822519) >>> 0;
      return ((h ^ (h >>> 13)) >>> 0) / 2147483648 - 1;
    }
  }
}

// ── The envelope ────────────────────────────────────────────────────────────

/**
 * An operator envelope.
 *
 * Exponential in both directions, because an FM operator's envelope is heard
 * as a BRIGHTNESS curve and not a volume one: a modulator's envelope moves
 * the index, the index moves the sidebands, and a linear ramp of index sounds
 * like a sudden arrival rather than a swell.  Every FM instrument's envelopes
 * are exponential for this reason.
 *
 * `-4.6` is ln(0.01): one time constant per stage brings it to within 1% of
 * its target, which is where a stage is called finished.
 */
export function fmEnv(
  t: number, gate: number, a: number, d: number, s: number, r: number,
): number {
  if (t <= 0) return 0;
  const sus = s < 0 ? 0 : (s > 1 ? 1 : s);
  // Written flat, with the attack/decay curve repeated, and NOT with a small
  // helper closure — which is what it had first.  Measured: an inner arrow
  // function here allocated once per call and turned 72 000 calls into 42 ms,
  // more than the six operators' entire render loop cost.  A helper that is
  // called from exactly two places is not worth a closure in a function this
  // hot.
  if (t < gate) {
    if (t < a) return a <= 0 ? 1 : 1 - Math.exp((-4.6 * t) / a);
    if (d <= 0) return sus;
    return sus + (1 - sus) * Math.exp((-4.6 * (t - a)) / d);
  }
  let held: number;
  if (gate < a) held = a <= 0 ? 1 : 1 - Math.exp((-4.6 * gate) / a);
  else if (d <= 0) held = sus;
  else held = sus + (1 - sus) * Math.exp((-4.6 * (gate - a)) / d);

  if (r <= 0) return 0;
  const rt = t - gate;
  // Down to zero rather than to 1% and then a jump: the exponential tail is
  // multiplied by a ramp over the same time constant, so the note ends.
  const fade = 1 - rt / r;
  if (fade <= 0) return 0;
  return held * Math.exp((-4.6 * rt) / r) * fade;
}

// ── The algorithms ──────────────────────────────────────────────────────────

export interface FmAlgorithm {
  name: string;
  /** Each pair is [modulator, carrier], both 0-based operator indices. */
  mods: ReadonlyArray<readonly [number, number]>;
  /** Operators whose output reaches the mix, 0-based. */
  carriers: readonly number[];
  /** A one-line description of the shape, for the panel. */
  note: string;
}

/**
 * The thirty-two shapes, ordered by how many carriers they have.
 *
 * These are OURS.  The famous instrument's thirty-two are a specific
 * published table and this is not a copy of it — it is the same idea worked
 * out from the same constraint, which is why the ordering matches in spirit:
 * one carrier at the top for the narrowest and most metallic sounds, six at
 * the bottom for an additive organ, and the useful branching shapes between.
 *
 * ── The rule every one of them obeys ───────────────────────────────────────
 *
 * A modulator always has a HIGHER number than the operator it modulates.
 * That is not decoration.  The render loop computes the operators once per
 * sample from 6 down to 1, so a modulator is always already computed when the
 * operator it feeds asks for it.  The only backwards path in the engine is
 * the feedback operator, which reads its own previous output on purpose.
 *
 * The selftest checks the rule for every algorithm, because breaking it would
 * not crash — it would quietly use the previous sample's value and sound
 * almost right, which is the worst kind of wrong.
 */
function algo(
  name: string, note: string, carriers: number[], ...mods: Array<[number, number]>
): FmAlgorithm {
  return {
    name,
    note,
    carriers: carriers.map((c) => c - 1),
    mods: mods.map(([a, b]) => [a - 1, b - 1] as const),
  };
}

export const FM_ALGORITHMS: readonly FmAlgorithm[] = [
  // ── One carrier: the narrowest and the brightest ─────────────────────────
  algo('1 · 6단 스택', '인덱스가 다섯 번 곱해집니다 — 가장 밝고 가장 좁습니다', [1],
    [6, 5], [5, 4], [4, 3], [3, 2], [2, 1]),
  algo('2 · 4단 + 병렬', '깊은 사슬 옆에 짧은 모듈 — 금속성에 몸통을 더합니다', [1],
    [6, 5], [5, 4], [4, 2], [3, 2], [2, 1]),
  algo('3 · 2 모듈 → 3단', '두 모듈이 한 단으로 합쳐져 내려갑니다', [1],
    [6, 4], [5, 4], [4, 3], [3, 2], [2, 1]),
  algo('4 · 병렬 4 모듈', '네 모듈이 한 오퍼레이터를 함께 흔듭니다 — 조밀한 스펙트럼', [1],
    [6, 2], [5, 2], [4, 2], [3, 2], [2, 1]),
  algo('5 · 종', '네 모듈이 캐리어로 바로 — 비조화 배음, 종과 공업음', [1],
    [6, 1], [5, 1], [4, 1], [3, 1], [2, 1]),
  algo('6 · 2단 × 2', '두 개의 2단 사슬이 한 캐리어로', [1],
    [6, 5], [5, 1], [4, 3], [3, 1], [2, 1]),
  algo('7 · 4단 + 직결', '긴 사슬과 짧은 사인이 같은 캐리어로', [1],
    [6, 5], [5, 4], [4, 3], [3, 1], [2, 1]),

  // ── Two carriers ─────────────────────────────────────────────────────────
  algo('8 · 5단 + 사인', '밝은 사슬 하나와 순수한 사인 하나 — 배음과 기본음을 따로', [1, 2],
    [6, 5], [5, 4], [4, 3], [3, 2]),
  algo('9 · 3단 × 2', '똑같은 3단 사슬 둘 — 디튠하면 두꺼워집니다', [1, 4],
    [3, 2], [2, 1], [6, 5], [5, 4]),
  algo('10 · 4단 + 2단', '길이가 다른 두 사슬', [1, 3],
    [2, 1], [6, 5], [5, 4], [4, 3]),
  algo('11 · 공통 모듈', '한 모듈이 두 캐리어를 동시에 — 둘이 함께 밝아집니다', [1, 2],
    [6, 5], [5, 4], [4, 3], [3, 1], [3, 2]),
  algo('12 · 2 모듈 + 2단', '캐리어 하나엔 두 모듈, 다른 하나엔 사슬', [1, 4],
    [3, 1], [2, 1], [6, 5], [5, 4]),
  algo('13 · 종 + 사인', '비조화 캐리어 옆에 기본음을 받치는 사인', [1, 2],
    [6, 1], [5, 1], [4, 1], [3, 2]),
  algo('14 · 2 모듈 × 2', '두 캐리어가 각각 두 모듈을 받습니다', [1, 2],
    [6, 2], [5, 2], [4, 1], [3, 1]),

  // ── Three carriers ───────────────────────────────────────────────────────
  algo('15 · 2단 × 3', '세 쌍 — 일렉트릭 피아노가 사는 곳입니다', [1, 3, 5],
    [2, 1], [4, 3], [6, 5]),
  algo('16 · 3단 + 2단 + 사인', '길이가 셋 다 다릅니다', [1, 4, 6],
    [3, 2], [2, 1], [5, 4]),
  algo('17 · 3 모듈 + 사인 × 2', '앞은 두껍고 뒤는 맑습니다', [1, 5, 6],
    [4, 1], [3, 1], [2, 1]),
  algo('18 · 공통 모듈 × 3', '모듈 하나가 세 캐리어 전부를 — 노브 하나로 전부 밝아집니다', [1, 2, 3],
    [6, 5], [5, 4], [4, 1], [4, 2], [4, 3]),
  algo('19 · 4단 + 사인 × 2', '사슬 하나에 사인 둘', [1, 5, 6],
    [4, 3], [3, 2], [2, 1]),
  algo('20 · 2 모듈 + 2단 + 사인', '', [1, 4, 6],
    [3, 1], [2, 1], [5, 4]),

  // ── Four carriers ────────────────────────────────────────────────────────
  algo('21 · 3단 + 사인 × 3', '하나만 밝고 셋은 순수합니다', [1, 4, 5, 6],
    [3, 2], [2, 1]),
  algo('22 · 2단 × 2 + 사인 × 2', '', [1, 3, 5, 6],
    [2, 1], [4, 3]),
  algo('23 · 2 모듈 + 사인 × 3', '', [1, 4, 5, 6],
    [3, 1], [2, 1]),
  algo('24 · 공통 모듈 × 4', '모듈 하나가 넷 전부를 — 오르간에 숨결을 얹는 방식', [1, 2, 3, 4],
    [6, 5], [5, 1], [5, 2], [5, 3], [5, 4]),
  algo('25 · 모듈 둘, 따로', '두 캐리어만 변조되고 둘은 사인 그대로', [1, 2, 3, 6],
    [5, 1], [4, 2]),
  algo('26 · 모듈 둘, 안쪽', '', [1, 2, 5, 6],
    [4, 1], [3, 2]),

  // ── Five carriers: nearly additive ───────────────────────────────────────
  algo('27 · 1 모듈 + 사인 × 4', '거의 가산 합성 — 모듈 하나가 색을 줍니다', [1, 3, 4, 5, 6],
    [2, 1]),
  algo('28 · 공통 모듈 × 5', '모듈 하나가 다섯 캐리어 전부를', [1, 2, 3, 4, 5],
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5]),
  algo('29 · 공통 모듈 × 2', '다섯 중 둘만 변조됩니다', [1, 2, 3, 4, 5],
    [6, 1], [6, 2]),
  algo('30 · 공통 모듈 × 3', '다섯 중 셋이 변조됩니다', [1, 2, 3, 4, 5],
    [6, 1], [6, 2], [6, 3]),
  algo('31 · 1 모듈 → 2 캐리어', '', [1, 2, 3, 4, 6],
    [5, 1], [5, 2]),

  // ── Six carriers ─────────────────────────────────────────────────────────
  algo('32 · 가산 6', '변조 없음 — 여섯 사인의 합. 드로우바 오르간이 여기서 나옵니다. '
    + '피드백 오퍼레이터만이 유일한 변조입니다', [1, 2, 3, 4, 5, 6]),
];

/** The algorithm at an index, clamped — a saved session may hold anything. */
export function algorithmAt(index: number): FmAlgorithm {
  const i = Math.max(0, Math.min(FM_ALGORITHMS.length - 1, Math.round(index)));
  return FM_ALGORITHMS[i] ?? FM_ALGORITHMS[0]!;
}

/**
 * Which operators modulate `op`, for every operator.
 *
 * Built once per algorithm rather than searched per sample: the render loop
 * asks this question 48 000 times a second and a linear scan of the
 * connection list there was the first version's cost.
 */
export function modulatorsOf(a: FmAlgorithm): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < FM_OPERATORS; i++) out.push([]);
  for (const [from, to] of a.mods) out[to]?.push(from);
  return out;
}

/**
 * How far one operator's output moves another's phase, in cycles, at level 1.
 *
 * 1.5 cycles is a modulation index of 2π × 1.5 ≈ 9.4 radians, which puts
 * roughly ten significant sideband pairs either side of the carrier — bright
 * enough that the top of the knob is a genuinely metallic sound, and not so
 * high that the middle of the knob is already past anything musical.
 */
export const FM_MOD_SCALE = 1.5;

/**
 * How far the feedback operator moves its own phase, at feedback 1.
 *
 * Lower than the modulation scale on purpose.  An operator modulating itself
 * is a closed loop with a gain, and past about one cycle it stops producing a
 * saw-like spectrum and starts producing noise — which is a real sound and
 * is what the top of the knob is, but the useful range has to be most of the
 * travel rather than the first tenth of it.
 */
export const FM_FEEDBACK_SCALE = 1.0;

/**
 * The feedback operator reads the average of its last TWO outputs.
 *
 * This is the oldest trick in the subject and it is worth saying what it
 * does: a one-sample feedback loop at high gain oscillates between two
 * values at exactly Nyquist, which is inaudible as pitch and audible as a
 * harsh buzz on everything else.  Averaging two samples is a one-zero lowpass
 * inside the loop that puts a null exactly there, so the loop produces the
 * saw-ish spectrum it is supposed to instead.
 */
export function feedbackTap(prev1: number, prev2: number): number {
  return (prev1 + prev2) * 0.5;
}

/**
 * How loud an operator is at a pitch, given its key scaling.
 *
 * Real instruments get quieter and duller as they go up, and an FM patch
 * that does not track the keyboard is unusable across more than an octave:
 * a modulator at a fixed level is a fixed INDEX, and a fixed index at a high
 * pitch puts sidebands above Nyquist where they fold back as a metallic buzz.
 *
 * `amount` is a tilt about middle C: at +1 the operator doubles its level
 * every two octaves UP, at −1 every two octaves down.  Modulators usually
 * want a negative value and carriers usually want none.
 */
export function keyScale(pitch: number, amount: number): number {
  const octaves = (pitch - 60) / 12;
  return Math.pow(2, Math.max(-1, Math.min(1, amount)) * octaves * 0.5);
}
