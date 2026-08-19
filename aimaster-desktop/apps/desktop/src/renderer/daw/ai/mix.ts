// AI Mix — a rough balance in one press.
//
// The claim being made here is small on purpose.  This does not "mix a song";
// it does the three things that are mechanical, that every engineer does
// first, and that are genuinely computable from measurements:
//
//   BALANCE   put each element near where its role usually sits, measured in
//             LU rather than in fader position, so it works whatever the
//             clips were recorded at.
//   MASKING   find two tracks fighting over the same band and dip the one
//             whose role loses, narrowly, at the frequency they overlap.
//   SPREAD    move duplicated roles off the centre so they stop competing for
//             the same place in the image.
//
// What it deliberately does NOT do is decide taste — no reverb choices, no
// compression character, no arrangement opinions.  Every move is capped, and
// every move states the measurement that produced it, so a wrong guess is
// visible and cheap to reject.

import { findTrack } from '../model/session-ops.js';
import { ROLE_PROFILES, roleLabel } from './roles.js';
import type { MixAnalysis, TrackAnalysis } from './analysis.js';
import type { IntelAction, Suggestion } from './actions.js';
import type { DawSession } from '../model/types.js';

export interface MixOptions {
  /** Largest fader move the balance pass will make, dB. */
  maxMoveDb?: number;
  /** Deepest masking cut, dB. */
  maxCutDb?: number;
  /** Overlap below this is not a fight worth picking. */
  maskThresholdDb?: number;
  /** Leave panning alone. */
  skipPanning?: boolean;
}

const DEFAULTS = { maxMoveDb: 9, maxCutDb: 4, maskThresholdDb: 6 };

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;

export function resetSuggestionIds(): void { counter = 0; }

/**
 * Balance: every track moves toward the level its role usually occupies,
 * relative to the loudest element in the mix.
 *
 * Measured in LU, not in fader dB, because a fader position means nothing
 * without knowing what was recorded into it.  Tracks whose role could not be
 * guessed are left alone — moving a fader on a hunch is worse than not moving
 * it.
 */
export function balanceSuggestions(
  session: DawSession, analysis: MixAnalysis, options: MixOptions = {},
): Suggestion[] {
  const maxMove = options.maxMoveDb ?? DEFAULTS.maxMoveDb;
  const audible = analysis.tracks.filter((t) => !t.silent && Number.isFinite(t.integratedLufs));
  if (audible.length < 2) return [];

  const loudest = Math.max(...audible.map((t) => t.integratedLufs));
  const out: Suggestion[] = [];

  for (const track of audible) {
    if (track.guess.confidence < 0.5) continue;
    const profile = ROLE_PROFILES[track.guess.role];
    if (track.guess.role === 'master' || track.guess.role === 'bus') continue;

    const expected = loudest + profile.offsetLu;
    const delta = expected - track.integratedLufs;
    // Under a dB is inside the noise of the estimate itself.
    if (Math.abs(delta) < 1) continue;

    const move = Math.max(-maxMove, Math.min(maxMove, delta));
    const current = findTrack(session, track.trackId)?.volumeDb ?? 0;
    out.push({
      id: nextId('balance'),
      title: `${track.name} ${move >= 0 ? '+' : ''}${move.toFixed(1)} dB`,
      reason: `${roleLabel(track.guess.role)} 기준 위치는 ${expected.toFixed(1)} LUFS,`
        + ` 현재 ${track.integratedLufs.toFixed(1)} LUFS 입니다.`,
      // A capped move means the estimate and the request disagree; say so by
      // lowering confidence rather than by moving further.
      confidence: Math.min(0.9, track.guess.confidence) * (Math.abs(delta) > maxMove ? 0.6 : 1),
      actions: [{ kind: 'trackVolume', trackId: track.trackId, db: current + move }],
    });
  }
  return out;
}

// ── Masking ───────────────────────────────────────────────────────────────────

export interface MaskingOverlap {
  a: TrackAnalysis;
  b: TrackAnalysis;
  /** Centre of the contested region. */
  hz: number;
  /** How much energy both have there, dB above their own averages. */
  overlapDb: number;
}

/**
 * Two tracks fighting over one band.
 *
 * Both spectra are level-normalised, so "both are loud here" means both are
 * loud RELATIVE TO THEMSELVES — which is what masking actually is.  A quiet
 * pad and a loud kick do not mask each other just because the kick is louder.
 */
export function findMasking(
  analysis: MixAnalysis, thresholdDb = DEFAULTS.maskThresholdDb,
): MaskingOverlap[] {
  const tracks = analysis.tracks.filter((t) => !t.silent && t.guess.confidence >= 0.5);
  const out: MaskingOverlap[] = [];

  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i] as TrackAnalysis;
      const b = tracks[j] as TrackAnalysis;
      if (ROLE_PROFILES[a.guess.role].priority === ROLE_PROFILES[b.guess.role].priority) continue;

      let bestHz = 0;
      let best = 0;
      const bins = Math.min(a.spectrum.hz.length, b.spectrum.hz.length);
      for (let k = 0; k < bins; k++) {
        const hz = a.spectrum.hz[k] ?? 0;
        // Below 80 Hz everything overlaps and the fix is arrangement, not EQ.
        if (hz < 80 || hz > 12000) continue;
        const shared = Math.min(a.spectrum.db[k] ?? -120, b.spectrum.db[k] ?? -120);
        if (shared > best) { best = shared; bestHz = hz; }
      }
      if (best >= thresholdDb && bestHz > 0) {
        out.push({ a, b, hz: bestHz, overlapDb: best });
      }
    }
  }
  return out.sort((x, y) => y.overlapDb - x.overlapDb);
}

/**
 * Turn overlaps into cuts.  The track whose role has lower priority gets a
 * narrow dip where they collide — the standard move, and the reason roles
 * exist in this layer at all.
 */
export function maskingSuggestions(
  session: DawSession, analysis: MixAnalysis, options: MixOptions = {},
): Suggestion[] {
  const maxCut = options.maxCutDb ?? DEFAULTS.maxCutDb;
  const overlaps = findMasking(analysis, options.maskThresholdDb ?? DEFAULTS.maskThresholdDb);
  const cut = new Set<string>();
  const out: Suggestion[] = [];

  for (const overlap of overlaps) {
    const aPriority = ROLE_PROFILES[overlap.a.guess.role].priority;
    const bPriority = ROLE_PROFILES[overlap.b.guess.role].priority;
    const loser = aPriority >= bPriority ? overlap.b : overlap.a;
    const winner = aPriority >= bPriority ? overlap.a : overlap.b;
    // One cut per track: a second dip on the same EQ would overwrite the first.
    if (cut.has(loser.trackId)) continue;
    cut.add(loser.trackId);

    const amount = -Math.min(maxCut, 1 + overlap.overlapDb / 4);
    out.push({
      id: nextId('mask'),
      title: `${loser.name} 를 ${Math.round(overlap.hz)} Hz 에서 ${amount.toFixed(1)} dB`,
      reason: `${winner.name}(${roleLabel(winner.guess.role)}) 와 ${Math.round(overlap.hz)} Hz 에서`
        + ` ${overlap.overlapDb.toFixed(1)} dB 겹칩니다. 우선순위가 낮은 쪽을 비켜 줍니다.`,
      confidence: Math.min(0.8, 0.4 + overlap.overlapDb / 25),
      actions: [
        { kind: 'insertParam', trackId: loser.trackId, pluginId: 'eq3', paramId: 'midHz', value: overlap.hz },
        { kind: 'insertParam', trackId: loser.trackId, pluginId: 'eq3', paramId: 'midDb', value: amount },
      ],
    });
  }
  return out;
}

// ── Spread ────────────────────────────────────────────────────────────────────

/**
 * Duplicated roles get pushed apart.  Two guitars both dead centre are two
 * guitars in the same place; the fix is geometry, not EQ.
 */
export function panningSuggestions(
  session: DawSession, analysis: MixAnalysis,
): Suggestion[] {
  const byRole = new Map<string, TrackAnalysis[]>();
  for (const track of analysis.tracks) {
    if (track.silent || track.guess.confidence < 0.5) continue;
    const profile = ROLE_PROFILES[track.guess.role];
    // Centre roles stay centred, always.  A kick off to one side is a mistake,
    // never a suggestion.
    if (profile.pan === 0) continue;
    const list = byRole.get(track.guess.role) ?? [];
    list.push(track);
    byRole.set(track.guess.role, list);
  }

  const out: Suggestion[] = [];
  for (const [role, tracks] of byRole) {
    if (tracks.length < 2) continue;
    const spread = ROLE_PROFILES[role as keyof typeof ROLE_PROFILES]?.pan ?? 0.4;
    tracks.forEach((track, index) => {
      const current = findTrack(session, track.trackId)?.pan ?? 0;
      // Alternate sides, widening as the count grows.
      const side = index % 2 === 0 ? -1 : 1;
      const depth = spread * (1 - (Math.floor(index / 2) * 0.25));
      const pan = Math.max(-1, Math.min(1, side * depth));
      if (Math.abs(pan - current) < 0.05) return;
      out.push({
        id: nextId('pan'),
        title: `${track.name} 팬 ${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`,
        reason: `${roleLabel(track.guess.role)} 가 ${tracks.length}개 있습니다 — 같은 자리에서 서로를 가립니다.`,
        confidence: 0.55,
        actions: [{ kind: 'trackPan', trackId: track.trackId, pan }],
      });
    });
  }
  return out;
}

/** Everything the auto-mix has to say, most confident first. */
export function autoMix(
  session: DawSession, analysis: MixAnalysis, options: MixOptions = {},
): Suggestion[] {
  const out = [
    ...balanceSuggestions(session, analysis, options),
    ...maskingSuggestions(session, analysis, options),
    ...(options.skipPanning ? [] : panningSuggestions(session, analysis)),
  ];
  return out.sort((a, b) => b.confidence - a.confidence);
}

export type { IntelAction };
