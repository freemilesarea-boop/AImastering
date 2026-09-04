// album-levels.ts — making a record play at one level without flattening it.
//
// Two different jobs share the name "level matching" and they are opposites.
//
//   ALBUM normalisation — ONE gain for the whole record, chosen so the album's
//   integrated loudness hits the target.  Every song keeps its level RELATIVE
//   to the others, so the quiet interlude stays quiet and the single stays
//   loud.  This is what an album is, and what streaming platforms do in album
//   mode.
//
//   TRACK matching — a gain PER SONG, so each one hits the target on its own.
//   Right for a compilation of unrelated recordings.  Wrong for an album,
//   because it destroys the arrangement of the record: the artist decided the
//   ballad sits 4 dB under the opener, and this throws that away.
//
// The default is album, and that is a deliberate stance rather than a
// preference — a tool that quietly flattens the dynamics between somebody's
// songs is doing damage they will not hear until the record is pressed.
//
// The loudness numbers come from the master each track already produced, so
// nothing is re-analysed here.  This module is arithmetic on measurements.

/** How loud a track came out.  What the mastering result already reports. */
export interface TrackLoudness {
  trackId: string;
  integratedLufs: number;
  truePeakDbtp: number;
  durationSec: number;
}

export type LevelMode = 'album' | 'track' | 'off';

export const LEVEL_LABELS: Record<LevelMode, string> = {
  album: '앨범 기준 (곡 사이 관계 유지)',
  track: '곡별 맞춤 (모두 같은 크기로)',
  off:   '건드리지 않음',
};

export interface LevelOptions {
  mode: LevelMode;
  /** Where the album, or each track, should land. */
  targetLufs: number;
  /**
   * True-peak ceiling.  A gain that would push a track past this is reduced
   * until it does not — the ceiling wins over the target, always.
   */
  ceilingDbtp: number;
  /** Cap on how far any one track may be moved, so a mistake stays small. */
  maxAdjustDb: number;
}

export const DEFAULT_LEVELS: LevelOptions = {
  mode: 'album', targetLufs: -14, ceilingDbtp: -1, maxAdjustDb: 6,
};

export interface TrackAdjust {
  trackId: string;
  gainDb: number;
  /** The true peak this track will have after the gain. */
  peakAfterDbtp: number;
  /** Set when the ceiling, not the target, decided this track's gain. */
  ceilingLimited: boolean;
  /** Set when `maxAdjustDb` clamped it. */
  clamped: boolean;
}

export interface LevelPlan {
  mode: LevelMode;
  adjustments: TrackAdjust[];
  /** The album's integrated loudness before any of this. */
  albumLufsBefore: number;
  /** And after, as the plan predicts it. */
  albumLufsAfter: number;
  /** The loudest true peak on the record afterwards. */
  peakAfterDbtp: number;
}

const EPS = 1e-9;

/**
 * The album's integrated loudness: the energy-weighted mean over its length.
 *
 * NOT the average of the per-track LUFS numbers.  Loudness is logarithmic, so
 * averaging the dB values gives a number that belongs to no signal — and a
 * 30-second interlude would count as much as an eight-minute closer.  Convert
 * to energy, weight by duration, convert back.
 */
export function albumLoudness(tracks: readonly TrackLoudness[]): number {
  let energy = 0;
  let seconds = 0;
  for (const t of tracks) {
    if (!(t.durationSec > 0)) continue;
    // −Infinity and NaN both fail `isFinite`, and they mean opposite things.
    //
    //   −Infinity is DIGITAL SILENCE — what EBU R128 returns for a silent
    //   track — and a silent minute genuinely does pull an album's integrated
    //   loudness down.  Its duration counts; its energy is zero.
    //
    //   NaN is NOT MEASURED.  A track whose loudness nobody knows must not
    //   push the album number in either direction, so it is skipped whole.
    //
    // Lumping the two together (the first draft did) means a track that failed
    // to analyse silently reads as silence, and the album target comes out
    // wrong by however long that track is.
    if (Number.isNaN(t.integratedLufs)) continue;
    if (t.integratedLufs !== -Infinity) {
      energy += Math.pow(10, t.integratedLufs / 10) * t.durationSec;
    }
    seconds += t.durationSec;
  }
  if (seconds <= EPS || energy <= 0) return -Infinity;
  return 10 * Math.log10(energy / seconds);
}

/**
 * What to do to each track.
 *
 * The ceiling is applied AFTER the target, and it only ever reduces: a track
 * whose peak would go over is pulled back, and in album mode that pull-back is
 * applied to EVERY track so the relative levels the mode exists to protect are
 * still protected.  Letting one loud track keep the whole record 2 dB quieter
 * is the price of album mode, and it is the right price.
 */
export function planLevels(
  tracks: readonly TrackLoudness[], options: Partial<LevelOptions> = {},
): LevelPlan {
  const opts: LevelOptions = { ...DEFAULT_LEVELS, ...options };
  const before = albumLoudness(tracks);

  if (opts.mode === 'off' || tracks.length === 0) {
    return {
      mode: opts.mode,
      adjustments: tracks.map((t) => ({
        trackId: t.trackId, gainDb: 0, peakAfterDbtp: t.truePeakDbtp,
        ceilingLimited: false, clamped: false,
      })),
      albumLufsBefore: before,
      albumLufsAfter: before,
      peakAfterDbtp: peakOf(tracks, () => 0),
    };
  }

  // Step 1 — the gain the target asks for, per track or once for the record.
  const wanted = new Map<string, number>();
  if (opts.mode === 'album') {
    const g = Number.isFinite(before) ? opts.targetLufs - before : 0;
    for (const t of tracks) wanted.set(t.trackId, g);
  } else {
    for (const t of tracks) {
      wanted.set(t.trackId, Number.isFinite(t.integratedLufs) ? opts.targetLufs - t.integratedLufs : 0);
    }
  }

  // Step 2 — the clamp, before the ceiling.  A clamp applied after would let a
  // track sail past maxAdjustDb whenever the ceiling happened to pull it back.
  const clamped = new Map<string, boolean>();
  for (const t of tracks) {
    const g = wanted.get(t.trackId) ?? 0;
    const held = Math.max(-opts.maxAdjustDb, Math.min(opts.maxAdjustDb, g));
    clamped.set(t.trackId, Math.abs(held - g) > 1e-6);
    wanted.set(t.trackId, held);
  }

  // Step 3 — the ceiling.  In album mode ONE reduction, the worst offender's,
  // applied to everything; in track mode each track answers for itself.
  const overBy = (t: TrackLoudness): number =>
    t.truePeakDbtp + (wanted.get(t.trackId) ?? 0) - opts.ceilingDbtp;
  let ceilingHit = false;

  if (opts.mode === 'album') {
    let worst = 0;
    for (const t of tracks) worst = Math.max(worst, overBy(t));
    if (worst > 0) {
      ceilingHit = true;
      for (const t of tracks) wanted.set(t.trackId, (wanted.get(t.trackId) ?? 0) - worst);
    }
  } else {
    for (const t of tracks) {
      const over = overBy(t);
      if (over > 0) { ceilingHit = true; wanted.set(t.trackId, (wanted.get(t.trackId) ?? 0) - over); }
    }
  }

  const adjustments: TrackAdjust[] = tracks.map((t) => {
    const gainDb = wanted.get(t.trackId) ?? 0;
    return {
      trackId: t.trackId,
      gainDb,
      peakAfterDbtp: t.truePeakDbtp + gainDb,
      ceilingLimited: ceilingHit && overBy(t) >= -1e-6,
      clamped: clamped.get(t.trackId) ?? false,
    };
  });

  const after = albumLoudness(tracks.map((t) => ({
    ...t,
    integratedLufs: t.integratedLufs + (wanted.get(t.trackId) ?? 0),
  })));

  return {
    mode: opts.mode,
    adjustments,
    albumLufsBefore: before,
    albumLufsAfter: after,
    peakAfterDbtp: peakOf(tracks, (t) => wanted.get(t.trackId) ?? 0),
  };
}

function peakOf(tracks: readonly TrackLoudness[], gain: (t: TrackLoudness) => number): number {
  let peak = -Infinity;
  for (const t of tracks) peak = Math.max(peak, t.truePeakDbtp + gain(t));
  return peak;
}

/**
 * The spread between the quietest and loudest song, after the plan.
 *
 * The number that says whether album mode did its job: it should be the SAME
 * before and after, because album mode moves everything together.  Track mode
 * drives it to zero, which is the point of track mode and the damage of it.
 */
export function loudnessSpread(
  tracks: readonly TrackLoudness[], plan?: LevelPlan,
): number {
  const gains = new Map(plan?.adjustments.map((a) => [a.trackId, a.gainDb]) ?? []);
  let lo = Infinity, hi = -Infinity;
  for (const t of tracks) {
    if (!Number.isFinite(t.integratedLufs)) continue;
    const v = t.integratedLufs + (gains.get(t.trackId) ?? 0);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0;
}

export function describeLevels(plan: LevelPlan, tracks: readonly TrackLoudness[]): string {
  if (plan.mode === 'off') return '레벨을 건드리지 않았습니다';
  const spread = loudnessSpread(tracks, plan).toFixed(1);
  const moved = plan.adjustments.filter((a) => Math.abs(a.gainDb) > 0.05).length;
  const ceiling = plan.adjustments.some((a) => a.ceilingLimited)
    ? `, 트루피크 상한에 걸려 ${plan.peakAfterDbtp.toFixed(2)} dBTP 로 제한` : '';
  return `${LEVEL_LABELS[plan.mode]} — ${plan.albumLufsAfter.toFixed(1)} LUFS, `
    + `${moved}곡 조정, 곡 간 차이 ${spread} dB${ceiling}`;
}
