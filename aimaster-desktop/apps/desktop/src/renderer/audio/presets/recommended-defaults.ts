// recommended-defaults — a working starting point for every module.
//
// The Studio ships every module at a neutral value, because a module must be
// bit-transparent until it is asked for something. That is right, and it is
// useless to a beginner: twenty-four panels of numbers that all do nothing,
// with no indication of which way is "normal". This file is the answer to
// "what would somebody who does this for a living put here?", per module,
// with the reason in Korean.
//
// # Where these numbers come from — read this before trusting them
//
// Two different kinds of number live here, and `basis` says which is which,
// because the difference matters:
//
//   'spec'     — published, checkable requirements. The -1.0 dBTP ceiling
//                and the 24-bit/48 kHz export are in the delivery specs
//                Spotify, Apple Music and YouTube publish. These are not
//                opinions.
//
//   'practice' — how contemporary commercial pop is normally mastered:
//                loudness in the -9 to -10 LUFS region, bass summed to mono
//                below ~120 Hz, gentle bus compression at 1-2 dB, a brighter
//                top than the source. Widely documented, widely taught, and
//                still a judgement call.
//
//   'ai-repair'— aimed at the specific defects of generative audio: the
//                reconstructed top octave, the smoothed transients, the
//                over-wide phasey stereo, the sibilance. These are the ones
//                that make a track stop sounding like AI.
//
// **What these are NOT**: measurements of specific chart records. Nobody here
// analysed the current Billboard 100 — that audio is not available to this
// program, and a number presented as "measured from the charts" when it was
// not would be the most damaging kind of wrong, because it is exactly the
// claim a user cannot check.
//
// If you want values genuinely derived from records you admire, the app can
// do that and it is better than any table: load them as **Match EQ
// references**. That measures the real tonal balance of real tracks on the
// engine's own grid and matches to it. This file is the sensible default for
// everyone who has not done that yet.

import type { ModuleId, ParameterValue } from '../parameters/index.js';

export type RecommendedBasis = 'spec' | 'practice' | 'ai-repair';

export interface RecommendedEntry {
  /** Bypass state to write, when the recommendation has an opinion on it. */
  bypass?: boolean;
  /** Parameters to write. Empty when the module has nothing fixed to set. */
  parameters: Record<string, ParameterValue>;
  /** One or two sentences a beginner can act on. */
  why: string;
  basis: RecommendedBasis;
  /**
   * True when the recommendation is "leave this switched off".
   *
   * Worth marking rather than hiding: for half the rack the professional
   * answer really is "not on this material", and a beginner who does not
   * hear that will switch everything on and wonder why it sounds worse.
   */
  off?: boolean;
}

/**
 * Exhaustive by type: a module added without an entry fails the build rather
 * than quietly having no recommendation.
 */
export const RECOMMENDED: Record<ModuleId, RecommendedEntry> = {
  // ── Restoration ────────────────────────────────────────────────────────
  declick: {
    bypass: true,
    parameters: {},
    off: true,
    why: '클릭·잡음이 실제로 들릴 때만 켜세요. 멀쩡한 음원에 켜면 어택(악기 때리는 순간)을 갉아먹습니다.',
    basis: 'practice',
  },
  dehum: {
    bypass: true,
    parameters: { depthDb: 0 },
    off: true,
    why: '전기 웅웅거림(60 Hz)이 들릴 때만 켜세요. AI 음원에는 보통 없습니다.',
    basis: 'practice',
  },
  denoise: {
    bypass: true,
    parameters: { reductionDb: 0 },
    off: true,
    why: '배경 잡음(치익 소리)이 들릴 때만 켜세요. 안 들리는데 켜면 고음이 물속처럼 됩니다.',
    basis: 'practice',
  },
  deess: {
    bypass: false,
    parameters: {
      frequencyHz: 7000, rangeDb: 4, thresholdDb: -28,
      ratio: 4, attackMs: 1, releaseMs: 60, wideband: false,
    },
    why: 'AI 보컬은 ㅅ·ㅊ 소리가 유난히 따갑습니다. 7 kHz 부근을 최대 4 dB만 눌러 자연스럽게 만듭니다.',
    basis: 'ai-repair',
  },
  'top-rebuild': {
    bypass: false,
    parameters: {
      amountPct: 45, crossoverHz: 9000, sourceHz: 4500,
      characterPct: 60, followMs: 12,
    },
    why: 'AI 음원 "번들거리는 고음"을 걷어내고 멀쩡한 중음에서 새 고음을 만들어 채웁니다. AI 티를 가장 크게 없애는 기능입니다.',
    basis: 'ai-repair',
  },

  // ── Corrective ─────────────────────────────────────────────────────────
  'parametric-eq': {
    parameters: {},
    off: true,
    why: '문제가 되는 특정 주파수를 직접 찾아 깎는 도구입니다. 정해진 추천값이 없고, 곡마다 다릅니다 — 귀에 거슬리는 지점이 있을 때만 밴드를 추가하세요.',
    basis: 'practice',
  },
  'match-eq': {
    bypass: true,
    parameters: { amountPct: 60, maxMoveDb: 6 },
    off: true,
    why: '먼저 닮고 싶은 곡을 레퍼런스로 불러와야 동작합니다. 불러오면 자동으로 켜집니다 — 이게 "빌보드 사운드"에 가장 확실하게 다가가는 방법입니다.',
    basis: 'practice',
  },
  'spectral-shaper': {
    bypass: false,
    parameters: {
      amountPct: 40, thresholdDb: 7, lowHz: 2000, highHz: 16000, blurBins: 12,
    },
    why: '특정 음에서만 튀어나오는 쇳소리를 그때그때 눌러줍니다. AI 음원의 금속성 질감에 잘 듣습니다.',
    basis: 'ai-repair',
  },
  stabilizer: {
    bypass: false,
    parameters: { amountPct: 25, tiltDbPerOct: -1.5, maxMoveDb: 4 },
    why: '곡 전체의 음색 기울기를 요즘 팝의 평균에 가깝게 살짝 끌어당깁니다. 25%면 곡의 개성은 남습니다.',
    basis: 'practice',
  },

  // ── Tone ───────────────────────────────────────────────────────────────
  'vintage-eq': {
    bypass: true,
    parameters: {
      lowBoostDb: 0, lowCutDb: 0, highBoostDb: 0, highCutDb: 0,
    },
    off: true,
    why: '옛 아날로그 EQ 특유의 색깔을 입히는 도구입니다. 필요한 보정이 아니라 취향이라 기본은 꺼둡니다.',
    basis: 'practice',
  },
  eq: {
    bypass: false,
    parameters: {
      lowCutHz: 30, lowCutQ: 0.707,
      lowShelfHz: 90, lowShelfDb: 0.6, lowShelfQ: 0.707,
      presenceHz: 2800, presenceDb: -0.8, presenceQ: 1.2,
      airHz: 13000, airDb: 2.0, airQ: 0.707,
      outputGainDb: 0,
    },
    why: '30 Hz 아래 안 들리는 저음을 잘라 헤드룸을 벌고, 귀에 쏘는 2.8 kHz를 살짝 눌러 따갑지 않게, 13 kHz를 올려 요즘 팝처럼 화사하게 만듭니다.',
    basis: 'practice',
  },
  'dynamic-eq': {
    bypass: false,
    parameters: {
      band0Enabled: true, band0Shape: 'bell', band0Mode: 'down',
      band0FrequencyHz: 3200, band0Q: 1.4, band0ThresholdDb: -26,
      band0Ratio: 3, band0RangeDb: 4, band0AttackMs: 5, band0ReleaseMs: 120,
    },
    why: '3.2 kHz가 시끄러워질 때만 눌러주는 자동 EQ입니다. 항상 깎지 않으니 조용한 구간의 선명함은 그대로 남습니다.',
    basis: 'ai-repair',
  },

  // ── Dynamics ───────────────────────────────────────────────────────────
  multiband: {
    bypass: false,
    parameters: {
      crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000,
      band0ThresholdDb: -22, band0Ratio: 1.6, band0AttackMs: 30, band0ReleaseMs: 180,
      band1ThresholdDb: -24, band1Ratio: 1.6, band1AttackMs: 20, band1ReleaseMs: 150,
      band2ThresholdDb: -26, band2Ratio: 1.6, band2AttackMs: 12, band2ReleaseMs: 120,
      band3ThresholdDb: -28, band3Ratio: 1.6, band3AttackMs: 8, band3ReleaseMs: 100,
    },
    why: '저음·중음·고음을 따로 정리해 킥이 크다고 보컬까지 눌리는 일을 막습니다. 1.6:1은 티 안 나게 다듬는 정도입니다.',
    basis: 'practice',
  },
  dynamics: {
    bypass: false,
    parameters: {
      thresholdDb: -16, ratio: 2, attackMs: 30, releaseMs: 180, mixPct: 100,
    },
    why: '곡 전체를 1~2 dB만 가볍게 눌러 악기들이 하나로 붙어 들리게 합니다. 어택 30 ms는 드럼의 때리는 맛을 남기려는 설정입니다.',
    basis: 'practice',
  },
  'vintage-comp': {
    bypass: true,
    parameters: { ratio: 1 },
    off: true,
    why: '컴프레서를 세 개 겹치면 초심자가 가장 흔히 소리를 망칩니다. 멀티밴드와 글루로 충분하니 기본은 꺼둡니다.',
    basis: 'practice',
  },
  impact: {
    bypass: false,
    parameters: {
      crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000,
      band0Pct: 8, band1Pct: 6, band2Pct: 10, band3Pct: 4,
    },
    why: 'AI 음원은 때리는 순간이 뭉개져 밋밋합니다. 각 대역의 어택을 조금씩 살려 사람이 연주한 느낌을 되돌립니다.',
    basis: 'ai-repair',
  },
  'low-end-focus': {
    bypass: false,
    parameters: { mode: 'punchy', frequencyHz: 90, contrastPct: 25, gainDb: 0.5 },
    why: '저음의 때리는 부분과 울리는 부분을 나눠 킥은 단단하게, 베이스는 뭉치지 않게 만듭니다.',
    basis: 'practice',
  },

  // ── Character ──────────────────────────────────────────────────────────
  exciter: {
    bypass: false,
    parameters: {
      mode: 'tube', crossover1Hz: 120, crossover2Hz: 800, crossover3Hz: 5000,
      band0Pct: 0, band1Pct: 0, band2Pct: 8, band3Pct: 12, driveDb: 6, outputDb: 0,
    },
    why: '중고음·고음에만 아주 옅은 배음을 더해 광택을 냅니다. 저음에는 걸지 않습니다 — 저음에 배음을 넣으면 탁해집니다.',
    basis: 'practice',
  },
  tape: {
    bypass: true,
    parameters: { mixPct: 0 },
    off: true,
    why: '테이프 특유의 부드러움을 입히는 취향 도구입니다. 요즘 팝 마스터에는 보통 쓰지 않습니다.',
    basis: 'practice',
  },
  delay: {
    bypass: true,
    parameters: { mixPct: 0 },
    off: true,
    why: '마스터링 단계에서 딜레이를 걸면 곡 전체가 번집니다. 딜레이는 믹스에서 악기별로 거는 것입니다.',
    basis: 'practice',
  },
  reverb: {
    bypass: true,
    parameters: { mixPct: 0 },
    off: true,
    why: '마스터에 리버브를 걸면 초점이 흐려지고 저음이 뭉갭니다. 공간감은 믹스에서 만드는 것입니다.',
    basis: 'practice',
  },

  // ── Output ─────────────────────────────────────────────────────────────
  imager: {
    bypass: false,
    parameters: {
      widthPct: 105, lowMonoHz: 120, stereoize: false,
      bandLowPct: 40, bandMidLowPct: 100, bandMidHighPct: 110, bandHighPct: 95,
    },
    why: '120 Hz 아래는 모노로 모아 어떤 스피커에서도 저음이 사라지지 않게 합니다. 고음은 살짝 좁혀 AI 특유의 위상 어긋난 넓이를 정리합니다.',
    basis: 'ai-repair',
  },
  limiter: {
    bypass: false,
    parameters: {
      targetLufs: -9.5, autoGain: true, maxBoostDb: 12, driveDb: 0,
      ceilingDbtp: -1.0, isp: true, lookaheadMs: 2.5, character: 'transparent',
    },
    why: '−1.0 dBTP는 스포티파이·애플뮤직·유튜브가 공통으로 권장하는 천장입니다(압축 변환 시 깨짐 방지). −9.5 LUFS는 요즘 차트 곡들의 일반적인 음압입니다.',
    basis: 'spec',
  },
  export: {
    bypass: false,
    parameters: {
      format: 'wav', sampleRate: '48000', bitDepth: '24',
      dither: 'tpdf', ditherAutoBlank: true,
    },
    why: '24비트 WAV는 모든 배급사가 받는 안전한 형식입니다. 16비트로 줄일 때만 디더가 필요하고, 24비트에서는 자동으로 꺼집니다.',
    basis: 'spec',
  },
};

/** The recommendation for one module, or undefined. */
export function recommendedFor(moduleId: ModuleId): RecommendedEntry | undefined {
  return RECOMMENDED[moduleId];
}

/** Parameter edits for one module, in the shape `setParams` takes. */
export function recommendedEdits(moduleId: ModuleId): Array<[string, ParameterValue]> {
  const entry = RECOMMENDED[moduleId];
  if (!entry) return [];
  return Object.entries(entry.parameters);
}

/** Modules whose recommendation is "leave it off". */
export function recommendedOffModules(): ModuleId[] {
  return (Object.keys(RECOMMENDED) as ModuleId[]).filter((id) => RECOMMENDED[id].off);
}

/** How the basis reads in the UI. */
export const BASIS_LABEL: Record<RecommendedBasis, string> = {
  spec: '배급 규격',
  practice: '업계 관행',
  'ai-repair': 'AI 음원 교정',
};
