// AI Master — build the chain the measurements ask for.
//
// Mastering is the one place where "what should this sound like" has a
// defensible answer, because delivery targets are numbers: a loudness, a
// ceiling, a tonal balance, a width.  So the auto-master does not guess at
// taste — it computes the distance between where the mix IS and where the
// target SAYS, and proposes the smallest chain that closes it.
//
// Order matters and is fixed, because it is the order that works:
//
//   EQ        fix the balance before anything reacts to it
//   Compressor  control the shape once the balance is right
//   Width     place it, now that the level is stable
//   Limiter   catch the peaks last, after everything that makes them
//
// A stage whose measurement says "already fine" is not added.  A chain of
// five bypassed plugins is not a master; it is clutter.

import { bandLevelDb, TONAL_BANDS, type ReferenceAnalysis } from '../analysis/reference.js';
import { findTrack } from '../model/session-ops.js';
import type { MixAnalysis } from './analysis.js';
import type { Suggestion } from './actions.js';
import type { DawSession, TrackId } from '../model/types.js';

export type MasterTarget = 'streaming' | 'club' | 'cd' | 'reference';

export interface MasterProfile {
  id: MasterTarget;
  name: string;
  lufs: number;
  ceilingDbtp: number;
  /** Peak-to-loudness the style usually lands at. */
  plr: number;
  /** 100 % = fully decorrelated sides. */
  widthPercent: number;
  note: string;
}

export const MASTER_PROFILES: readonly MasterProfile[] = [
  {
    id: 'streaming', name: 'Streaming', lufs: -14, ceilingDbtp: -1, plr: 10, widthPercent: 100,
    note: 'Spotify · Apple · YouTube 의 정규화 기준. 더 크게 만들어도 재생 시 되돌려집니다.',
  },
  {
    id: 'club', name: 'Club / DJ', lufs: -8, ceilingDbtp: -0.8, plr: 7, widthPercent: 90,
    note: '큰 시스템에서 밀도가 필요합니다. 저역은 모노에 가깝게.',
  },
  {
    id: 'cd', name: 'CD / 다운로드', lufs: -11, ceilingDbtp: -0.3, plr: 9, widthPercent: 105,
    note: '정규화가 없는 매체 — 여기서는 크기가 그대로 크기입니다.',
  },
];

export function findProfile(id: MasterTarget): MasterProfile | undefined {
  return MASTER_PROFILES.find((p) => p.id === id);
}

export interface MasterOptions {
  target?: MasterTarget;
  /** When the target is `reference`, the analysis to match. */
  reference?: ReferenceAnalysis | null;
  /** Largest single EQ move, dB. */
  maxEqDb?: number;
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
export function resetMasterIds(): void { counter = 0; }

/**
 * The target the chain is being built against.  A reference track beats a
 * preset every time: it is the actual sound the user wants, measured.
 */
export function resolveTarget(options: MasterOptions): MasterProfile {
  if (options.target === 'reference' && options.reference) {
    const reference = options.reference;
    return {
      id: 'reference',
      name: reference.name,
      lufs: reference.integratedLufs,
      ceilingDbtp: Math.min(-0.3, reference.truePeakDbtp),
      plr: reference.dr,
      widthPercent: reference.widthPercent,
      note: '레퍼런스 트랙에서 직접 측정한 값입니다.',
    };
  }
  return findProfile(options.target ?? 'streaming') ?? (MASTER_PROFILES[0] as MasterProfile);
}

export function autoMaster(
  session: DawSession, analysis: MixAnalysis, options: MasterOptions = {},
): Suggestion[] {
  const master = session.tracks.find((t) => t.kind === 'master');
  if (!master) return [];
  const trackId: TrackId = master.id;
  const target = resolveTarget(options);
  const maxEq = options.maxEqDb ?? 4;
  const mix = analysis.master;
  const out: Suggestion[] = [];

  // ── 1. EQ ────────────────────────────────────────────────────────────────
  const referenceCurve = options.reference?.spectrum ?? null;
  const bands = {
    low: bandLevelDb(mix.spectrum, TONAL_BANDS.low.lowHz, TONAL_BANDS.low.highHz),
    mid: bandLevelDb(mix.spectrum, TONAL_BANDS.mid.lowHz, TONAL_BANDS.mid.highHz),
    high: bandLevelDb(mix.spectrum, TONAL_BANDS.high.lowHz, TONAL_BANDS.high.highHz),
  };
  const wanted = referenceCurve ? {
    low: bandLevelDb(referenceCurve, TONAL_BANDS.low.lowHz, TONAL_BANDS.low.highHz),
    mid: bandLevelDb(referenceCurve, TONAL_BANDS.mid.lowHz, TONAL_BANDS.mid.highHz),
    high: bandLevelDb(referenceCurve, TONAL_BANDS.high.lowHz, TONAL_BANDS.high.highHz),
  } : null;

  if (wanted) {
    const lowMove = clamp(wanted.low - bands.low, maxEq);
    const highMove = clamp(wanted.high - bands.high, maxEq);
    if (Math.abs(lowMove) >= 0.5 || Math.abs(highMove) >= 0.5) {
      out.push({
        id: nextId('master-eq'),
        title: `EQ · LOW ${signed(lowMove)} dB · HIGH ${signed(highMove)} dB`,
        reason: `레퍼런스 대비 저역 ${signed(bands.low - wanted.low)} dB,`
          + ` 고역 ${signed(bands.high - wanted.high)} dB 차이입니다.`,
        confidence: 0.75,
        actions: [
          { kind: 'insertParam', trackId, pluginId: 'eq3', paramId: 'lowDb', value: lowMove, slot: 0 },
          { kind: 'insertParam', trackId, pluginId: 'eq3', paramId: 'highDb', value: highMove, slot: 0 },
        ],
      });
    }
  }

  // ── 2. Compressor ────────────────────────────────────────────────────────
  // Only when the mix is genuinely more dynamic than the target: compressing
  // something that is already controlled just costs transients.
  if (Number.isFinite(mix.dr) && mix.dr > target.plr + 2) {
    const excess = mix.dr - target.plr;
    const ratio = Math.min(4, 1.5 + excess / 6);
    out.push({
      id: nextId('master-comp'),
      title: `컴프레서 ${ratio.toFixed(1)}:1 · 임계 −${(8 + excess).toFixed(0)} dB`,
      reason: `PLR ${mix.dr.toFixed(1)} dB 로 ${target.name} 목표(${target.plr})보다`
        + ` ${excess.toFixed(1)} dB 넓습니다.`,
      confidence: 0.65,
      actions: [
        { kind: 'addInsert', trackId, pluginId: 'comp', slot: 1 },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'ratio', value: ratio },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'thresholdDb', value: -(8 + excess) },
        // Slow attack keeps the transients the limiter will need later.
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'attackMs', value: 30 },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'releaseMs', value: 180 },
      ],
    });
  }

  // ── 3. Width ─────────────────────────────────────────────────────────────
  const widthDelta = target.widthPercent - mix.widthPercent;
  if (Math.abs(widthDelta) > 12) {
    // The widener's amount is normalised; 1.0 is its widest.
    const amount = Math.max(0, Math.min(1, 0.5 + widthDelta / 120));
    out.push({
      id: nextId('master-width'),
      title: `폭 ${widthDelta > 0 ? '확장' : '축소'} → ${Math.round(amount * 100)}%`,
      reason: `현재 ${mix.widthPercent.toFixed(0)}%, 목표 ${target.widthPercent.toFixed(0)}% 입니다.`,
      confidence: 0.55,
      actions: [
        { kind: 'addInsert', trackId, pluginId: 'widener', slot: 2 },
        { kind: 'insertParam', trackId, pluginId: 'widener', paramId: 'amount', value: amount },
      ],
    });
  }

  // ── 4. Limiter ───────────────────────────────────────────────────────────
  const gain = Number.isFinite(mix.integratedLufs) ? target.lufs - mix.integratedLufs : 0;
  out.push({
    id: nextId('master-limit'),
    title: `리미터 실링 ${target.ceilingDbtp.toFixed(1)} dBTP`
      + (Math.abs(gain) >= 0.5 ? ` · 마스터 ${signed(gain)} dB` : ''),
    reason: `${target.name} 타깃은 ${target.lufs.toFixed(1)} LUFS / ${target.ceilingDbtp.toFixed(1)} dBTP.`
      + ` 현재 ${mix.integratedLufs.toFixed(1)} LUFS 입니다. ${target.note}`,
    confidence: 0.85,
    actions: [
      { kind: 'addInsert', trackId, pluginId: 'limiter', slot: 9 },
      { kind: 'insertParam', trackId, pluginId: 'limiter', paramId: 'ceilingDb', value: target.ceilingDbtp },
      ...(Math.abs(gain) >= 0.5 ? [{
        kind: 'trackVolume' as const, trackId,
        db: (findTrack(session, trackId)?.volumeDb ?? 0) + clamp(gain, 12),
      }] : []),
    ],
  });

  return out;
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function signed(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}
