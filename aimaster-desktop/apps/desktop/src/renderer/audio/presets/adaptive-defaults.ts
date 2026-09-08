// adaptive-defaults — the recommendation, but about THIS song.
//
// `recommended-defaults` is one table for everyone. That beats neutral and
// it is still wrong for any particular record: a dark ballad and a bright
// trap record need opposite EQ moves, and a compressor threshold in dBFS is
// a guess until somebody knows the programme level — which is exactly why
// the stock multiband starting point does nothing on a quiet mix.
//
// So this takes the measured `SongProfile` and adjusts the table.
//
// # Rules, not a model
//
// Every adjustment here is an explicit rule with a stated reason, and the
// reason is shown to the user next to the value. That is a deliberate choice
// over anything learned: a beginner cannot audit a number that came out of a
// black box, and the whole point of this feature is to teach what the
// controls do while it sets them. Every rule below can be read, argued with,
// and overridden.
//
// # The one that could not be guessed
//
// `hiss-gate.thresholdDb` is a per-bin level in dBFS, and the module is
// either inert or destructive at the wrong value. Nothing in a static table
// can know where a given file's noise floor sits. The profile measures it
// from the track's own quietest passage, which is the only place it is
// visible, and the threshold is set a margin above it.

import { RECOMMENDED, type RecommendedEntry } from './recommended-defaults.js';
import type { ModuleId, ParameterValue } from '../parameters/index.js';

/** What the main process measured. Mirrors `main/offline/song-profile.ts`. */
export interface SongProfile {
  durationSec: number;
  integratedLufs: number;
  truePeakDbtp: number;
  crestDb: number;
  curveDb: number[];
  tiltDbPerOct: number;
  subVsLowDb: number;
  harshDb: number;
  airDb: number;
  sibilanceDb: number;
  topCutoffHz: number | null;
  quietHfFloorDbfs: number;
  widthPct: number;
  lowCorrelation: number;
}

/** One adjustment the profile caused, for the panel to show. */
export interface AdaptiveNote {
  moduleId: ModuleId;
  /** What was measured, in Korean, with the number. */
  measured: string;
  /** What was changed because of it. */
  action: string;
}

export interface AdaptiveResult {
  /** The recommendation, adjusted. Same shape as `RECOMMENDED`. */
  entries: Record<ModuleId, RecommendedEntry>;
  /** Everything the profile changed, in rack order. */
  notes: AdaptiveNote[];
  /** One-line summary of the song, for the header. */
  summary: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
}

/**
 * Round to a step, so the panel shows a value a slider can actually hold.
 *
 * The second rounding is not superstition: `Math.round(-2.9/0.1)*0.1` is
 * -2.9000000000000004 in binary floating point, and that is what would
 * appear in the panel and in the user's saved settings.
 */
function step(v: number, s: number): number {
  const decimals = s < 1 ? Math.ceil(-Math.log10(s)) : 0;
  return Number((Math.round(v / s) * s).toFixed(decimals));
}

/**
 * Adjust every module's recommendation for one song.
 *
 * Returns the full table — modules with no rule keep the stock entry — plus
 * the list of what changed and why.
 */
export function adaptRecommended(profile: SongProfile | null): AdaptiveResult {
  const entries: Record<ModuleId, RecommendedEntry> = {} as Record<ModuleId, RecommendedEntry>;
  for (const key of Object.keys(RECOMMENDED) as ModuleId[]) {
    const base = RECOMMENDED[key];
    entries[key] = { ...base, parameters: { ...base.parameters } };
  }
  if (!profile) {
    return { entries, notes: [], summary: '분석 전 — 공통 추천값을 사용합니다.' };
  }

  const notes: AdaptiveNote[] = [];
  const set = (
    moduleId: ModuleId,
    params: Record<string, ParameterValue>,
    measured: string,
    action: string,
    bypass?: boolean,
  ): void => {
    const e = entries[moduleId];
    entries[moduleId] = {
      ...e,
      ...(bypass !== undefined ? { bypass, off: bypass } : {}),
      parameters: { ...e.parameters, ...params },
    };
    notes.push({ moduleId, measured, action });
  };

  // ── Hiss gate ──────────────────────────────────────────────────────────
  // The measurement that cannot be guessed. The threshold sits a margin
  // above the floor found in the track's quietest passage: high enough to
  // catch the noise, low enough that music never reaches it.
  //
  // A genuinely clean source has a floor far below anything the gate would
  // act on, and switching it on there would only cost latency — so a clean
  // file turns the module off rather than running it at a threshold nothing
  // will ever cross.
  {
    const floor = profile.quietHfFloorDbfs;
    if (floor < -95) {
      set(
        'hiss-gate', {}, `조용한 구간 고역 잡음 ${floor.toFixed(0)} dBFS — 매우 깨끗함`,
        '노이즈 게이트를 껐습니다. 지울 잡음이 없어 켜면 지연만 늘어납니다.',
        true,
      );
    } else {
      const threshold = clamp(step(floor + 8, 1), -100, -40);
      set(
        'hiss-gate', { thresholdDb: threshold },
        `조용한 구간 고역 잡음 바닥 ${floor.toFixed(0)} dBFS`,
        `기준선을 그 바로 위 ${threshold} dBFS 로 맞췄습니다. 이 곡의 잡음만 정확히 걸립니다.`,
        false,
      );
    }
  }

  // ── Top Rebuild ────────────────────────────────────────────────────────
  // A hard cutoff is the generative/lossy signature, and putting the
  // crossover exactly on it is worth far more than any stock value: below
  // it the audio is real, above it there is nothing to keep.
  {
    const cut = profile.topCutoffHz;
    if (cut !== null && cut >= 6_000 && cut <= 16_000) {
      const source = clamp(step(cut / 2, 100), 1_000, 8_000);
      set(
        'top-rebuild',
        { crossoverHz: clamp(step(cut, 100), 4_000, 16_000), sourceHz: source, amountPct: 70 },
        `${(cut / 1000).toFixed(1)} kHz 위로 소리가 뚝 끊깁니다 (AI·압축 음원의 특징)`,
        `그 지점부터 고역을 새로 만들도록 맞췄습니다. 재료는 절반인 ${(source / 1000).toFixed(1)} kHz 로 잡아 배음이 정확히 그 자리를 채웁니다.`,
      );
    } else if (profile.airDb < -18) {
      set(
        'top-rebuild', { amountPct: 60 },
        `고역(10~16 kHz)이 평균보다 ${profile.airDb.toFixed(0)} dB 낮음`,
        '고역이 많이 죽어 있어 재생성을 60%로 올렸습니다.',
      );
    } else if (profile.airDb > -4) {
      set(
        'top-rebuild', { amountPct: 25 },
        `고역이 이미 충분함 (평균 대비 ${profile.airDb.toFixed(0)} dB)`,
        '재생성을 25%로 낮췄습니다. 멀쩡한 고역을 굳이 갈아끼울 이유가 없습니다.',
      );
    }
  }

  // ── EQ ─────────────────────────────────────────────────────────────────
  {
    const params: Record<string, ParameterValue> = {};
    const bits: string[] = [];
    const acts: string[] = [];

    // Sub weight decides the high-pass. A track with real sub-bass content
    // must not have it cut at 30 Hz; a track with only rumble down there
    // gains headroom by losing it.
    if (profile.subVsLowDb > -6) {
      params.lowCutHz = 22;
      bits.push(`20~40 Hz 초저음이 살아 있음 (${profile.subVsLowDb.toFixed(0)} dB)`);
      acts.push('로우컷을 22 Hz로 내려 초저음을 지켰습니다');
    } else if (profile.subVsLowDb < -18) {
      params.lowCutHz = 40;
      bits.push(`초저음이 거의 없음 (${profile.subVsLowDb.toFixed(0)} dB)`);
      acts.push('로우컷을 40 Hz로 올려 안 들리는 저음을 걷어내고 헤드룸을 벌었습니다');
    }

    // Harshness decides the presence cut. Measured, so a smooth record does
    // not get a dip it never needed.
    if (profile.harshDb > 2) {
      params.presenceDb = clamp(step(-0.5 - profile.harshDb * 0.4, 0.1), -4, 0);
      bits.push(`2~4 kHz가 평균보다 ${profile.harshDb.toFixed(1)} dB 높아 쏘는 편`);
      acts.push(`그 대역을 ${String(params.presenceDb)} dB 눌렀습니다`);
    } else if (profile.harshDb < -3) {
      params.presenceDb = 0.8;
      bits.push(`2~4 kHz가 ${profile.harshDb.toFixed(1)} dB 낮아 답답한 편`);
      acts.push('그 대역을 +0.8 dB 올려 또렷하게 했습니다');
    }

    // Air: add what is missing rather than a fixed amount.
    const airTarget = -8;
    if (profile.airDb < airTarget - 3) {
      params.airDb = clamp(step((airTarget - profile.airDb) * 0.35, 0.1), 0, 5);
      bits.push(`고역이 평균보다 ${profile.airDb.toFixed(0)} dB 낮음`);
      acts.push(`에어를 +${String(params.airDb)} dB 로 올렸습니다`);
    } else if (profile.airDb > airTarget + 4) {
      params.airDb = 0.5;
      bits.push(`고역이 이미 밝음 (${profile.airDb.toFixed(0)} dB)`);
      acts.push('에어를 +0.5 dB만 남겼습니다 — 더 올리면 따갑습니다');
    }

    if (bits.length > 0) set('eq', params, bits.join(' · '), acts.join(', ') + '.');
  }

  // ── De-esser ───────────────────────────────────────────────────────────
  {
    const s = profile.sibilanceDb;
    if (s > -6) {
      const range = clamp(step(3 + (s + 6) * 0.8, 0.5), 2, 10);
      set(
        'deess', { rangeDb: range },
        `5~9 kHz가 중음 대비 ${s.toFixed(1)} dB — 치찰음이 강한 편`,
        `디에서 감쇠를 ${range} dB로 올렸습니다.`,
      );
    } else if (s < -16) {
      set(
        'deess', { rangeDb: 2 },
        `치찰음이 약함 (중음 대비 ${s.toFixed(1)} dB)`,
        '디에서를 2 dB로 낮췄습니다. 필요 없는 곳에 걸면 소리가 답답해집니다.',
      );
    }
  }

  // ── Stabilizer ─────────────────────────────────────────────────────────
  // The tilt target is where contemporary pop generally sits; how hard to
  // pull depends on how far this record already is from it.
  {
    const target = -1.5;
    const off = Math.abs(profile.tiltDbPerOct - target);
    if (off > 1.5) {
      const amount = clamp(step(20 + off * 12, 5), 20, 70);
      set(
        'stabilizer', { amountPct: amount, tiltDbPerOct: target },
        `음색 기울기 ${profile.tiltDbPerOct.toFixed(1)} dB/옥타브 (일반적인 팝은 ${target})`,
        `${amount}% 로 끌어당깁니다. 차이가 클수록 세게 잡습니다.`,
      );
    } else {
      set(
        'stabilizer', { amountPct: 15 },
        `음색 기울기가 이미 ${profile.tiltDbPerOct.toFixed(1)} dB/옥타브로 무난함`,
        '15%만 걸어 원래 색을 살렸습니다.',
      );
    }
  }

  // ── Compressors ────────────────────────────────────────────────────────
  // Thresholds placed against the MEASURED programme level. A threshold in
  // dBFS is a guess otherwise, which is why a stock -20 dB does nothing to
  // a quiet mix and squashes a loud one.
  {
    const lufs = clamp(profile.integratedLufs, -40, -3);
    // Glue sits a few dB under the programme so it catches peaks only.
    const glue = clamp(step(lufs - 2, 0.5), -30, -4);
    // Heavily-limited sources have nothing left to compress; say so rather
    // than adding a second layer of squash.
    const alreadySquashed = profile.crestDb < 8;
    if (alreadySquashed) {
      set(
        'dynamics', { thresholdDb: glue, ratio: 1.5, mixPct: 100 },
        `이미 많이 압축된 음원 (크레스트 ${profile.crestDb.toFixed(1)} dB)`,
        `글루를 1.5:1 로 약하게, 기준을 ${glue} dB 로 잡았습니다. 더 누르면 숨이 막힙니다.`,
      );
      set(
        'multiband',
        {
          band0ThresholdDb: clamp(step(lufs - 4, 0.5), -60, 0), band0Ratio: 1.3,
          band1ThresholdDb: clamp(step(lufs - 6, 0.5), -60, 0), band1Ratio: 1.3,
          band2ThresholdDb: clamp(step(lufs - 8, 0.5), -60, 0), band2Ratio: 1.3,
          band3ThresholdDb: clamp(step(lufs - 10, 0.5), -60, 0), band3Ratio: 1.3,
        },
        `측정 음량 ${profile.integratedLufs.toFixed(1)} LUFS`,
        '멀티밴드도 1.3:1 로 낮추고 기준을 실제 음량에 맞췄습니다.',
      );
    } else {
      set(
        'dynamics', { thresholdDb: glue },
        `측정 음량 ${profile.integratedLufs.toFixed(1)} LUFS · 크레스트 ${profile.crestDb.toFixed(1)} dB`,
        `글루 기준을 ${glue} dB 로 맞췄습니다. 고정값이면 이 곡에서는 아무 일도 안 했을 값입니다.`,
      );
      set(
        'multiband',
        {
          band0ThresholdDb: clamp(step(lufs - 4, 0.5), -60, 0),
          band1ThresholdDb: clamp(step(lufs - 6, 0.5), -60, 0),
          band2ThresholdDb: clamp(step(lufs - 8, 0.5), -60, 0),
          band3ThresholdDb: clamp(step(lufs - 10, 0.5), -60, 0),
        },
        `측정 음량 ${profile.integratedLufs.toFixed(1)} LUFS`,
        '멀티밴드 네 밴드의 기준을 실제 음량 기준으로 다시 잡았습니다.',
      );
    }
  }

  // ── Impact ─────────────────────────────────────────────────────────────
  {
    if (profile.crestDb > 14) {
      set(
        'impact', { band0Pct: 3, band1Pct: 2, band2Pct: 4, band3Pct: 2 },
        `다이내믹이 살아 있음 (크레스트 ${profile.crestDb.toFixed(1)} dB)`,
        '타격감 보정을 약하게 줄였습니다. 이미 때리는 맛이 있습니다.',
      );
    } else if (profile.crestDb < 9) {
      set(
        'impact', { band0Pct: 14, band1Pct: 10, band2Pct: 16, band3Pct: 8 },
        `어택이 뭉개져 있음 (크레스트 ${profile.crestDb.toFixed(1)} dB)`,
        '타격감 보정을 올려 때리는 순간을 되살립니다.',
      );
    }
  }

  // ── Imager ─────────────────────────────────────────────────────────────
  {
    const params: Record<string, ParameterValue> = {};
    const bits: string[] = [];
    const acts: string[] = [];
    if (profile.widthPct > 70) {
      params.widthPct = 98;
      params.bandHighPct = 88;
      bits.push(`좌우가 이미 매우 넓음 (사이드 ${profile.widthPct.toFixed(0)}%)`);
      acts.push('넓히지 않고 고역을 살짝 좁혔습니다 — AI 음원의 위상 어긋난 넓이입니다');
    } else if (profile.widthPct < 20) {
      params.widthPct = 115;
      params.bandHighPct = 110;
      bits.push(`좌우가 좁음 (사이드 ${profile.widthPct.toFixed(0)}%)`);
      acts.push('115%로 넓혔습니다');
    }
    if (profile.lowCorrelation < 0.7) {
      params.lowMonoHz = profile.lowCorrelation < 0.3 ? 200 : 150;
      bits.push(`저음 좌우 상관도 ${profile.lowCorrelation.toFixed(2)} — 모노로 합치면 저음이 빠질 수 있음`);
      acts.push(`${String(params.lowMonoHz)} Hz 아래를 모노로 모아 지켰습니다`);
    }
    if (bits.length > 0) set('imager', params, bits.join(' · '), acts.join(', ') + '.');
  }

  const summary = [
    `${profile.integratedLufs.toFixed(1)} LUFS`,
    `크레스트 ${profile.crestDb.toFixed(1)} dB`,
    `기울기 ${profile.tiltDbPerOct.toFixed(1)} dB/oct`,
    `사이드 ${profile.widthPct.toFixed(0)}%`,
    profile.topCutoffHz ? `고역 컷오프 ${(profile.topCutoffHz / 1000).toFixed(1)} kHz` : '고역 컷오프 없음',
    `잡음 바닥 ${profile.quietHfFloorDbfs.toFixed(0)} dBFS`,
  ].join(' · ');

  return { entries, notes, summary };
}
