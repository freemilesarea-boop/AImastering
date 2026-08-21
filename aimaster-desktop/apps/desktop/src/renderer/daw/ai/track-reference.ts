// Per-track reference matching — "make my vocal sit like theirs".
//
// The master REFERENCE window already compares a whole mix to a whole mix.
// This is the same idea one level down, and it starts with a refusal, because
// the obvious version of this feature is a lie:
//
//   YOU CANNOT COMPARE A VOCAL TO A FINISHED MASTER.  A commercial mix has
//   kick energy at 60 Hz, guitars at 2 kHz and cymbals at 12 kHz.  Measuring
//   its spectrum and calling the difference "what your vocal needs" produces
//   confident, specific, completely wrong EQ moves — and they LOOK right,
//   which is what makes them expensive.
//
// So a per-track reference has to be a source of the same kind, and this
// module asks which one it is:
//
//   stem          a solo'd track of the same role.  Tone, dynamics and width
//                 compare honestly; level does not, because a stem's absolute
//                 level means nothing.
//   stemWithMix   that stem AND the mix it came from.  Now level compares too,
//                 as a RELATIONSHIP: their vocal sits 4.2 LU under their mix,
//                 yours sits 7.8 LU under yours, so yours comes up 3.6 dB.
//                 This is the number people actually want.
//   mix           a finished master.  Refused, with the reason and a pointer
//                 to the window that does compare masters.
//
// Two more rules keep the moves from being spectral-matching in disguise:
//
//   BANDS COME FROM THE ROLE.  A vocal comparison has no 40 Hz band in it, so
//   it cannot propose a 40 Hz move no matter what the numbers say.
//   BANDS WITH NO ENERGY ARE NOT COMPARED.  Two sources that are both silent
//   at 12 kHz differ by noise, and noise makes very confident EQ.
//
// Pure.  Takes measurements, returns rows and actions; renders nothing.

import { bandLevelDb, type ReferenceAnalysis, type SpectrumCurve } from '../analysis/reference.js';
import { roleLabel, type TrackRole } from './roles.js';
import type { TrackAnalysis } from './analysis.js';
import type { Suggestion } from './actions.js';
import type { DawSession, TrackId } from '../model/types.js';

// ── What a reference is ───────────────────────────────────────────────────────

export type ReferenceKind = 'stem' | 'stemWithMix' | 'mix';

export interface TrackReference {
  name: string;
  kind: ReferenceKind;
  /** The reference source itself — the stem, or the master when kind is 'mix'. */
  source: ReferenceAnalysis;
  /** The mix that stem came from.  Required by, and only used by, 'stemWithMix'. */
  mix?: ReferenceAnalysis;
}

// ── Where each role's decisions live ──────────────────────────────────────────

export interface Band {
  id: string;
  label: string;
  lowHz: number;
  highHz: number;
}

/**
 * The bands a role is actually mixed in.
 *
 * This table is the feature's main safety rail and it works by omission: a
 * band that is not here cannot be proposed.  A lead vocal has no business
 * being EQ'd at 40 Hz from a reference comparison, so 40 Hz is not in its
 * list — not capped, not weighted down, simply absent.
 */
const ROLE_BANDS: Partial<Record<TrackRole, Band[]>> = {
  vocal: [
    { id: 'body',     label: '바디',     lowHz: 100,  highHz: 300 },
    { id: 'lowmid',   label: '로우미드', lowHz: 300,  highHz: 800 },
    { id: 'mid',      label: '중역',     lowHz: 800,  highHz: 2000 },
    { id: 'presence', label: '프레즌스', lowHz: 2000, highHz: 5000 },
    { id: 'air',      label: '공기',     lowHz: 5000, highHz: 12000 },
  ],
  kick: [
    { id: 'sub',    label: '서브',   lowHz: 30,   highHz: 60 },
    { id: 'thump',  label: '펀치',   lowHz: 60,   highHz: 120 },
    { id: 'box',    label: '박스',   lowHz: 200,  highHz: 500 },
    { id: 'click',  label: '클릭',   lowHz: 2000, highHz: 6000 },
  ],
  bass: [
    { id: 'sub',    label: '서브',   lowHz: 30,   highHz: 60 },
    { id: 'weight', label: '무게',   lowHz: 60,   highHz: 150 },
    { id: 'body',   label: '바디',   lowHz: 150,  highHz: 500 },
    { id: 'grind',  label: '그라인드', lowHz: 700, highHz: 2500 },
  ],
  snare: [
    { id: 'body',   label: '바디',   lowHz: 120,  highHz: 250 },
    { id: 'lowmid', label: '로우미드', lowHz: 250, highHz: 800 },
    { id: 'crack',  label: '크랙',   lowHz: 1500, highHz: 4000 },
    { id: 'sizzle', label: '시즐',   lowHz: 5000, highHz: 12000 },
  ],
  hat: [
    { id: 'stick',  label: '스틱',   lowHz: 1500, highHz: 5000 },
    { id: 'shine',  label: '광택',   lowHz: 6000, highHz: 16000 },
  ],
  drums: [
    { id: 'low',    label: '저역',   lowHz: 40,   highHz: 120 },
    { id: 'body',   label: '바디',   lowHz: 120,  highHz: 500 },
    { id: 'attack', label: '어택',   lowHz: 1000, highHz: 4000 },
    { id: 'cymbal', label: '심벌',   lowHz: 6000, highHz: 16000 },
  ],
};

/** Guitars, keys, synths and pads share a shape; so does anything unnamed. */
const GENERIC_BANDS: Band[] = [
  { id: 'low',      label: '저역',     lowHz: 80,   highHz: 250 },
  { id: 'lowmid',   label: '로우미드', lowHz: 250,  highHz: 800 },
  { id: 'mid',      label: '중역',     lowHz: 800,  highHz: 2500 },
  { id: 'presence', label: '프레즌스', lowHz: 2500, highHz: 8000 },
];

export function bandsForRole(role: TrackRole): Band[] {
  if (role === 'backing') return ROLE_BANDS.vocal ?? GENERIC_BANDS;
  return ROLE_BANDS[role] ?? GENERIC_BANDS;
}

// ── Is this really a stem? ────────────────────────────────────────────────────

/**
 * The bottom and top octaves — the two ends of the audible range.
 *
 * The first version of this counted how many octaves carried energy, and it
 * did not work: a lead vocal and a whole arrangement both measure about six,
 * because both roll off gently and neither is a flat line.  Measured on the
 * synthetic fixtures, a vocal reads 80 Hz at −12 dB and a full mix reads it at
 * −3 — close enough that no threshold separates them.
 *
 * What DOES separate them is having both ends at once.  An arrangement has a
 * kick under 80 Hz AND cymbals over 10 kHz.  A vocal has neither.  A bass has
 * the bottom and nothing on top; a hi-hat the reverse.  So the test is two
 * ended, and it is named for what it measures rather than for the conclusion
 * it suggests.
 */
const BOTTOM_BAND: readonly [number, number] = [40, 80];
const TOP_BAND: readonly [number, number] = [10000, 16000];

/**
 * How far under the loudest part of the spectrum an end may sit and still
 * count as occupied.  Generous on purpose: this raises an eyebrow, it does not
 * block anything, so a false negative costs nothing and a false positive costs
 * the user's trust in every other note this module writes.
 */
const END_FLOOR_DB = 30;

export interface SpectralSpan {
  bottomDb: number;
  topDb: number;
  /** Both ends occupied — the shape of a whole arrangement. */
  full: boolean;
}

/** Where a source's two ends sit relative to its own loudest band. */
export function spectralSpan(spectrum: SpectrumCurve): SpectralSpan {
  let peak = -120;
  for (let i = 0; i < spectrum.hz.length; i++) peak = Math.max(peak, spectrum.db[i] ?? -120);
  const bottomDb = bandLevelDb(spectrum, BOTTOM_BAND[0], BOTTOM_BAND[1]) - peak;
  const topDb = bandLevelDb(spectrum, TOP_BAND[0], TOP_BAND[1]) - peak;
  return {
    bottomDb, topDb,
    full: bottomDb > -END_FLOOR_DB && topDb > -END_FLOOR_DB,
  };
}

export function looksLikeFullMix(analysis: ReferenceAnalysis): boolean {
  return spectralSpan(analysis.spectrum).full;
}

// ── Comparing ─────────────────────────────────────────────────────────────────

export type RowKind = 'level' | 'tone' | 'crest' | 'width';
export type Verdict = 'match' | 'over' | 'under';

export interface TrackRow {
  id: string;
  kind: RowKind;
  label: string;
  unit: string;
  reference: number;
  mine: number;
  /** mine − reference. */
  delta: number;
  verdict: Verdict;
  /** Why this row is not being compared, when it is not. */
  skipped?: string;
}

export interface TrackComparison {
  trackId: TrackId;
  trackName: string;
  role: TrackRole;
  referenceName: string;
  rows: TrackRow[];
  /** 0…100.  Only over the rows that were actually compared. */
  score: number;
  /** Set when no comparison is possible at all, with the reason. */
  blocked?: string;
  /** Things the user should know about a comparison that DID run. */
  notes: string[];
}

/** Inside this, the two are the same and nothing should move. */
const TOLERANCE = { tone: 1.0, level: 1.0, crest: 1.5, width: 12 } as const;

/**
 * A band whose level is this far under the source's own loudest band carries
 * no signal worth comparing.  Two sources that are both empty at 12 kHz differ
 * by measurement noise, and noise makes very confident EQ moves.
 */
const BAND_FLOOR_DB = 35;

function peakBandDb(curve: SpectrumCurve, bands: readonly Band[]): number {
  let peak = -120;
  for (const band of bands) {
    peak = Math.max(peak, bandLevelDb(curve, band.lowHz, band.highHz));
  }
  return peak;
}

const verdictFor = (delta: number, tolerance: number): Verdict =>
  (Math.abs(delta) <= tolerance ? 'match' : delta > 0 ? 'over' : 'under');

/**
 * One track against one reference.
 *
 * `myMix` is this session's full mix, and it is only needed for the level row
 * — the one comparison that has to be relative to something.  A comparison
 * with no level row is still a useful comparison, which is why it is optional
 * rather than required.
 */
export function compareTrackToReference(
  mine: TrackAnalysis,
  reference: TrackReference,
  myMix: ReferenceAnalysis | null = null,
): TrackComparison {
  const role = mine.guess.role;
  const base = {
    trackId: mine.trackId,
    trackName: mine.name,
    role,
    referenceName: reference.name,
  };

  // The refusal that makes the rest of this honest.
  if (reference.kind === 'mix') {
    return {
      ...base, rows: [], score: 0, notes: [],
      blocked: `${reference.name} 은 완성된 믹스입니다 — 한 트랙과 비교할 수 없습니다.`
        + ' 스템(솔로 트랙)을 넣거나, 마스터끼리 비교하려면 REFERENCE 창을 쓰세요',
    };
  }
  if (mine.silent) {
    return { ...base, rows: [], score: 0, notes: [], blocked: `${mine.name} 에서 소리가 나지 않습니다` };
  }
  if (reference.source.durationSec < 0.5) {
    return { ...base, rows: [], score: 0, notes: [], blocked: '레퍼런스가 너무 짧습니다' };
  }

  const bands = bandsForRole(role);
  const rows: TrackRow[] = [];
  const notes: string[] = [];

  // ── Level, as a relationship ───────────────────────────────────────────────
  if (reference.kind === 'stemWithMix' && reference.mix && myMix) {
    const theirs = reference.source.integratedLufs - reference.mix.integratedLufs;
    const ours = mine.integratedLufs - myMix.integratedLufs;
    if (Number.isFinite(theirs) && Number.isFinite(ours)) {
      const delta = ours - theirs;
      rows.push({
        id: 'level', kind: 'level', label: '믹스 대비 레벨', unit: 'LU',
        reference: theirs, mine: ours, delta, verdict: verdictFor(delta, TOLERANCE.level),
      });
    }
  } else if (reference.kind === 'stem') {
    notes.push('레퍼런스의 믹스가 없어 레벨은 비교하지 않습니다 — 음색과 다이내믹만 봅니다');
  } else if (!myMix) {
    notes.push('내 믹스를 아직 분석하지 않아 레벨은 비교하지 않습니다');
  }

  // ── Tone ───────────────────────────────────────────────────────────────────
  const myPeak = peakBandDb(mine.spectrum, bands);
  const theirPeak = peakBandDb(reference.source.spectrum, bands);
  for (const band of bands) {
    const theirs = bandLevelDb(reference.source.spectrum, band.lowHz, band.highHz);
    const ours = bandLevelDb(mine.spectrum, band.lowHz, band.highHz);
    const quiet = ours < myPeak - BAND_FLOOR_DB || theirs < theirPeak - BAND_FLOOR_DB;
    const delta = ours - theirs;
    rows.push({
      id: band.id, kind: 'tone',
      label: `${band.label} ${band.lowHz}–${band.highHz} Hz`, unit: 'dB',
      reference: theirs, mine: ours, delta,
      verdict: quiet ? 'match' : verdictFor(delta, TOLERANCE.tone),
      ...(quiet ? { skipped: '양쪽 다 이 대역에 에너지가 없습니다' } : {}),
    });
  }

  // ── Dynamics ───────────────────────────────────────────────────────────────
  const theirCrest = reference.source.dr;
  if (Number.isFinite(mine.crestDb) && Number.isFinite(theirCrest)) {
    const delta = mine.crestDb - theirCrest;
    rows.push({
      id: 'crest', kind: 'crest', label: '다이내믹 (크레스트)', unit: 'dB',
      reference: theirCrest, mine: mine.crestDb, delta,
      verdict: verdictFor(delta, TOLERANCE.crest),
    });
  }

  // ── Width ──────────────────────────────────────────────────────────────────
  // A mono stem has no width to compare, and calling its 0 % a difference
  // would propose widening something that has one channel.
  const bothStereo = reference.source.channels > 1 && mine.widthPercent > 0.5;
  if (bothStereo) {
    const delta = mine.widthPercent - reference.source.widthPercent;
    rows.push({
      id: 'width', kind: 'width', label: '폭', unit: '%',
      reference: reference.source.widthPercent, mine: mine.widthPercent, delta,
      verdict: verdictFor(delta, TOLERANCE.width),
    });
  } else if (reference.source.channels <= 1) {
    notes.push('레퍼런스가 모노라 폭은 비교하지 않습니다');
  }

  // Said, not enforced.  The user knows what their file is; the measurement
  // only gets to raise an eyebrow before its numbers move someone's EQ.
  if (looksLikeFullMix(reference.source)) {
    notes.push(`${reference.name} 은 최저역부터 최고역까지 다 차 있습니다`
      + ' — 스템이 아니라 풀 믹스일 수 있습니다');
  }

  const compared = rows.filter((r) => !r.skipped);
  const matched = compared.filter((r) => r.verdict === 'match').length;
  return {
    ...base,
    rows,
    notes,
    score: compared.length > 0 ? Math.round((matched / compared.length) * 100) : 0,
  };
}

// ── Turning rows into moves ───────────────────────────────────────────────────

export interface TrackMatchOptions {
  /** Largest EQ move per band, dB. */
  maxEqDb?: number;
  /** Largest fader move, dB. */
  maxGainDb?: number;
  /**
   * How many bands may move at once.
   *
   * Three, because fixing five bands from a spectral difference stops being
   * mixing and becomes spectral matching — a process that reliably produces a
   * track that measures like the reference and sounds like neither.
   */
  maxBands?: number;
}

const DEFAULTS = { maxEqDb: 4, maxGainDb: 6, maxBands: 3 } as const;

let counter = 0;
const nextId = (): string => `tref-${(counter += 1)}`;
export function resetTrackMatchIds(): void { counter = 0; }

const clamp = (v: number, limit: number): number => Math.max(-limit, Math.min(limit, v));
const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
const centreOf = (band: Band): number => Math.round(Math.sqrt(band.lowHz * band.highHz));

/**
 * Which eq8 control a band should use.
 *
 * The shelves take the extremes and the three bells take the middle, which is
 * both what the device offers and what an engineer would reach for.  Two bands
 * competing for the same bell is resolved by giving it to the bigger
 * difference — the loser is reported, not silently dropped.
 */
function eqSlotFor(index: number, total: number): { db: string; hz: string; q?: string } | null {
  if (total === 1) return { db: 'b2Db', hz: 'b2Hz', q: 'b2Q' };
  if (index === 0) return { db: 'lowDb', hz: 'lowHz' };
  if (index === total - 1) return { db: 'highDb', hz: 'highHz' };
  const bell = index;                       // 1, 2, 3 for the middle bands
  if (bell > 3) return null;
  return { db: `b${bell}Db`, hz: `b${bell}Hz`, q: `b${bell}Q` };
}

/** eq8's own limits, so a proposal never asks for a frequency it cannot set. */
const EQ_RANGE: Record<string, { min: number; max: number }> = {
  lowHz: { min: 40, max: 400 },
  b1Hz: { min: 60, max: 2000 },
  b2Hz: { min: 200, max: 8000 },
  b3Hz: { min: 800, max: 16000 },
  highHz: { min: 2000, max: 16000 },
};

/**
 * The comparison, as moves on that track's own chain.
 *
 * Nothing lands on the master: this is the per-track feature, and a fader move
 * that turned out to be a master move would be the worst kind of surprise.
 */
export function matchTrackActions(
  session: DawSession, comparison: TrackComparison, options: TrackMatchOptions = {},
): Suggestion[] {
  if (comparison.blocked) return [];
  const track = session.tracks.find((t) => t.id === comparison.trackId);
  if (!track) return [];
  const trackId = track.id;
  const maxEq = options.maxEqDb ?? DEFAULTS.maxEqDb;
  const maxGain = options.maxGainDb ?? DEFAULTS.maxGainDb;
  const maxBands = options.maxBands ?? DEFAULTS.maxBands;
  const out: Suggestion[] = [];
  const role = roleLabel(comparison.role);

  // ── Level ──────────────────────────────────────────────────────────────────
  const level = comparison.rows.find((r) => r.kind === 'level');
  if (level && level.verdict !== 'match') {
    const move = clamp(-level.delta, maxGain);
    out.push({
      id: nextId(),
      title: `${track.name} 페이더 ${signed(move)} dB`,
      reason: `${comparison.referenceName} 의 ${role} 은 자기 믹스보다 ${level.reference.toFixed(1)} LU 아래,`
        + ` ${track.name} 은 ${level.mine.toFixed(1)} LU 아래입니다.`
        + ' 절대 레벨이 아니라 믹스와의 관계를 맞춥니다.',
      confidence: 0.75,
      actions: [{ kind: 'trackVolume', trackId, db: track.volumeDb + move }],
    });
  }

  // ── Tone ───────────────────────────────────────────────────────────────────
  const bands = bandsForRole(comparison.role);
  const toneRows = comparison.rows.filter((r) => r.kind === 'tone' && !r.skipped && r.verdict !== 'match');
  const ranked = [...toneRows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const chosen = ranked.slice(0, maxBands);
  const dropped = ranked.slice(maxBands);

  if (chosen.length > 0) {
    const actions: Suggestion['actions'] = [];
    const parts: string[] = [];
    // Bands are addressed in frequency order so the shelves really are the
    // extremes — ranking by size would put a mid band on the low shelf.
    const ordered = chosen
      .map((row) => ({ row, index: bands.findIndex((b) => b.id === row.id) }))
      .filter((e) => e.index >= 0)
      .sort((a, b) => a.index - b.index);

    ordered.forEach((entry, position) => {
      const controls = eqSlotFor(position, ordered.length);
      const band = bands[entry.index];
      if (!controls || !band) return;
      const move = clamp(-entry.row.delta, maxEq);
      const range = EQ_RANGE[controls.hz];
      const hz = range
        ? Math.max(range.min, Math.min(range.max, centreOf(band)))
        : centreOf(band);
      actions.push(
        { kind: 'insertParam', trackId, pluginId: 'eq8', paramId: controls.hz, value: hz },
        { kind: 'insertParam', trackId, pluginId: 'eq8', paramId: controls.db, value: move },
      );
      if (controls.q) {
        actions.push({ kind: 'insertParam', trackId, pluginId: 'eq8', paramId: controls.q, value: 1.1 });
      }
      parts.push(`${band.label} ${signed(move)} dB`);
    });

    if (actions.length > 0) {
      out.push({
        id: nextId(),
        title: `${track.name} 음색 매칭 — ${parts.join(' · ')}`,
        reason: `${comparison.referenceName} 대비 ${role} 대역 차이를 좁힙니다. 스펙트럼은 레벨`
          + ' 정규화되어 있으므로 이건 음색 차이지 레벨 차이가 아닙니다.'
          + (dropped.length > 0
            ? ` 차이가 더 작은 ${dropped.length}개 대역(${dropped.map((r) => r.label.split(' ')[0]).join(' · ')})은`
              + ' 남겨 뒀습니다 — 대역을 전부 맞추면 믹싱이 아니라 스펙트럼 복사가 됩니다.'
            : ''),
        confidence: 0.7,
        actions: [{ kind: 'addInsert', trackId, pluginId: 'eq8' }, ...actions],
      });
    }
  }

  // ── Dynamics ───────────────────────────────────────────────────────────────
  const crest = comparison.rows.find((r) => r.kind === 'crest');
  if (crest && crest.verdict === 'over') {
    // Mine is MORE dynamic than the reference.  The other direction has no
    // honest move: you cannot uncompress a track, and proposing an expander
    // to "match dynamics" is a guess dressed as a measurement.
    const ratio = Math.min(4, 1.5 + crest.delta / 5);
    out.push({
      id: nextId(),
      title: `${track.name} 컴프레서 ${ratio.toFixed(1)}:1`,
      reason: `${comparison.referenceName} 의 크레스트 ${crest.reference.toFixed(1)} dB,`
        + ` ${track.name} 은 ${crest.mine.toFixed(1)} dB 입니다.`,
      confidence: 0.55,
      actions: [
        { kind: 'addInsert', trackId, pluginId: 'comp' },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'ratio', value: ratio },
        { kind: 'insertParam', trackId, pluginId: 'comp', paramId: 'thresholdDb', value: -(6 + crest.delta) },
      ],
    });
  }

  // ── Width ──────────────────────────────────────────────────────────────────
  const width = comparison.rows.find((r) => r.kind === 'width');
  if (width && width.verdict !== 'match') {
    const amount = Math.max(0, Math.min(1, 0.5 - width.delta / 120));
    out.push({
      id: nextId(),
      title: `${track.name} 폭 ${width.delta > 0 ? '축소' : '확장'} → ${Math.round(amount * 100)}%`,
      reason: `레퍼런스 ${width.reference.toFixed(0)}%, ${track.name} ${width.mine.toFixed(0)}% 입니다.`,
      confidence: 0.5,
      actions: [
        { kind: 'addInsert', trackId, pluginId: 'widener' },
        { kind: 'insertParam', trackId, pluginId: 'widener', paramId: 'amount', value: amount },
      ],
    });
  }

  return out;
}

// ── Describing ────────────────────────────────────────────────────────────────

export function trackMatchSummary(
  comparison: TrackComparison, suggestions: readonly Suggestion[],
): string {
  if (comparison.blocked) return comparison.blocked;
  if (suggestions.length === 0) {
    return `${comparison.trackName} 은 ${comparison.referenceName} 와 이미 ${comparison.score}% 일치합니다`;
  }
  return `${comparison.score}% 일치 · 제안 ${suggestions.length}개`;
}

/** `프레즌스 2000–5000 Hz  −2.4 dB` — one row, for the table. */
export function formatRow(row: TrackRow): string {
  if (row.skipped) return `${row.label}  —  ${row.skipped}`;
  return `${row.label}  ${signed(row.delta)} ${row.unit}`;
}
