// Reading the tempo off a recording.
//
// There is already an `estimateBpm` in `warp.ts` that histograms the gaps
// between onsets.  It is enough to seed a warp and not enough to be believed:
// it reports a PERIOD and nothing else, and three things are missing from
// that answer.
//
//   WHERE THE BEAT IS.  A tempo without a phase cannot line anything up.
//   "120 BPM" does not say whether the downbeat is at 0.0 s or 0.25 s, and
//   every use of a detected tempo — warping, gridding, a click that plays
//   along — needs the second number more than the first.
//
//   WHICH OCTAVE.  The classic failure: 80 BPM read as 160 because the
//   snare falls halfway between the kicks.  Halving and doubling a number
//   until it lands in a "musical range" picks by arithmetic, not by evidence,
//   so here each octave is SCORED against the onsets and the winner has to
//   earn it.
//
//   WHETHER TO BELIEVE IT AT ALL.  A sustained pad has no beat.  A detector
//   that answers 120 BPM anyway is worse than one that says it cannot tell,
//   because the number will be used.
//
// The method is a comb filter over candidate periods: for each candidate, try
// every phase and count how much onset weight lands on the grid.  It is
// O(candidates × phases × onsets) on a list of onsets, not on samples, so a
// four-minute take is a few milliseconds.

/** An onset with a weight — how strong the attack was. */
export interface WeightedOnset {
  timeSec: number;
  /** Relative strength, 0…1.  Uniform weights are fine; strength is better. */
  weight: number;
}

export interface TempoCandidate {
  bpm: number;
  /** Seconds from the start of the audio to the first beat. */
  phaseSec: number;
  /** 0…1 — the share of onset weight that landed on this grid. */
  score: number;
}

export interface TempoDetection {
  bpm: number;
  phaseSec: number;
  /**
   * 0…1, and deliberately hard to max out.
   *
   * Built from how much of the onset weight lands on the grid AND by how far
   * the winner beat the next unrelated candidate.  A loop that is dead on the
   * grid still only reaches the high nineties, because certainty about a
   * measurement of a performance is not a thing that exists.
   */
  confidence: number;
  /** The runners-up, strongest first — what the UI shows when unsure. */
  alternatives: TempoCandidate[];
  /** Why there is no answer, when there is none. */
  reason: string | null;
}

export interface DetectOptions {
  minBpm?: number;
  maxBpm?: number;
  /** How close to a beat an onset must be to count, as a fraction of a beat. */
  toleranceBeats?: number;
  /** Candidate spacing in BPM.  Finer costs time and buys very little. */
  stepBpm?: number;
}

const DEFAULTS = {
  minBpm: 60,
  maxBpm: 200,
  // A tenth of a beat: at 120 BPM that is 50 ms, which is about as loose as a
  // human plays and about as tight as a detector can insist without throwing
  // away a real performance.
  toleranceBeats: 0.1,
  stepBpm: 0.5,
};

/**
 * Confidence below which the answer is offered but not acted on.
 *
 * Measured against material rather than chosen: a busy loop scores in the
 * eighties, a sparse but steady one in the sixties, and unpitched sustained
 * material — where there is genuinely no beat — sits under a half.
 */
export const TRUST_THRESHOLD = 0.55;

/** Plain onsets become weighted ones when nothing better is known. */
export function evenWeights(times: readonly number[]): WeightedOnset[] {
  return times.map((timeSec) => ({ timeSec, weight: 1 }));
}

/**
 * Where an onset can sit inside a beat, and what each position is worth.
 *
 * Counting only onsets that land ON the beat is what makes a detector call a
 * shuffle "no pulse": in a swung part the off-eighths are two thirds of the
 * way through the beat and every one of them is thrown away, so a perfectly
 * clear performance scores like noise.  A note on the "and" is evidence for
 * the tempo — weaker evidence than one on the beat, but evidence.
 *
 * The list is short on purpose.  Each position opens a window twice the
 * tolerance wide, and once the windows cover the whole beat every onset hits
 * something and the score stops meaning anything.  Halves and thirds are what
 * music is made of; sixteenths are where the measurement dissolves.
 */
const SUBDIVISIONS: readonly { at: number; credit: number }[] = [
  { at: 0,     credit: 1    },
  { at: 1 / 2, credit: 0.6  },
  { at: 1 / 3, credit: 0.45 },
  { at: 2 / 3, credit: 0.45 },
];

/** Distance between two positions in a beat, the short way round. */
function beatDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

/** How much one grid, at one phase, explains the onsets. */
function scoreAtPhase(
  onsets: readonly WeightedOnset[], periodSec: number, toleranceSec: number,
  phaseSec: number,
): number {
  const toleranceBeats = toleranceSec / periodSec;
  let hit = 0;
  for (const onset of onsets) {
    const frac = (((onset.timeSec - phaseSec) / periodSec) % 1 + 1) % 1;
    let best = 0;
    for (const sub of SUBDIVISIONS) {
      const error = beatDistance(frac, sub.at);
      if (error > toleranceBeats) continue;
      // Graded by closeness: an onset only just inside the window is weaker
      // evidence than one dead on the line, and grading it is what separates
      // a real lock from a wide tolerance catching everything.
      const graded = sub.credit * (1 - error / toleranceBeats);
      if (graded > best) best = graded;
    }
    hit += onset.weight * best;
  }
  return hit;
}

/**
 * Score one period against the onsets, finding the phase that suits it best.
 *
 * Coarse sweep, then a refinement around the winner — and the refinement is
 * not a nicety.  Hits are graded by closeness, so a phase that lands EXACTLY
 * on a weak subdivision can out-score one that lands NEARLY on every strong
 * beat.  Whether the true phase happens to fall on a step of the sweep then
 * decides the answer, and one candidate landing on the grid while its rival
 * misses it by a rounding error is how a shuffle at 108 comes back as 162.
 * So the sweep only nominates, and the refinement decides.
 */
function scorePeriod(
  onsets: readonly WeightedOnset[], periodSec: number, toleranceSec: number,
  totalWeight: number,
): { score: number; phaseSec: number } {
  const steps = Math.max(16, Math.round((periodSec / toleranceSec) * 4));
  const step = periodSec / steps;
  let bestScore = 0;
  let bestPhase = 0;

  for (let s = 0; s < steps; s++) {
    const phase = s * step;
    const hit = scoreAtPhase(onsets, periodSec, toleranceSec, phase);
    if (hit > bestScore) { bestScore = hit; bestPhase = phase; }
  }

  // One coarse step either side, at a sixteenth of the spacing.
  const REFINE = 16;
  for (let s = -REFINE; s <= REFINE; s++) {
    const phase = bestPhase + (s / REFINE) * step;
    const hit = scoreAtPhase(onsets, periodSec, toleranceSec, phase);
    if (hit > bestScore) { bestScore = hit; bestPhase = phase; }
  }

  return {
    score: totalWeight > 0 ? bestScore / totalWeight : 0,
    // The phase is reported as the FIRST beat at or after zero, which is what
    // a caller wants to line a grid up with.
    phaseSec: bestPhase - Math.floor(bestPhase / periodSec) * periodSec,
  };
}

/**
 * Halve a tempo whose beats alternate strong, weak, strong, weak.
 *
 * This is the one octave error the evidence can actually settle.  Kick on the
 * beat and hat between them reads perfectly as double time — every grid line
 * has an onset — but the grid is STRIPED: every other beat is much softer
 * than its neighbours, and a beat is not something that is only half there.
 * Taking the loud parity as the beat is what a listener does.
 *
 * The stripe has to be obvious (a quarter again as strong) before anything
 * moves, because a performance with a little natural accent on the downbeat
 * is not a tempo error, and halving that would be a much worse one.
 */
function demoteAlternating(
  onsets: readonly WeightedOnset[], candidate: TempoCandidate,
  toleranceSec: number, minBpm: number,
): TempoCandidate {
  if (candidate.bpm / 2 < minBpm) return candidate;
  const period = 60 / candidate.bpm;

  const sum = [0, 0];
  const count = [0, 0];
  for (const onset of onsets) {
    const offset = (onset.timeSec - candidate.phaseSec) / period;
    const index = Math.round(offset);
    if (Math.abs(offset - index) * period > toleranceSec) continue;
    const parity = ((index % 2) + 2) % 2;
    sum[parity] = (sum[parity] ?? 0) + onset.weight;
    count[parity] = (count[parity] ?? 0) + 1;
  }
  if ((count[0] ?? 0) < 2 || (count[1] ?? 0) < 2) return candidate;

  const mean = [(sum[0] ?? 0) / (count[0] ?? 1), (sum[1] ?? 0) / (count[1] ?? 1)];
  const loud = (mean[0] ?? 0) >= (mean[1] ?? 0) ? 0 : 1;
  const soft = 1 - loud;
  const quiet = mean[soft] ?? 0;
  if (quiet <= 0 || (mean[loud] ?? 0) / quiet < 1.25) return candidate;

  const phaseSec = candidate.phaseSec + loud * period;
  const halved = {
    bpm: Math.round((candidate.bpm / 2) * 100) / 100,
    phaseSec: phaseSec - Math.floor(phaseSec / (period * 2)) * period * 2,
    score: 0,
  };
  const totalWeight = onsets.reduce((s, o) => s + o.weight, 0);
  halved.score = totalWeight > 0
    ? scoreAtPhase(onsets, period * 2, toleranceSec * 2, halved.phaseSec) / totalWeight
    : 0;
  return halved;
}

/** Two BPMs are the same tempo in different clothes. */
function relatedOctave(a: number, b: number): boolean {
  for (const ratio of [0.5, 1, 2, 1 / 3, 3, 2 / 3, 1.5]) {
    if (Math.abs(a - b * ratio) < 1.5) return true;
  }
  return false;
}

/**
 * The tempo of a recording, with its phase and a confidence.
 *
 * `onsets` are seconds from the start of the audio being analysed.
 */
export function detectTempo(
  onsets: readonly WeightedOnset[], options: DetectOptions = {},
): TempoDetection {
  const opt = { ...DEFAULTS, ...options };
  const none = (reason: string): TempoDetection => ({
    bpm: 0, phaseSec: 0, confidence: 0, alternatives: [], reason,
  });

  if (onsets.length < 4) return none('어택이 너무 적습니다 — 최소 4개가 필요합니다');
  const span = (onsets[onsets.length - 1]?.timeSec ?? 0) - (onsets[0]?.timeSec ?? 0);
  if (span <= 0) return none('어택이 모두 같은 시각에 있습니다');
  // Two bars at the slowest tempo considered.  A shorter excerpt can be made
  // to fit almost any grid, which is how a detector produces a confident
  // wrong answer.
  const minSpan = (60 / opt.minBpm) * 8;
  if (span < minSpan) {
    return none(`분석 구간이 너무 짧습니다 — ${minSpan.toFixed(1)}초 이상이 필요합니다`);
  }

  const totalWeight = onsets.reduce((sum, o) => sum + o.weight, 0);
  if (totalWeight <= 0) return none('어택의 세기가 모두 0 입니다');

  const scored: TempoCandidate[] = [];
  for (let bpm = opt.minBpm; bpm <= opt.maxBpm + 1e-9; bpm += opt.stepBpm) {
    const periodSec = 60 / bpm;
    const { score, phaseSec } = scorePeriod(
      onsets, periodSec, (opt.toleranceBeats * 60) / bpm, totalWeight);
    scored.push({ bpm: Math.round(bpm * 100) / 100, phaseSec, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) return none('박자를 찾을 수 없습니다');

  // A slower tempo always scores at least as well as its double — every beat
  // of the half-time grid is also a beat of the double-time one — so the
  // scores alone would walk the answer down to the slowest candidate that
  // fits.  A faster reading is taken only when it explains MEASURABLY more.
  const slower = preferSlower(scored, best);
  const chosen = demoteAlternating(
    onsets, slower, (opt.toleranceBeats * 60) / slower.bpm, opt.minBpm);

  // What is left after removing everything that is the same tempo in
  // different clothes: the real competition.
  const rivals = scored.filter((c) => !relatedOctave(c.bpm, chosen.bpm));
  const rival = rivals[0]?.score ?? 0;
  const margin = Math.max(0, chosen.score - rival);
  // Both halves matter: a grid that catches most of the onsets AND beats
  // everything unrelated.  Either alone is a way to be confidently wrong.
  const confidence = Math.max(0, Math.min(1, chosen.score * 0.7 + margin * 0.6));

  return {
    bpm: chosen.bpm,
    phaseSec: Math.round(chosen.phaseSec * 1e6) / 1e6,
    confidence: Math.round(confidence * 1000) / 1000,
    alternatives: rivals.slice(0, 3),
    reason: null,
  };
}

/**
 * Among the octaves of the winner, take the slowest that still explains the
 * onsets nearly as well.
 *
 * "Nearly" is 4 %: a double-time reading has to earn its extra beats by
 * catching onsets the half-time grid misses, and if it only ties, the slower
 * one is what a musician would count.
 */
function preferSlower(scored: readonly TempoCandidate[], best: TempoCandidate): TempoCandidate {
  const family = scored.filter((c) => relatedOctave(c.bpm, best.bpm));
  let chosen = best;
  for (const candidate of family) {
    if (candidate.bpm >= chosen.bpm) continue;
    if (candidate.score >= chosen.score * 0.96) chosen = candidate;
  }
  return chosen;
}

/** One line for the toast: the tempo, and how sure it is. */
export function describeDetection(detection: TempoDetection): string {
  if (detection.reason) return detection.reason;
  const percent = Math.round(detection.confidence * 100);
  const trust = detection.confidence >= TRUST_THRESHOLD ? '' : ' — 확실하지 않습니다';
  const phase = detection.phaseSec > 0.001
    ? `, 첫 박 ${detection.phaseSec.toFixed(3)}초`
    : '';
  return `${detection.bpm.toFixed(2)} BPM (확신 ${percent}%)${phase}${trust}`;
}
