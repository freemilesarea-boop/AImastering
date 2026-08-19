// Reference Intelligence — the comparison, made executable.
//
// The Mastering Reference view already answers "how does my mix differ from
// this track".  It answers in sentences: cut 2 dB around 80 Hz, back off the
// limiter, widen the sides.  That is one step short of useful, because the
// user then has to go and do it.
//
// This module closes the gap.  It takes the SAME `ReferenceComparison` and
// turns each row into the move that would close it — on the master track, in
// the order that works, with the size of the move derived from the size of
// the difference and capped so a bad reference cannot wreck a mix.
//
// One rule keeps it honest: a row that already reads "match" produces nothing.
// The tool's job is to close a gap, not to have an opinion about a gap that
// is not there.

import { findTrack } from '../model/session-ops.js';
import { TONAL_BANDS } from '../analysis/reference.js';
import type { ComparisonRow, ReferenceComparison } from '../analysis/reference.js';
import type { Suggestion } from './actions.js';
import type { DawSession } from '../model/types.js';

export interface MatchOptions {
  /** Largest EQ move per band, dB. */
  maxEqDb?: number;
  /** Largest loudness move, dB. */
  maxGainDb?: number;
  /** Skip the loudness row — useful when only the tone should be matched. */
  toneOnly?: boolean;
}

const DEFAULTS = { maxEqDb: 4, maxGainDb: 9 };

let counter = 0;
const nextId = (): string => `match-${(counter += 1)}`;
export function resetMatchIds(): void { counter = 0; }

const clamp = (v: number, limit: number): number => Math.max(-limit, Math.min(limit, v));
const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;

/** The band centre an EQ move for a tonal row should sit at. */
function bandCentre(id: ComparisonRow['id']): number {
  const band = id === 'low' ? TONAL_BANDS.low : id === 'mid' ? TONAL_BANDS.mid : TONAL_BANDS.high;
  return Math.round(Math.sqrt(band.lowHz * band.highHz));
}

/**
 * Turn the seven rows into master-chain moves.
 *
 * The tonal rows are already level-normalised by the comparison, so a LOW
 * difference is a real tonal difference and not a restatement of the loudness
 * difference — which is what makes it safe to act on directly.
 */
export function matchActions(
  session: DawSession, comparison: ReferenceComparison, options: MatchOptions = {},
): Suggestion[] {
  const master = session.tracks.find((t) => t.kind === 'master');
  if (!master) return [];
  const trackId = master.id;
  const maxEq = options.maxEqDb ?? DEFAULTS.maxEqDb;
  const maxGain = options.maxGainDb ?? DEFAULTS.maxGainDb;
  const out: Suggestion[] = [];

  const row = (id: ComparisonRow['id']): ComparisonRow | undefined =>
    comparison.rows.find((r) => r.id === id);

  // ── Tone ─────────────────────────────────────────────────────────────────
  const low = row('low');
  const high = row('high');
  const eqActions: Suggestion['actions'] = [];
  const eqParts: string[] = [];

  if (low && low.verdict !== 'match') {
    const move = clamp(-low.delta, maxEq);
    eqActions.push({ kind: 'insertParam', trackId, pluginId: 'eq3', paramId: 'lowDb', value: move, slot: 0 });
    eqParts.push(`LOW ${signed(move)} dB`);
  }
  if (high && high.verdict !== 'match') {
    const move = clamp(-high.delta, maxEq);
    eqActions.push({ kind: 'insertParam', trackId, pluginId: 'eq3', paramId: 'highDb', value: move, slot: 0 });
    eqParts.push(`HIGH ${signed(move)} dB`);
  }
  const mid = row('mid');
  if (mid && mid.verdict !== 'match') {
    const move = clamp(-mid.delta, maxEq);
    eqActions.push(
      { kind: 'insertParam', trackId, pluginId: 'eq3', paramId: 'midHz', value: bandCentre('mid'), slot: 0 },
      { kind: 'insertParam', trackId, pluginId: 'eq3', paramId: 'midDb', value: move, slot: 0 },
    );
    eqParts.push(`MID ${signed(move)} dB`);
  }

  if (eqActions.length > 0) {
    out.push({
      id: nextId(),
      title: `톤 매칭 — ${eqParts.join(' · ')}`,
      reason: `${comparison.referenceName} 대비 대역 차이를 EQ 로 좁힙니다.`
        + ' 음색 수치는 레벨 정규화되어 있으므로 라우드니스 차이와 별개입니다.',
      confidence: 0.8,
      actions: eqActions,
    });
  }

  // ── Width ────────────────────────────────────────────────────────────────
  const width = row('width');
  if (width && width.verdict !== 'match') {
    const amount = Math.max(0, Math.min(1, 0.5 - width.delta / 120));
    out.push({
      id: nextId(),
      title: `폭 ${width.delta > 0 ? '축소' : '확장'} → ${Math.round(amount * 100)}%`,
      reason: `레퍼런스 ${width.reference.toFixed(0)}%, 현재 ${width.mix.toFixed(0)}% 입니다.`,
      confidence: 0.6,
      actions: [
        { kind: 'addInsert', trackId, pluginId: 'widener', slot: 2 },
        { kind: 'insertParam', trackId, pluginId: 'widener', paramId: 'amount', value: amount },
      ],
    });
  }

  // ── Dynamics ─────────────────────────────────────────────────────────────
  const dr = row('dr');
  if (dr && dr.verdict !== 'match' && dr.delta > 0) {
    // The mix is MORE dynamic than the reference: compress toward it.
    const ratio = Math.min(4, 1.5 + dr.delta / 5);
    out.push({
      id: nextId(),
      title: `컴프레서 ${ratio.toFixed(1)}:1 — 다이내믹을 ${dr.delta.toFixed(1)} dB 좁힘`,
      reason: `레퍼런스 PLR ${dr.reference.toFixed(1)} dB, 현재 ${dr.mix.toFixed(1)} dB 입니다.`,
      confidence: 0.55,
      actions: [
        { kind: 'addInsert', trackId, pluginId: 'comp', slot: 1 },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'ratio', value: ratio },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'thresholdDb', value: -(8 + dr.delta) },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'attackMs', value: 30 },
      ],
    });
  }

  // ── Level and ceiling ────────────────────────────────────────────────────
  if (!options.toneOnly) {
    const tp = row('tp');
    const lufs = row('lufs');
    const actions: Suggestion['actions'] = [];
    const parts: string[] = [];

    if (tp && tp.verdict !== 'match') {
      actions.push({
        kind: 'insertParam', trackId, pluginId: 'limiter', paramId: 'ceilingDb',
        value: tp.reference, slot: 9,
      });
      parts.push(`실링 ${tp.reference.toFixed(1)} dBTP`);
    }
    if (lufs && lufs.verdict !== 'match') {
      const move = clamp(-lufs.delta, maxGain);
      actions.push({
        kind: 'trackVolume', trackId,
        db: (findTrack(session, trackId)?.volumeDb ?? 0) + move,
      });
      parts.push(`마스터 ${signed(move)} dB`);
    }
    if (actions.length > 0) {
      out.push({
        id: nextId(),
        title: `레벨 매칭 — ${parts.join(' · ')}`,
        reason: `레퍼런스 ${lufs?.reference.toFixed(1) ?? '—'} LUFS 에 맞춥니다.`
          + ' 리미터가 없으면 함께 추가됩니다.',
        confidence: 0.75,
        actions: [{ kind: 'addInsert', trackId, pluginId: 'limiter', slot: 9 }, ...actions],
      });
    }
  }

  return out;
}

/** Nothing to do is a result, and worth saying out loud. */
export function matchSummary(comparison: ReferenceComparison, suggestions: readonly Suggestion[]): string {
  if (suggestions.length === 0) {
    return `${comparison.referenceName} 와 이미 ${comparison.score}% 일치합니다 — 고칠 것이 없습니다`;
  }
  return `${comparison.score}% 일치 · 제안 ${suggestions.length}개`;
}
