// Voice starting points — the same track, sung by a different person.
//
// The genre set answers "what should the RECORD sound like".  The instrument
// set answers "what is on track 7".  Both already say 보컬 somewhere, and
// neither answers the question this file is for: track 7 is a voice, and the
// voice is a man's or a woman's, and almost every number you would reach for
// moves when that changes.
//
// It moves for ONE physical reason, and everything below follows from it: the
// fundamental is roughly an octave apart.  Every landmark — the mud, the
// honk, the presence, the sibilance — sits on top of the fundamental, so they
// all move up together.  A setting that opens up a baritone makes a soprano
// thin, and the same de-esser that tames her sibilance leaves his alone.
//
// ── The two profiles ─────────────────────────────────────────────────────────
//
// Written as numbers so they can be argued with.  If you think a male vocal's
// mud is at 300 Hz rather than 250, that is a claim about a row in a table,
// and the selftest holds the presets to whatever this says.
//
//   남성 보컬   Fundamental 85–180 Hz (bass through tenor).  So the HIGH-PASS
//               is the first thing that differs and the one that does most
//               damage when it is wrong: cutting at 120, which is safe on a
//               woman, takes the bottom octave off a baritone.  70–90 Hz.
//               Chest weight 100–250 Hz is the SOUND, not a problem.  The mud
//               that makes a male vocal boxy sits just above it, 250–400 Hz.
//               Nasal honk 800 Hz–1 kHz.  Intelligibility 2–4 kHz.  Sibilance
//               5–7 kHz, lower and softer than a woman's, so a de-esser parked
//               at 8 kHz does nothing at all.  Air past 10 kHz adds less,
//               because there is less up there to lift.
//
//   여성 보컬   Fundamental 165–350 Hz (alto through soprano) — an octave up,
//               and the whole file is that sentence repeated.  High-pass
//               100–140 Hz, which is where it can safely go BECAUSE the
//               fundamental is higher.  The 250–400 Hz region is not mud here;
//               it is the body, and cutting it the way you would on a man is
//               how a female vocal ends up sounding like a telephone.  Honk
//               1–1.5 kHz.  Presence 3–5 kHz.  Sibilance 6–10 kHz, louder and
//               higher — the de-esser has more work to do and has to do it
//               further up.  Air past 12 kHz is where the sheen lives and it
//               matters more than it does on a man.
//
// ── What follows from that ───────────────────────────────────────────────────
//
// Four claims the numbers below have to keep, and the selftest checks each:
//
//   1. the male high-pass is LOWER, on every device that has one
//   2. the male de-esser sits LOWER in frequency, and the female one works HARDER
//   3. the presence lift is lower on a man and higher on a woman
//   4. 250–400 Hz is cut on a man and left alone (or nearly) on a woman
//
// Anything else is a judgement, and is written in the note rather than
// pretended to be physics.

import type { PluginPreset } from './plugin-presets.js';
import { spaceIndex } from './reverb-spaces.js';

const S = spaceIndex;

export type VoiceId = 'male' | 'female';

/** Chip order: the way the two are named everywhere else in the app. */
export const VOICE_ORDER: readonly VoiceId[] = ['male', 'female'];

export const VOICE_LABEL: Record<VoiceId, string> = {
  male:   '남성 보컬',
  female: '여성 보컬',
};

/** The group these appear under in every plugin window. */
export const VOICE_GROUP = '목소리';

/**
 * Devices with no voice presets, and why — listed rather than inferred, so
 * adding a device without them fails the coverage test instead of quietly
 * shrinking the set.
 *
 * Same five the instrument set excuses, and for the same reasons: none of
 * them is about what is on the track.
 */
export const NO_VOICE_PRESETS: Readonly<Record<string, string>> = {
  dcblock:  '파라미터가 없습니다',
  phase:    '반전 · 교체 · 모노 — 배선 결정이지 목소리가 아닙니다',
  trim:     '게인 하나입니다. 프리셋은 이름 붙인 숫자일 뿐입니다',
  dither:   '쓰는 파일에 대한 것이지 누가 불렀는지와 무관합니다',
  loudness: 'LUFS 목표는 곡의 사실입니다. 목소리에 목표 라우드니스는 없습니다',
  matcheq:  '매치 EQ 의 설정은 특정 레퍼런스를 잰 결과 그 자체입니다. 프리셋 커브는 아무도 재지 않은 커브입니다',
  analyzer: '오디오를 건드리지 않습니다. 이 기기의 설정은 소리가 아니라 그림입니다',
};

/**
 * Devices where the voice legitimately moves ONE parameter, and why.
 *
 * `pitchcorrect` has `amount` and `formant`.  Amount genuinely differs — a
 * pop female lead is corrected harder than a male one, by convention and by
 * how the two sit against a grid.  Formant does not: a semitone shift is a
 * creative decision about a particular take, and filling that column with two
 * invented numbers to satisfy the differentiation test is exactly what the
 * header says this file does not do.
 */
export const VOICE_SINGLE_AXIS: Readonly<Record<string, string>> = {
  pitchcorrect: 'formant 는 성별로 답이 없습니다. amount 하나만 움직입니다',
};

interface VoiceEntry { note: string; params: Record<string, number> }

/**
 * Two presets for one device.
 *
 * The `Record<VoiceId, …>` is doing real work: leaving one out is a type
 * error, so a device that got the man and not the woman cannot reach the
 * repository.
 */
function voice(
  pluginId: string, entries: Record<VoiceId, VoiceEntry>,
): PluginPreset[] {
  return VOICE_ORDER.map((id) => ({
    id: `voice-${pluginId}-${id}`,
    pluginId,
    name: VOICE_LABEL[id],
    group: VOICE_GROUP,
    note: entries[id].note,
    params: entries[id].params,
  }));
}

export const VOICE_PRESETS: readonly PluginPreset[] = [
  // ── EQ ────────────────────────────────────────────────────────────────────
  ...voice('eq3', {
    male:   { note: '80 Hz 아래만 버립니다. 300 Hz 박스를 덜어내고 존재감을 올립니다',
              params: { hpfHz: 80, lowDb: -1.5, midHz: 300, midDb: -2.5, highDb: 2 } },
    female: { note: '120 Hz 까지 잘라도 안전합니다. 300 Hz 는 몸통이라 두고 1.2 k 를 덜어냅니다',
              params: { hpfHz: 120, lowDb: 0, midHz: 1200, midDb: -2, highDb: 3 } },
  }),
  ...voice('eq8', {
    male:   { note: '250–400 진흙, 900 비음, 3 k 명료도. 공기는 조금만',
              params: { hpfHz: 80, lowHz: 120, lowDb: -2, b1Hz: 300, b1Db: -2.5, b1Q: 1.2,
                        b2Hz: 900, b2Db: -1.5, b2Q: 1.4, b3Hz: 3000, b3Db: 2.5, b3Q: 0.9,
                        highHz: 9000, highDb: 1.5, lpfHz: 18000 } },
    female: { note: '300 대는 몸통이라 살짝만. 1.3 k 비음, 4.2 k 존재감, 11 k 공기',
              params: { hpfHz: 120, lowHz: 200, lowDb: -1, b1Hz: 420, b1Db: -1.5, b1Q: 1.1,
                        b2Hz: 1300, b2Db: -2, b2Q: 1.5, b3Hz: 4200, b3Db: 2.5, b3Q: 0.9,
                        highHz: 11000, highDb: 2.5, lpfHz: 19000 } },
  }),
  ...voice('tilt', {
    male:   { note: '700 Hz 를 축으로 살짝 밝게. 더 올리면 가슴 소리가 빠집니다',
              params: { tiltDb: 1.5, pivotHz: 700 } },
    female: { note: '축이 1.1 k 로 올라갑니다 — 기음이 그만큼 위에 있어서',
              params: { tiltDb: 2.5, pivotHz: 1100 } },
  }),
  ...voice('mseq', {
    male:   { note: '가운데 저역을 정리하고 사이드로 공기만 벌립니다',
              params: { midLowDb: -1.5, midHighDb: 1.5, sideLowDb: -3, sideHighDb: 2 } },
    female: { note: '가운데 저역은 거의 그대로. 사이드 고역을 더 벌려 시트를 만듭니다',
              params: { midLowDb: -0.5, midHighDb: 2.5, sideLowDb: -2, sideHighDb: 3 } },
  }),
  ...voice('dyneq', {
    male:   { note: '큰 음에서만 280 Hz 가슴 울림을 눌러줍니다',
              params: { freqHz: 280, q: 1.6, thresholdDb: -26, rangeDb: -4 } },
    female: { note: '누르는 곳이 1.1 k 비음으로 올라갑니다',
              params: { freqHz: 1100, q: 1.8, thresholdDb: -22, rangeDb: -3.5 } },
  }),
  ...voice('exciter', {
    male:   { note: '3.5 k 부터 — 남성 보컬은 명료도가 부족하지 공기가 부족한 게 아닙니다',
              params: { amount: 0.28, freqHz: 3500, mix: 0.25 } },
    female: { note: '6.5 k 부터, 그리고 적게. 이미 밝은 소스라 더하면 치찰음이 됩니다',
              params: { amount: 0.2, freqHz: 6500, mix: 0.18 } },
  }),

  // ── Dynamics ──────────────────────────────────────────────────────────────
  ...voice('comp', {
    male:   { note: '어택을 조금 늦춰 자음을 살립니다. 릴리즈는 느리게',
              params: { thresholdDb: -20, ratio: 3.5, kneeDb: 8, attackMs: 12, releaseMs: 140, makeupDb: 4 } },
    female: { note: '더 빠르고 더 부드럽게. 다이내믹 폭이 넓은 소스라 무릎을 넓게',
              params: { thresholdDb: -18, ratio: 3, kneeDb: 10, attackMs: 8, releaseMs: 110, makeupDb: 3.5 } },
  }),
  ...voice('ducker', {
    male:   { note: '이 보컬이 반주를 누를 때. 저역이 겹치므로 깊게',
              params: { thresholdDb: -26, ratio: 5, attackMs: 15, releaseMs: 180, makeupDb: 2 } },
    female: { note: '겹치는 대역이 위쪽이라 얕게, 그리고 빠르게 풀립니다',
              params: { thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 150, makeupDb: 2 } },
  }),
  ...voice('limiter', {
    male:   { note: '룩어헤드를 넉넉히 — 느린 파형이라 피크가 늦게 옵니다',
              params: { ceilingDb: -1.5, lookaheadMs: 3, releaseMs: 90 } },
    female: { note: '빠른 트랜지언트에 맞춰 짧게 잡고 빨리 놓습니다',
              params: { ceilingDb: -1.5, lookaheadMs: 2, releaseMs: 60 } },
  }),
  ...voice('gate', {
    male:   { note: '호흡이 낮고 큽니다. 문턱을 높게 두면 첫 음절이 잘립니다',
              params: { thresholdDb: -42, rangeDb: 18, attackMs: 3, releaseMs: 180 } },
    female: { note: '문턱을 더 낮춰도 됩니다 — 호흡이 그만큼 조용합니다',
              params: { thresholdDb: -46, rangeDb: 16, attackMs: 2, releaseMs: 150 } },
  }),
  ...voice('mbcomp', {
    male:   { note: '크로스오버가 낮습니다. 가슴 대역을 따로 잡아야 해서',
              params: { lowXHz: 160, highXHz: 3000, lowThrDb: -22, lowRatio: 3.5,
                        midThrDb: -20, midRatio: 2.5, hiThrDb: -24, hiRatio: 3, makeupDb: 2 } },
    female: { note: '크로스오버가 올라가고, 일을 하는 건 위쪽 밴드입니다',
              params: { lowXHz: 220, highXHz: 4000, lowThrDb: -18, lowRatio: 2.5,
                        midThrDb: -20, midRatio: 2.5, hiThrDb: -26, hiRatio: 3.5, makeupDb: 2 } },
  }),
  ...voice('clipper', {
    male:   { note: '파형이 느려서 클리핑을 더 먹일 수 있습니다',
              params: { driveDb: 3, ceilingDb: -1, hardness: 0.45 } },
    female: { note: '적게, 그리고 부드럽게 — 딱딱하면 치찰음이 각집니다',
              params: { driveDb: 2, ceilingDb: -1, hardness: 0.35 } },
  }),
  ...voice('transient', {
    male:   { note: '자음을 조금 세우고 꼬리를 줄입니다',
              params: { attack: 0.15, sustain: -0.1, mix: 0.8 } },
    female: { note: '어택은 덜 건드리고 꼬리를 더 줄입니다 — 이미 또렷합니다',
              params: { attack: 0.1, sustain: -0.2, mix: 0.7 } },
  }),
  ...voice('deesser', {
    male:   { note: '6 k. 8 k 에 두면 남성 치찰음에는 아무 일도 안 일어납니다',
              params: { freqHz: 6000, thresholdDb: -26, amount: 0.42 } },
    female: { note: '7.8 k 로 올리고 더 깊게 — 치찰음이 위에 있고 더 큽니다',
              params: { freqHz: 7800, thresholdDb: -28, amount: 0.55 } },
  }),

  // ── Saturation ────────────────────────────────────────────────────────────
  ...voice('saturation', {
    male:   { note: '배음을 더해 작은 스피커에서 살아남게 합니다',
              params: { driveDb: 5, mix: 0.3, bias: 0.1 } },
    female: { note: '적게 — 이미 있는 상배음이 지저분해지기 쉽습니다',
              params: { driveDb: 3.5, mix: 0.22, bias: 0.05 } },
  }),
  ...voice('tube', {
    male:   { note: '톤을 6 k 로 눌러 따뜻하게',
              params: { drive: 0.35, bias: 0.18, toneHz: 6000, mix: 45, outDb: -1 } },
    female: { note: '톤을 9 k 까지 열어 두고 드라이브는 줄입니다',
              params: { drive: 0.25, bias: 0.12, toneHz: 9000, mix: 35, outDb: -0.5 } },
  }),
  ...voice('bitcrush', {
    male:   { note: '효과로서. 낮은 기음이 비트 감소에 더 잘 버팁니다',
              params: { bits: 10, mix: 18 } },
    female: { note: '비트를 조금 더 남기고 덜 섞습니다',
              params: { bits: 11, mix: 14 } },
  }),

  // ── Modulation ────────────────────────────────────────────────────────────
  ...voice('chorus', {
    male:   { note: '느리고 깊게. 더블링처럼 들리게',
              params: { rateHz: 0.45, depthMs: 3.5, delayMs: 22, mix: 22 } },
    female: { note: '조금 빠르고 얕게 — 깊으면 음정이 흔들려 들립니다',
              params: { rateHz: 0.6, depthMs: 2.5, delayMs: 16, mix: 18 } },
  }),
  ...voice('amp', {
    male:   { note: '남성 보컬을 앰프에 넣을 때는 캐비닛의 고역 차단이 목적입니다 — '
                    + '한 단만, 마이크는 오프 액시스로',
              params: { gain: 30, stages: 1, master: 35, sag: 45, cab: 1, mic: 75, bass: -3, level: -3 } },
    female: { note: '여성 보컬은 캐비닛의 4 kHz 차단이 더 많이 깎아냅니다 — '
                    + '마이크를 축 쪽으로 돌려 명료도를 남깁니다',
              params: { gain: 24, stages: 1, master: 30, sag: 40, cab: 0, mic: 40, bass: -5, treble: 2, level: -3 } },
  }),
  ...voice('linphase', {
    male:   { note: '남성 보컬에 표준 길이 — 가슴소리를 좁게 덜고 프레즌스를 올립니다. '
                    + '위상이 돌지 않으니 더블링한 트랙과 합쳤을 때 얇아지지 않습니다',
              params: { length: 1, hpfHz: 75, lowDb: -1, lowHz: 120, b1Db: -3, b1Hz: 300, b1Q: 1.8,
                        b2Db: 2.5, b2Hz: 3000, b2Q: 1, highDb: 2 } },
    female: { note: '여성 보컬에 표준 길이 — 치찰음 자리를 건드리지 않고 에어만 올립니다. '
                    + '디에서 앞에 두면 두 기기가 같은 대역을 두 번 누르지 않습니다',
              params: { length: 1, hpfHz: 95, lowDb: -1.5, lowHz: 150, b1Db: -2.5, b1Hz: 400, b1Q: 1.6,
                        b2Db: 1.5, b2Hz: 2500, b2Q: 0.9, highDb: 3, highHz: 11000 } },
  }),
  ...voice('tape', {
    male:   { note: '남성 보컬에 15 ips — 범프가 60 Hz 라 가슴소리 바로 아래에 얹힙니다. '
                    + '워우는 거의 끄고: 목소리는 피치 흔들림을 가장 빨리 들킵니다',
              params: { speed: 1, drive: 4, bias: 0.5, bump: 3.5, wow: 0.08, flutter: 0.1, crosstalk: 0.1, mix: 0.85 } },
    female: { note: '여성 보컬에 30 ips — 범프를 100 Hz 로 올려 근음을 비우고, '
                    + '상단이 먼저 눌리는 성질로 치찰음을 부드럽게',
              params: { speed: 2, drive: 5, bias: 0.45, bump: 2, wow: 0.05, flutter: 0.08, crosstalk: 0.1, mix: 0.85 } },
  }),
  ...voice('rotary', {
    male:   { note: '남성 음역은 크로스오버 아래가 많아 드럼 로터로 갑니다 — '
                    + '크로스오버를 낮춰 혼 쪽으로 넘기고, 느린 코랄로',
              params: { rateHz: 0.7, xoverHz: 550, doppler: 70, throb: 35, drive: 6, mix: 40 } },
    female: { note: '여성 음역은 이미 혼 쪽이라 크로스오버를 올려 저역만 드럼에 남깁니다. '
                    + '도플러를 줄여야 음정이 흔들려 들리지 않습니다',
              params: { rateHz: 0.9, xoverHz: 1000, doppler: 50, throb: 30, drive: 4, mix: 32 } },
  }),
  ...voice('flanger', {
    male:   { note: '느리게. 짧은 딜레이가 저역과 간섭합니다',
              params: { rateHz: 0.22, depthMs: 1.6, delayMs: 4, feedback: 0.35, mix: 25 } },
    female: { note: '더 얕게, 피드백도 줄여 고역이 링하지 않게',
              params: { rateHz: 0.3, depthMs: 1.2, delayMs: 3, feedback: 0.3, mix: 20 } },
  }),
  ...voice('phaser', {
    male:   { note: '중심을 700 Hz 에 — 남성 보컬의 본체가 거기 있습니다',
              params: { rateHz: 0.3, depth: 0.6, centreHz: 700, feedback: 0.35, mix: 30 } },
    female: { note: '중심이 1.2 k 로 올라갑니다',
              params: { rateHz: 0.4, depth: 0.55, centreHz: 1200, feedback: 0.3, mix: 26 } },
  }),
  ...voice('tremolo', {
    male:   { note: '느리게 — 빠르면 낮은 기음과 맥놀이가 생겨 일그러짐처럼 들립니다',
              params: { rateHz: 4.5, depth: 0.35, shape: 0.3 } },
    female: { note: '조금 빠르고 얕게, 모양은 더 둥글게',
              params: { rateHz: 5.5, depth: 0.3, shape: 0.4 } },
  }),
  ...voice('autopan', {
    male:   { note: '느리게 흔들립니다. 리드에는 거의 안 씁니다',
              params: { rateHz: 0.35, depth: 0.35 } },
    female: { note: '조금 빠르게, 폭은 좁게',
              params: { rateHz: 0.5, depth: 0.3 } },
  }),

  // ── Delay ─────────────────────────────────────────────────────────────────
  ...voice('delay', {
    male:   { note: '길게 두어 가사와 겹치지 않게',
              params: { timeMs: 380, feedback: 0.28, mix: 0.22 } },
    female: { note: '조금 짧고 조금 조용하게 — 고역이 더 잘 들립니다',
              params: { timeMs: 320, feedback: 0.24, mix: 0.18 } },
  }),
  ...voice('pingpong', {
    male:   { note: '톤을 5 k 로 눌러 반복이 앞으로 나오지 않게',
              params: { timeMs: 400, feedback: 0.32, toneHz: 5000, mix: 24 } },
    female: { note: '톤을 7 k 로 열어도 됩니다. 대신 더 조용하게',
              params: { timeMs: 350, feedback: 0.28, toneHz: 7000, mix: 20 } },
  }),
  ...voice('tapedelay', {
    male:   { note: '어둡고 흔들리게. 3 k 이상은 반복에서 버립니다',
              params: { timeMs: 420, feedback: 0.38, toneHz: 3000, wowMs: 0.7, drive: 0.3, mix: 22 } },
    female: { note: '조금 밝게, 워우는 줄여 음정이 흐려지지 않게',
              params: { timeMs: 360, feedback: 0.32, toneHz: 4000, wowMs: 0.5, drive: 0.22, mix: 18 } },
  }),

  // ── Reverb ────────────────────────────────────────────────────────────────
  ...voice('reverb', {
    male:   { note: '짧게, 프리딜레이 길게 — 가사가 먼저 도착해야 합니다',
              params: { decaySec: 1.6, mix: 0.22, preDelayMs: 35 } },
    female: { note: '조금 길게 가도 됩니다. 고역이 먼저 사라져서',
              params: { decaySec: 1.9, mix: 0.26, preDelayMs: 28 } },
  }),
  ...voice('spacereverb', {
    male:   { note: '플레이트. 로우컷 180 으로 꼬리에서 가슴 대역을 뺍니다',
              params: { space: S('plate-vocal'), decayPct: 85, preDelayMs: 38, lowCutHz: 180,
                        highCutHz: 8500, erDb: -3, widthPct: 110, mixPct: 22 } },
    female: { note: '홀. 로우컷을 260 까지 올리고 하이컷은 11 k 로 열어 둡니다',
              params: { space: S('hall-recital'), decayPct: 95, preDelayMs: 30, lowCutHz: 260,
                        highCutHz: 11000, erDb: -2, widthPct: 120, mixPct: 25 } },
  }),
  ...voice('plate', {
    male:   { note: '댐핑을 낮춰 어둡게. 로우컷 200',
              params: { decaySec: 1.8, preDelayMs: 35, dampHz: 6500, diffusion: 0.72,
                        lowCutHz: 200, highCutHz: 12000, widthPct: 110, mixPct: 24 } },
    female: { note: '더 밝고 더 넓게. 로우컷 280 — 아래를 잘라도 잃을 게 없습니다',
              params: { decaySec: 2.1, preDelayMs: 28, dampHz: 8500, diffusion: 0.76,
                        lowCutHz: 280, highCutHz: 15000, widthPct: 120, mixPct: 26 } },
  }),
  ...voice('spring', {
    male:   { note: '보컬에는 드물게 씁니다. 톤을 낮춰 boing 을 숨깁니다',
              params: { decaySec: 1.6, toneHz: 1200, dampHz: 3600, boing: 0.5, mixPct: 16 } },
    female: { note: '톤이 올라가고 boing 은 줄입니다 — 고역에서 더 튑니다',
              params: { decaySec: 1.8, toneHz: 1600, dampHz: 4600, boing: 0.45, mixPct: 14 } },
  }),
  ...voice('shimmer', {
    male:   { note: '시머를 적게 — 옥타브 위가 원래 음역과 가까워 뭉칩니다',
              params: { decayPct: 110, shimmer: 0.35, loopMs: 200, preDelayMs: 45,
                        lowCutHz: 220, highCutHz: 10000, widthPct: 115, mixPct: 22 } },
    female: { note: '시머를 더 올려도 됩니다. 옥타브 위가 공기 대역으로 갑니다',
              params: { decayPct: 120, shimmer: 0.45, loopMs: 170, preDelayMs: 35,
                        lowCutHz: 300, highCutHz: 13000, widthPct: 125, mixPct: 26 } },
  }),

  // ── Stereo ────────────────────────────────────────────────────────────────
  ...voice('widener', {
    male:   { note: '저역 모노 지점을 160 으로. 그 아래가 벌어지면 모노에서 사라집니다',
              params: { width: 1.15, lowMonoHz: 160 } },
    female: { note: '더 벌려도 안전합니다. 모노 지점도 220 까지',
              params: { width: 1.25, lowMonoHz: 220 } },
  }),
  ...voice('monomaker', {
    male:   { note: '150 Hz 아래를 가운데로 모읍니다 — 기음이 거기 있습니다',
              params: { freqHz: 150, widthPct: 100 } },
    female: { note: '220 까지 모아도 잃을 게 없습니다',
              params: { freqHz: 220, widthPct: 110 } },
  }),
  ...voice('haas', {
    male:   { note: '길게 — 짧으면 저역에서 콤필터가 들립니다',
              params: { delayMs: 14, amount: 0.35 } },
    female: { note: '짧게, 약하게 — 콤 노치가 존재감 대역에 떨어지면 바로 들립니다',
              params: { delayMs: 11, amount: 0.3 } },
  }),

  // ── Restoration ───────────────────────────────────────────────────────────
  ...voice('denoise', {
    male:   { note: '문턱을 낮게 — 낮은 호흡을 잡음으로 오해하면 첫 음절이 사라집니다',
              params: { thresholdDb: -52, amount: 0.35, releaseMs: 140 } },
    female: { note: '조금 올려도 됩니다. 릴리즈는 빠르게',
              params: { thresholdDb: -50, amount: 0.3, releaseMs: 110 } },
  }),
  ...voice('hum', {
    male:   { note: '배음을 적게. 60·120·180 이 이미 기음 위에 앉아 있어서 더 파면 목소리를 팝니다',
              params: { harmonics: 3, q: 40 } },
    female: { note: '기음이 위에 있으니 배음을 더 지워도 됩니다. Q 도 넓게',
              params: { harmonics: 5, q: 30 } },
  }),
  ...voice('pitchcorrect', {
    male:   { note: '약하게. 포먼트는 건드리지 않습니다 — 성별로 정답이 없습니다',
              params: { amount: 0.72, formant: 0 } },
    female: { note: '팝 리드 관습대로 더 강하게. 포먼트는 역시 그대로',
              params: { amount: 0.85, formant: 0 } },
  }),
];

/**
 * Pull the voice group out of a device's preset groups.
 *
 * Same reasoning as `partitionInstrument`: a closed set you know the whole of
 * before opening the menu is a row of chips, not two entries to scroll past.
 * Two is the smallest closed set there is, so it is the strongest case for a
 * row rather than the weakest.
 */
export function partitionVoice(
  groups: ReadonlyArray<{ group: string; presets: PluginPreset[] }>,
): { voice: PluginPreset[]; rest: Array<{ group: string; presets: PluginPreset[] }> } {
  const found = groups.find((g) => g.group === VOICE_GROUP);
  return {
    voice: found?.presets ?? [],
    rest: groups.filter((g) => g.group !== VOICE_GROUP),
  };
}
