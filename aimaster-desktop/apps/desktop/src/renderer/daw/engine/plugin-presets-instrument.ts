// Instrument starting points.
//
// The genre set in `plugin-presets-genre.ts` is organised by RECORD: you know
// what the song is supposed to sound like before you know what is on track 7.
// These are the other axis.  You have a bass on track 7 and it is too big in
// the low mids; that is a fact about a bass, and it is the same fact whether
// the record is 재즈 or EDM.
//
// Both menus are on every device, because both questions are real and they do
// not answer each other.  Pick the instrument to get the device into the right
// postcode, then the genre — or your ears — for the rest.
//
// ── What an instrument profile is ────────────────────────────────────────────
//
// One paragraph of what the source actually IS, in frequencies and time, that
// every device below has to agree with.  Written down so it can be argued
// with: if you think an acoustic guitar's body boom is at 120 Hz rather than
// 200, that is a claim about a number in a table.
//
//   드럼 루프    A finished stereo kit, not one drum.  So the transient is the
//               whole point and anything with a fast attack eats it: attacks
//               stay slow (10–30 ms) and releases fast, which is the opposite
//               of how you would treat a single kick.  Kick fundamental
//               50–60 Hz, so the high-pass has to stay under it.  Snap lives
//               at 2–5 kHz, cymbal air at 10 kHz+.  Gating a LOOP is a
//               different job from gating a close mic — there is bleed you
//               want to keep — so gate ranges here are shallow.
//
//   베이스      Mono, always, and the one instrument where that is not a
//               stylistic choice: a wide low end cancels on any mono system.
//               Fundamental 40–120 Hz, the note you actually HEAR on a phone
//               is the 700–900 Hz harmonic, and finger/string noise is at
//               2–3 kHz.  High-pass only to lose rumble (~30 Hz) — cutting at
//               80 like a guitar removes the instrument.  Compression is
//               heavy and slow to attack, so the pluck survives and the
//               sustain does not.  Saturation is not an effect here; it is how
//               the part stays audible on a speaker with no low end at all.
//
//   일렉 기타    Already band-limited by the amp and cabinet: effectively
//               nothing under 80 Hz or over 6 kHz.  So the high-pass sits at
//               80–100 and treble boosts above 6 kHz only lift hiss.  The
//               problem frequency is the 800 Hz–1 kHz honk; the good one is
//               2.5–4 kHz presence.  Spring reverb and slapback are native to
//               this instrument rather than effects on it.
//
//   어쿠스틱 기타 (통기타)  A wide-range source pretending to be a narrow one.
//               The body boom at 150–250 Hz is what makes a recording sound
//               amateur, and the pick and string detail at 4–8 kHz is the
//               character.  Air matters to 15 kHz, so unlike the electric it
//               is a full-range instrument.  Light compression — it is a
//               dynamic instrument and squashing it makes it plastic.  Plate
//               or room, never spring.
//
//   피아노      The widest range here: fundamentals from 27 Hz to 4 kHz and
//               harmonics past 15 kHz, so almost every band does something.
//               Mud at 200–400 Hz, hammer and attack at 2–5 kHz.  Compression
//               is the biggest risk on this instrument, because the dynamics
//               ARE the performance — ratios stay near 2:1 and often the
//               right answer is not to.  Naturally stereo; widening it
//               usually just moves the phase around.
//
//   스트링      An ensemble with no transient at all: bows start notes over
//               tens of milliseconds, so a fast attack finds nothing to catch
//               and a slow one is inaudible.  Body 200–400 Hz, and rosin and
//               bow noise at 6–10 kHz, which is the harshness people reach
//               for an EQ about.  Long halls are normal rather than an
//               effect.  Very light compression; wide.
//
//   신스        The one source that can be anything, so the presets aim at
//               what synths actually get WRONG rather than at a sound: too
//               much sub fighting the bass, too wide to survive mono, too
//               static to sit in a mix, and harsh at 3–6 kHz on anything
//               saw-based.  Treated as the thing you have to make room for.
//
// ── What is NOT here, and why ────────────────────────────────────────────────
//
// Five devices get no instrument presets.  Four of them have no instrument
// preset for the same reason they have no genre preset, and the fifth is new:
//
//   dcblock   has no parameters at all.
//   phase     is invert / swap / mono — a wiring decision, not a sound.
//   trim      is one gain.  A preset for it would be a number with a name.
//   dither    belongs to the file being written, not to what is on the track.
//   loudness  is an integrated-LUFS target, which is a fact about a RECORD.
//             A bass track does not have a target loudness; the song does.
//             The genre set has one because a genre really does; giving an
//             instrument one would be inventing a number to fill a column.

import type { PluginPreset } from './plugin-presets.js';
import { spaceIndex } from './reverb-spaces.js';

const S = spaceIndex;

export type InstrumentId =
  | 'drumloop' | 'bass' | 'egtr' | 'agtr' | 'piano' | 'strings' | 'synth';

/** The order the seven appear in every device's menu. */
export const INSTRUMENT_ORDER: readonly InstrumentId[] = [
  'drumloop', 'bass', 'egtr', 'agtr', 'piano', 'strings', 'synth',
];

export const INSTRUMENT_LABEL: Record<InstrumentId, string> = {
  drumloop: '드럼 루프',
  bass:     '베이스',
  egtr:     '일렉 기타',
  agtr:     '어쿠스틱 기타',
  piano:    '피아노',
  strings:  '스트링',
  synth:    '신스',
};

/** The group these appear under in every plugin window. */
export const INSTRUMENT_GROUP = '악기';

/**
 * Devices with no instrument presets, and why — listed rather than inferred,
 * so adding a device without them fails the coverage test instead of quietly
 * shrinking the set.
 */
export const NO_INSTRUMENT_PRESETS: Readonly<Record<string, string>> = {
  dcblock:  '파라미터가 없습니다',
  phase:    '반전 · 교체 · 모노 — 배선 결정이지 소리가 아닙니다',
  trim:     '게인 하나입니다. 프리셋은 이름 붙인 숫자일 뿐입니다',
  dither:   '쓰는 파일에 대한 것이지 트랙에 뭐가 있는지와 무관합니다',
  loudness: 'LUFS 목표는 곡의 사실입니다. 베이스 트랙에는 목표 라우드니스가 없습니다',
};

/**
 * Devices where the instrument legitimately moves ONE parameter, and why.
 *
 * The differentiation test normally insists two presets differ in at least
 * two parameters, because on most devices a pair that moves one knob is a
 * paste somebody forgot to finish.  Here it is the truth about the device:
 * `pitchcorrect` has `amount` and `formant`, and formant is a semitone shift
 * with no per-instrument answer.  Filling that column with seven invented
 * numbers to satisfy a test is precisely what the header above says this file
 * does not do — so the exemption is declared, in the source, next to the data
 * it excuses.
 */
export const SINGLE_AXIS_DEVICES: Readonly<Record<string, string>> = {
  pitchcorrect: 'formant 는 악기마다 답이 없습니다. amount 하나만 움직입니다',
};

interface InstrumentEntry { note: string; params: Record<string, number> }

/**
 * Seven presets for one device.
 *
 * The `Record<InstrumentId, …>` is doing real work: leaving an instrument out
 * is a type error, so "I did five and got bored" cannot reach the repository.
 */
function inst(
  pluginId: string, entries: Record<InstrumentId, InstrumentEntry>,
): PluginPreset[] {
  return INSTRUMENT_ORDER.map((id) => ({
    id: `inst-${pluginId}-${id}`,
    pluginId,
    name: INSTRUMENT_LABEL[id],
    group: INSTRUMENT_GROUP,
    note: entries[id].note,
    params: entries[id].params,
  }));
}

/**
 * Pull the instrument group out of a device's preset groups.
 *
 * Same reasoning as `partitionGenre`: a closed set of seven that you know the
 * name of before opening the menu is a row of chips, not a dropdown entry to
 * scroll past.
 */
export function partitionInstrument(
  groups: ReadonlyArray<{ group: string; presets: PluginPreset[] }>,
): { instrument: PluginPreset[]; rest: Array<{ group: string; presets: PluginPreset[] }> } {
  const found = groups.find((g) => g.group === INSTRUMENT_GROUP);
  return {
    instrument: INSTRUMENT_ORDER
      .map((id) => found?.presets.find((p) => p.name === INSTRUMENT_LABEL[id]))
      .filter((p): p is PluginPreset => p !== undefined),
    rest: groups.filter((g) => g.group !== INSTRUMENT_GROUP),
  };
}

export const INSTRUMENT_PRESETS: readonly PluginPreset[] = [

  // ══ EQ ═════════════════════════════════════════════════════════════════════

  ...inst('eq3', {
    drumloop: { note: '킥이 50 Hz 에 있으니 하이패스는 그 아래로. 2.5 kHz 스냅을 올립니다',
                params: { hpfHz: 35, lowDb: 2, midDb: 2, midHz: 2500, highDb: 2.5 } },
    bass:     { note: '30 Hz 만 걷어냅니다. 800 Hz 를 올려야 폰에서 음이 들립니다',
                params: { hpfHz: 30, lowDb: 2.5, midDb: 2, midHz: 800, highDb: -2 } },
    egtr:     { note: '앰프가 이미 잘라놨습니다. 900 Hz 헝크를 깎고 고역은 건드리지 않습니다',
                params: { hpfHz: 90, lowDb: -1, midDb: -3, midHz: 900, highDb: 0.5 } },
    agtr:     { note: '200 Hz 통울림을 깎고 피크 소리를 올립니다. 통기타의 성격은 고역에 있습니다',
                params: { hpfHz: 80, lowDb: -2.5, midDb: -2, midHz: 220, highDb: 3.5 } },
    piano:    { note: '300 Hz 머드만 덜어냅니다. 피아노는 대체로 EQ 를 적게 받는 쪽이 낫습니다',
                params: { hpfHz: 40, lowDb: 0.5, midDb: -2, midHz: 300, highDb: 1.5 } },
    strings:  { note: '7 kHz 활 소리가 쏩니다. 고역을 내리고 몸통을 살짝 올립니다',
                params: { hpfHz: 60, lowDb: 1, midDb: -1.5, midHz: 320, highDb: -2 } },
    synth:    { note: '베이스와 겹치는 저역을 잘라 자리를 비웁니다. 신스는 대개 너무 꽉 찹니다',
                params: { hpfHz: 120, lowDb: -2, midDb: -1.5, midHz: 450, highDb: 1 } },
  }),

  ...inst('eq8', {
    drumloop: { note: '60 Hz 킥, 250 Hz 박스 컷, 3.5 kHz 스냅, 11 kHz 심벌 공기',
                params: { hpfHz: 32, lowDb: 2.5, lowHz: 60, b1Db: -3, b1Hz: 250, b1Q: 1.2,
                          b2Db: 1, b2Hz: 900, b2Q: 0.8, b3Db: 3, b3Hz: 3500, b3Q: 0.9,
                          highDb: 2.5, highHz: 11000, lpfHz: 20000 } },
    bass:     { note: '70 Hz 몸통, 250 Hz 머드 컷, 850 Hz 음정, 2.5 kHz 핑거 노이즈. 위는 버립니다',
                params: { hpfHz: 28, lowDb: 3, lowHz: 70, b1Db: -3.5, b1Hz: 250, b1Q: 1.4,
                          b2Db: 2.5, b2Hz: 850, b2Q: 1, b3Db: 1.5, b3Hz: 2500, b3Q: 1.2,
                          highDb: -4, highHz: 8000, lpfHz: 12000 } },
    egtr:     { note: '앰프 대역만 남깁니다 — 100 Hz 아래와 7 kHz 위는 하울과 히스뿐입니다',
                params: { hpfHz: 100, lowDb: -1.5, lowHz: 160, b1Db: -4, b1Hz: 900, b1Q: 1.6,
                          b2Db: 2, b2Hz: 2800, b2Q: 0.9, b3Db: 1, b3Hz: 4500, b3Q: 1.1,
                          highDb: -2, highHz: 9000, lpfHz: 7500 } },
    agtr:     { note: '180 Hz 붐을 깎고 5 kHz 피크와 13 kHz 에어를 올립니다. 풀레인지 악기입니다',
                params: { hpfHz: 85, lowDb: -3, lowHz: 180, b1Db: -2, b1Hz: 380, b1Q: 1.1,
                          b2Db: 1.5, b2Hz: 1800, b2Q: 0.8, b3Db: 3, b3Hz: 5000, b3Q: 0.9,
                          highDb: 3, highHz: 13000, lpfHz: 20000 } },
    piano:    { note: '거의 손대지 않습니다. 320 Hz 만 덜고 해머와 공기를 조금 올립니다',
                params: { hpfHz: 38, lowDb: 1, lowHz: 90, b1Db: -2.5, b1Hz: 320, b1Q: 1,
                          b2Db: 0.5, b2Hz: 1500, b2Q: 0.7, b3Db: 1.5, b3Hz: 3500, b3Q: 0.8,
                          highDb: 2, highHz: 12000, lpfHz: 20000 } },
    strings:  { note: '8 kHz 로진 노이즈를 −3 dB. 스트링에서 거슬리는 건 거의 항상 여기입니다',
                params: { hpfHz: 65, lowDb: 1.5, lowHz: 140, b1Db: 1, b1Hz: 300, b1Q: 0.7,
                          b2Db: -2, b2Hz: 1200, b2Q: 1, b3Db: -3, b3Hz: 8000, b3Q: 1.3,
                          highDb: 1, highHz: 14000, lpfHz: 18000 } },
    synth:    { note: '150 Hz 아래를 비우고 4 kHz 톱니 거슬림을 깎습니다. 자리를 만드는 EQ 입니다',
                params: { hpfHz: 130, lowDb: -2, lowHz: 200, b1Db: -1.5, b1Hz: 500, b1Q: 0.9,
                          b2Db: 1, b2Hz: 1600, b2Q: 0.8, b3Db: -3, b3Hz: 4200, b3Q: 1.4,
                          highDb: 2, highHz: 10000, lpfHz: 20000 } },
  }),

  ...inst('tilt', {
    drumloop: { note: '1.2 kHz 를 축으로 살짝 밝게. 루프 전체 성격을 한 손잡이로 바꿉니다',
                params: { tiltDb: 2, pivotHz: 1200 } },
    bass:     { note: '아래로 기울입니다. 베이스에서 고역은 대개 방해입니다',
                params: { tiltDb: -3.5, pivotHz: 700 } },
    egtr:     { note: '앰프 대역 한가운데를 축으로 아주 살짝만',
                params: { tiltDb: -1.5, pivotHz: 900 } },
    agtr:     { note: '위로 기울여 통울림을 상대적으로 낮춥니다',
                params: { tiltDb: 3, pivotHz: 600 } },
    piano:    { note: '거의 평평하게. 피아노는 기울이면 바로 티가 납니다',
                params: { tiltDb: 0.5, pivotHz: 1000 } },
    strings:  { note: '아래로 — 활 소리를 낮추면 스트링은 대체로 좋아집니다',
                params: { tiltDb: -2.5, pivotHz: 2000 } },
    synth:    { note: '위로 밝게. 신스는 밝아야 다른 악기 위에 얹힙니다',
                params: { tiltDb: 2.5, pivotHz: 1500 } },
  }),

  ...inst('mseq', {
    drumloop: { note: '가운데 저역은 킥, 옆 고역은 오버헤드. 그 둘만 올립니다',
                params: { midLowDb: 2, midHighDb: 0, sideLowDb: -4, sideHighDb: 3 } },
    bass:     { note: '옆을 전부 내립니다. 베이스의 스테레오 저역은 모노에서 사라집니다',
                params: { midLowDb: 2.5, midHighDb: 0.5, sideLowDb: -12, sideHighDb: -6 } },
    egtr:     { note: '더블 트랙 기타의 옆 고역만 올려서 벌립니다',
                params: { midLowDb: -1, midHighDb: -1, sideLowDb: -3, sideHighDb: 3.5 } },
    agtr:     { note: '옆 고역을 크게 — 통기타는 넓을수록 좋고 저역은 좁을수록 좋습니다',
                params: { midLowDb: -1.5, midHighDb: 0, sideLowDb: -5, sideHighDb: 4.5 } },
    piano:    { note: '자연 스테레오를 존중합니다. 가운데를 아주 살짝만 정리',
                params: { midLowDb: -1, midHighDb: 0.5, sideLowDb: -2, sideHighDb: 1.5 } },
    strings:  { note: '섹션은 옆이 넓어야 섹션으로 들립니다',
                params: { midLowDb: 0.5, midHighDb: -1.5, sideLowDb: -2.5, sideHighDb: 2.5 } },
    synth:    { note: '옆 저역을 크게 깎습니다. 신스 패드의 저역이 모노를 무너뜨립니다',
                params: { midLowDb: -2, midHighDb: 1, sideLowDb: -9, sideHighDb: 4 } },
  }),

  ...inst('dyneq', {
    drumloop: { note: '350 Hz 가 세게 칠 때만 눌러줍니다. 루프의 박스 울림',
                params: { freqHz: 350, q: 1.4, thresholdDb: -22, rangeDb: -5 } },
    bass:     { note: '90 Hz 저음 노트만 튀는 걸 잡습니다. 고정 EQ 로는 못 하는 일입니다',
                params: { freqHz: 90, q: 1.8, thresholdDb: -18, rangeDb: -6 } },
    egtr:     { note: '900 Hz 헝크가 세게 칠 때만 깎습니다. 늘 깎으면 얇아집니다',
                params: { freqHz: 900, q: 2.2, thresholdDb: -24, rangeDb: -5.5 } },
    agtr:     { note: '200 Hz 붐은 세게 칠 때만 나옵니다. 다이내믹 EQ 가 정답인 대표 사례',
                params: { freqHz: 200, q: 2, thresholdDb: -26, rangeDb: -7 } },
    piano:    { note: '250 Hz 저음 화음에서만 눌러줍니다. 고역은 그대로 둡니다',
                params: { freqHz: 250, q: 1.6, thresholdDb: -24, rangeDb: -4 } },
    strings:  { note: '7.5 kHz 활 소리가 세질 때만. 스트링 디에서라고 봐도 됩니다',
                params: { freqHz: 7500, q: 2.4, thresholdDb: -30, rangeDb: -6 } },
    synth:    { note: '4.5 kHz 톱니 거슬림이 튈 때만 잡습니다',
                params: { freqHz: 4500, q: 2, thresholdDb: -26, rangeDb: -6.5 } },
  }),

  ...inst('exciter', {
    drumloop: { note: '6 kHz 에 살짝. 심벌이 이미 밝으니 많이 넣으면 지저분해집니다',
                params: { amount: 0.3, freqHz: 6000, mix: 0.25 } },
    bass:     { note: '2 kHz 하모닉스를 만들어 작은 스피커에서 들리게 합니다. 베이스에서 제일 쓸모 있는 장치',
                params: { amount: 0.5, freqHz: 2000, mix: 0.35 } },
    egtr:     { note: '4 kHz 프레즌스. 앰프 위쪽은 어차피 비어 있으니 조금만',
                params: { amount: 0.35, freqHz: 4000, mix: 0.22 } },
    agtr:     { note: '9 kHz — 통기타는 여기가 성격입니다. 가장 많이 넣어도 되는 악기',
                params: { amount: 0.55, freqHz: 9000, mix: 0.4 } },
    piano:    { note: '8 kHz 아주 조금. 피아노는 이미 배음이 많습니다',
                params: { amount: 0.25, freqHz: 8000, mix: 0.18 } },
    strings:  { note: '거의 넣지 않습니다 — 스트링에 고역을 더하면 활 소리만 커집니다',
                params: { amount: 0.15, freqHz: 10000, mix: 0.12 } },
    synth:    { note: '3 kHz. 신스는 이미 밝은 경우가 많아 낮은 쪽에 넣습니다',
                params: { amount: 0.3, freqHz: 3000, mix: 0.2 } },
  }),

  // ══ Dynamics ═══════════════════════════════════════════════════════════════

  ...inst('comp', {
    drumloop: { note: '어택 25 ms — 그보다 빠르면 스틱 소리를 먹습니다. 릴리스는 다음 박 전에 풀리게',
                params: { thresholdDb: -18, ratio: 4, kneeDb: 4, attackMs: 25, releaseMs: 90, makeupDb: 4 } },
    bass:     { note: '느린 어택으로 픽을 살리고 긴 릴리스로 서스테인을 고릅니다. 세게 걸어도 되는 악기',
                params: { thresholdDb: -22, ratio: 6, kneeDb: 6, attackMs: 35, releaseMs: 260, makeupDb: 6 } },
    egtr:     { note: '앰프가 이미 압축합니다. 여기서는 정리만',
                params: { thresholdDb: -16, ratio: 3, kneeDb: 8, attackMs: 15, releaseMs: 150, makeupDb: 3 } },
    agtr:     { note: '가볍게 — 통기타를 세게 누르면 플라스틱이 됩니다',
                params: { thresholdDb: -14, ratio: 2.5, kneeDb: 10, attackMs: 20, releaseMs: 180, makeupDb: 2.5 } },
    piano:    { note: '2:1. 피아노는 다이내믹이 연주 자체라 안 거는 것도 정답입니다',
                params: { thresholdDb: -12, ratio: 2, kneeDb: 12, attackMs: 30, releaseMs: 300, makeupDb: 2 } },
    strings:  { note: '활은 수십 ms 에 걸쳐 시작합니다. 어택을 빠르게 해도 잡을 트랜지언트가 없습니다',
                params: { thresholdDb: -15, ratio: 2.5, kneeDb: 12, attackMs: 60, releaseMs: 400, makeupDb: 2.5 } },
    synth:    { note: '신스는 레벨이 이미 일정합니다. 압축은 붙임성을 위한 것이지 레벨을 위한 게 아닙니다',
                params: { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 12, releaseMs: 120, makeupDb: 3.5 } },
  }),

  ...inst('ducker', {
    drumloop: { note: '루프 자체를 덕킹할 일은 드뭅니다. 보컬에 살짝 자리를 내주는 정도',
                params: { thresholdDb: -26, ratio: 3, attackMs: 15, releaseMs: 180, makeupDb: 0 } },
    bass:     { note: '킥에 눌리게 하는 고전적 용법. 릴리스를 템포에 맞추세요',
                params: { thresholdDb: -30, ratio: 8, attackMs: 5, releaseMs: 140, makeupDb: 2 } },
    egtr:     { note: '보컬 들어올 때만 물러납니다. 기타 레이어가 두꺼울 때',
                params: { thresholdDb: -28, ratio: 4, attackMs: 20, releaseMs: 260, makeupDb: 0 } },
    agtr:     { note: '아주 약하게 — 티 나면 실패입니다',
                params: { thresholdDb: -24, ratio: 2.5, attackMs: 25, releaseMs: 300, makeupDb: 0 } },
    piano:    { note: '보컬 구간에서만 살짝 내려갑니다. 피아노 반주의 기본 처리',
                params: { thresholdDb: -26, ratio: 3, attackMs: 30, releaseMs: 350, makeupDb: 0 } },
    strings:  { note: '느리게 들어가고 느리게 나옵니다. 패드성 소스는 급하게 움직이면 들킵니다',
                params: { thresholdDb: -30, ratio: 3.5, attackMs: 60, releaseMs: 500, makeupDb: 0 } },
    synth:    { note: 'EDM 펌핑. 킥마다 크게 눌리고 빠르게 돌아옵니다',
                params: { thresholdDb: -34, ratio: 10, attackMs: 5, releaseMs: 110, makeupDb: 2 } },
  }),

  ...inst('limiter', {
    drumloop: { note: '룩어헤드를 길게 — 드럼 피크는 리미터가 미리 봐야 잡힙니다',
                params: { ceilingDb: -1, lookaheadMs: 5, releaseMs: 60 } },
    bass:     { note: '릴리스를 길게. 짧으면 저음에서 펌핑이 들립니다',
                params: { ceilingDb: -1.5, lookaheadMs: 3, releaseMs: 220 } },
    egtr:     { note: '트랙 안전장치로만. 기타는 이미 압축돼 들어옵니다',
                params: { ceilingDb: -1, lookaheadMs: 2, releaseMs: 100 } },
    agtr:     { note: '피크만 막습니다. 통기타에 리미터가 들리면 너무 건 겁니다',
                params: { ceilingDb: -2, lookaheadMs: 4, releaseMs: 150 } },
    piano:    { note: '−3 dB 로 여유를 크게. 포르티시모만 막는 용도',
                params: { ceilingDb: -3, lookaheadMs: 6, releaseMs: 200 } },
    strings:  { note: '긴 릴리스. 스트링에서 빠른 릴리스는 활 소리를 흔듭니다',
                params: { ceilingDb: -2, lookaheadMs: 5, releaseMs: 300 } },
    synth:    { note: '짧은 릴리스로 밀도를 올립니다. 신스는 펌핑이 잘 안 들립니다',
                params: { ceilingDb: -1, lookaheadMs: 1.5, releaseMs: 45 } },
  }),

  ...inst('gate', {
    drumloop: { note: '루프는 붙어 있는 소리라 얕게만. 레인지를 깊게 주면 리듬이 끊깁니다',
                params: { thresholdDb: -40, rangeDb: 12, attackMs: 1, releaseMs: 120 } },
    bass:     { note: '연주 사이 앰프 험만 잡습니다. 릴리스를 길게 해야 음이 안 잘립니다',
                params: { thresholdDb: -52, rangeDb: 18, attackMs: 3, releaseMs: 400 } },
    egtr:     { note: '하이게인 기타의 노이즈 게이트. 이 악기에서 가장 자주 쓰입니다',
                params: { thresholdDb: -46, rangeDb: 35, attackMs: 1, releaseMs: 180 } },
    agtr:     { note: '거의 쓰지 않습니다 — 통기타의 여운을 자르면 바로 티가 납니다',
                params: { thresholdDb: -60, rangeDb: 8, attackMs: 5, releaseMs: 700 } },
    piano:    { note: '페달 여운이 있으니 아주 낮게, 아주 얕게',
                params: { thresholdDb: -64, rangeDb: 6, attackMs: 10, releaseMs: 900 } },
    strings:  { note: '스트링에 게이트는 대체로 오답입니다. 무대 노이즈만 겨우 잡는 값',
                params: { thresholdDb: -68, rangeDb: 5, attackMs: 20, releaseMs: 1200 } },
    synth:    { note: '리듬 게이트로 씁니다. 깊고 빠르게 — 신스는 잘라도 자연스러움을 잃지 않습니다',
                params: { thresholdDb: -34, rangeDb: 45, attackMs: 1, releaseMs: 60 } },
  }),

  ...inst('mbcomp', {
    drumloop: { note: '저역만 세게 — 킥을 고르고 심벌은 거의 두 손 들고 놔둡니다',
                params: { lowXHz: 140, highXHz: 3500, lowThrDb: -24, lowRatio: 4,
                          midThrDb: -18, midRatio: 2.5, hiThrDb: -14, hiRatio: 2, makeupDb: 3 } },
    bass:     { note: '크로스오버를 낮게 잡고 저역을 강하게. 고역은 손댈 게 없습니다',
                params: { lowXHz: 110, highXHz: 2000, lowThrDb: -28, lowRatio: 6,
                          midThrDb: -22, midRatio: 3.5, hiThrDb: -12, hiRatio: 1.5, makeupDb: 4 } },
    egtr:     { note: '중역 위주. 앰프 대역이 곧 중역입니다',
                params: { lowXHz: 200, highXHz: 3000, lowThrDb: -10, lowRatio: 1.5,
                          midThrDb: -20, midRatio: 3.5, hiThrDb: -16, hiRatio: 2, makeupDb: 2.5 } },
    agtr:     { note: '저역 붐만 눌러주고 나머지는 거의 통과',
                params: { lowXHz: 250, highXHz: 4000, lowThrDb: -26, lowRatio: 3.5,
                          midThrDb: -12, midRatio: 1.8, hiThrDb: -14, hiRatio: 2, makeupDb: 2 } },
    piano:    { note: '세 대역 모두 아주 약하게. 멀티밴드가 피아노를 망치는 건 순식간입니다',
                params: { lowXHz: 180, highXHz: 3000, lowThrDb: -18, lowRatio: 2,
                          midThrDb: -14, midRatio: 1.8, hiThrDb: -12, hiRatio: 1.8, makeupDb: 1.5 } },
    strings:  { note: '고역만 눌러 활 소리를 다스립니다. 사실상 광대역 디에서',
                params: { lowXHz: 160, highXHz: 5000, lowThrDb: -10, lowRatio: 1.5,
                          midThrDb: -12, midRatio: 1.8, hiThrDb: -26, hiRatio: 4, makeupDb: 1.5 } },
    synth:    { note: '저역을 묶어 베이스 자리를 지키고 고역을 조여 밀도를 올립니다',
                params: { lowXHz: 200, highXHz: 3200, lowThrDb: -26, lowRatio: 5,
                          midThrDb: -20, midRatio: 3, hiThrDb: -20, hiRatio: 3, makeupDb: 3.5 } },
  }),

  ...inst('clipper', {
    drumloop: { note: '가장 단단하게 — 드럼 피크를 깎아 리미터 부담을 덜어줍니다',
                params: { driveDb: 4.5, ceilingDb: -1, hardness: 0.8 } },
    bass:     { note: '부드럽게 — 베이스를 하드 클립하면 저역이 지저분해집니다',
                params: { driveDb: 3.5, ceilingDb: -1.5, hardness: 0.4 } },
    egtr:     { note: '앰프의 연장선. 부드럽게 걸면 게인이 늘어난 것처럼 들립니다',
                params: { driveDb: 6, ceilingDb: -1, hardness: 0.5 } },
    agtr:     { note: '피크 안전장치로만. 스트럼 피크는 조금 깎아도 견딥니다',
                params: { driveDb: 2, ceilingDb: -2, hardness: 0.3 } },
    piano:    { note: '여기서 가장 약하게 — 해머 어택을 클립하면 피아노가 뭉갭니다',
                params: { driveDb: 0.8, ceilingDb: -3, hardness: 0.18 } },
    strings:  { note: '스트링에는 사실상 필요 없습니다. 최소값에 가깝게 둡니다',
                params: { driveDb: 0.5, ceilingDb: -2, hardness: 0.12 } },
    synth:    { note: '가장 세게. 신스 리드는 클리핑이 곧 성격이 됩니다',
                params: { driveDb: 7.5, ceilingDb: -1, hardness: 0.7 } },
  }),

  ...inst('transient', {
    drumloop: { note: '어택을 올리고 서스테인을 줄이면 루프가 방에서 나옵니다',
                params: { attack: 0.45, sustain: -0.3, mix: 1 } },
    bass:     { note: '서스테인을 올려 길이를 만듭니다. 어택은 건드리지 않습니다',
                params: { attack: 0.1, sustain: 0.35, mix: 1 } },
    egtr:     { note: '피킹만 살짝 올립니다',
                params: { attack: 0.25, sustain: -0.1, mix: 1 } },
    agtr:     { note: '피크 소리를 살리고 통울림 꼬리를 줄입니다',
                params: { attack: 0.35, sustain: -0.25, mix: 1 } },
    piano:    { note: '해머를 살짝. 피아노는 서스테인이 곧 페달이라 건드리지 않습니다',
                params: { attack: 0.2, sustain: 0, mix: 0.8 } },
    strings:  { note: '어택을 오히려 낮춰 더 부드럽게. 스트링에서 어택을 올리면 거칠어집니다',
                params: { attack: -0.2, sustain: 0.25, mix: 0.7 } },
    synth:    { note: '어택을 올려 엔벨로프에 각을 세웁니다',
                params: { attack: 0.4, sustain: -0.15, mix: 1 } },
  }),

  ...inst('deesser', {
    drumloop: { note: '하이햇이 쏠 때. 8 kHz 에서 가볍게',
                params: { freqHz: 8000, thresholdDb: -22, amount: 0.3 } },
    bass:     { note: '베이스에 디에서는 거의 필요 없습니다. 픽 노이즈용 최소값',
                params: { freqHz: 3000, thresholdDb: -16, amount: 0.15 } },
    egtr:     { note: '픽 어택이 쏠 때 4 kHz 에서',
                params: { freqHz: 4000, thresholdDb: -20, amount: 0.25 } },
    agtr:     { note: '핑거 스퀵과 피크 노이즈. 통기타에서 실제로 쓸모 있습니다',
                params: { freqHz: 6000, thresholdDb: -26, amount: 0.4 } },
    piano:    { note: '5 kHz 해머 노이즈가 거슬릴 때만',
                params: { freqHz: 5000, thresholdDb: -22, amount: 0.22 } },
    strings:  { note: '로진 노이즈를 겨냥합니다. 스트링의 디에서는 7.5 kHz 입니다',
                params: { freqHz: 7500, thresholdDb: -28, amount: 0.45 } },
    synth:    { note: '9 kHz 하이엔드가 쏠 때. 신스는 대역이 넓어 높게 잡습니다',
                params: { freqHz: 9000, thresholdDb: -24, amount: 0.3 } },
  }),

  // ══ Saturation ═════════════════════════════════════════════════════════════

  ...inst('saturation', {
    drumloop: { note: '병렬로 살짝. 루프에 직렬 새츄레이션을 세게 걸면 트랜지언트가 죽습니다',
                params: { driveDb: 6, mix: 0.35, bias: 0 } },
    bass:     { note: '가장 중요한 장치입니다. 하모닉스가 있어야 폰 스피커에서 베이스가 들립니다',
                params: { driveDb: 10, mix: 0.6, bias: 0.15 } },
    egtr:     { note: '앰프 뒤에 또 거는 것이므로 조금만',
                params: { driveDb: 5, mix: 0.4, bias: 0 } },
    agtr:     { note: '아주 약하게. 통기타는 깨끗한 게 성격입니다',
                params: { driveDb: 3.5, mix: 0.24, bias: 0 } },
    piano:    { note: '거의 들리지 않을 만큼. 배음을 더하는 게 아니라 모서리만 둥글립니다',
                params: { driveDb: 2.2, mix: 0.16, bias: 0 } },
    strings:  { note: '여기서 가장 적게. 스트링은 왜곡이 붙으면 바로 싸구려가 됩니다',
                params: { driveDb: 1.2, mix: 0.08, bias: 0 } },
    synth:    { note: '세게 — 디지털 신스에 아날로그 성격을 붙이는 가장 빠른 방법',
                params: { driveDb: 8, mix: 0.5, bias: 0.25 } },
  }),

  ...inst('tube', {
    drumloop: { note: '드라이브는 낮게, 톤은 열어둡니다. 루프의 고역을 죽이지 않기 위해',
                params: { drive: 0.3, bias: 0.12, toneHz: 11000, mix: 45, outDb: -1 } },
    bass:     { note: '바이어스를 올려 짝수 배음을 만듭니다. 베이스가 두꺼워지는 이유가 이것',
                params: { drive: 0.55, bias: 0.3, toneHz: 5000, mix: 75, outDb: -2 } },
    egtr:     { note: '앰프 성격을 더합니다. 톤을 6 kHz 로 닫아 히스를 막습니다',
                params: { drive: 0.45, bias: 0.2, toneHz: 6000, mix: 60, outDb: -1.5 } },
    agtr:     { note: '따뜻하게만. 톤은 활짝 열어둡니다',
                params: { drive: 0.22, bias: 0.1, toneHz: 14000, mix: 35, outDb: -0.5 } },
    piano:    { note: '아주 옅게. 진공관 색이 들리면 피아노가 아닙니다',
                params: { drive: 0.18, bias: 0.08, toneHz: 13000, mix: 28, outDb: -0.5 } },
    strings:  { note: '섹션에 약간의 몸통만. 톤을 닫으면 답답해집니다',
                params: { drive: 0.2, bias: 0.1, toneHz: 12000, mix: 30, outDb: -0.5 } },
    synth:    { note: '드라이브를 크게. 신스에 진공관은 효과가 아니라 필요입니다',
                params: { drive: 0.6, bias: 0.25, toneHz: 9000, mix: 70, outDb: -2 } },
  }),

  ...inst('bitcrush', {
    drumloop: { note: '12비트 — 샘플러 느낌만 냅니다. 낮추면 루프가 부서집니다',
                params: { bits: 12, mix: 45 } },
    bass:     { note: '베이스를 크러시하면 저역이 먼저 사라집니다. 15비트로 흔적만',
                params: { bits: 15, mix: 14 } },
    egtr:     { note: '10비트 로파이 기타. 병렬로 섞습니다',
                params: { bits: 10, mix: 40 } },
    agtr:     { note: '13비트. 로파이 어쿠스틱 루프의 그 바스락거림입니다',
                params: { bits: 13, mix: 22 } },
    piano:    { note: '로파이 피아노. 이 장치가 악기를 통째로 바꾸는 대표 사례',
                params: { bits: 9, mix: 55 } },
    strings:  { note: '사실상 끈 값 — 스트링에 비트 크러시는 활 소리만 거칠게 만듭니다',
                params: { bits: 16, mix: 10 } },
    synth:    { note: '6비트. 신스는 부서질수록 신스다워지는 유일한 악기입니다',
                params: { bits: 6, mix: 70 } },
  }),

  // ══ Modulation ═════════════════════════════════════════════════════════════

  ...inst('chorus', {
    drumloop: { note: '루프 전체에 코러스는 위상을 흔듭니다. 아주 얕게만',
                params: { rateHz: 0.4, depthMs: 1.5, delayMs: 14, mix: 15 } },
    bass:     { note: '저역이 흔들리면 모노에서 사라집니다. 깊이를 최소로',
                params: { rateHz: 0.3, depthMs: 1, delayMs: 12, mix: 12 } },
    egtr:     { note: '80년대 클린 기타. 이 악기가 코러스의 고향입니다',
                params: { rateHz: 0.7, depthMs: 5, delayMs: 20, mix: 45 } },
    agtr:     { note: '12현처럼 들리게 하는 값. 통기타 코러스의 고전적 용법',
                params: { rateHz: 0.5, depthMs: 3.5, delayMs: 16, mix: 30 } },
    piano:    { note: '전자 피아노 느낌. 어쿠스틱 피아노에는 안 어울립니다',
                params: { rateHz: 0.6, depthMs: 2.5, delayMs: 18, mix: 25 } },
    strings:  { note: '느리고 깊게 — 섹션 인원이 늘어난 것처럼 들립니다',
                params: { rateHz: 0.2, depthMs: 6, delayMs: 26, mix: 28 } },
    synth:    { note: '넓고 진하게. 신스 패드의 기본값이라고 봐도 됩니다',
                params: { rateHz: 0.45, depthMs: 7, delayMs: 22, mix: 55 } },
  }),

  ...inst('flanger', {
    drumloop: { note: '루프 전체 플랜징. 피드백을 낮게 잡아야 리듬이 남습니다',
                params: { rateHz: 0.2, depthMs: 1.5, delayMs: 2, feedback: 0.3, mix: 30 } },
    bass:     { note: '피드백 거의 없이. 저역 플랜저는 위상 문제 그 자체입니다',
                params: { rateHz: 0.15, depthMs: 0.8, delayMs: 4, feedback: 0.15, mix: 20 } },
    egtr:     { note: '기타 플랜저의 기본값. 피드백이 성격을 만듭니다',
                params: { rateHz: 0.3, depthMs: 2.5, delayMs: 3, feedback: 0.6, mix: 45 } },
    agtr:     { note: '아주 옅게. 통기타에 플랜저는 대체로 과합니다',
                params: { rateHz: 0.25, depthMs: 1.2, delayMs: 5, feedback: 0.25, mix: 22 } },
    piano:    { note: '느리게 흐르는 정도. 앰비언트 피아노에서 씁니다',
                params: { rateHz: 0.08, depthMs: 2, delayMs: 6, feedback: 0.35, mix: 25 } },
    strings:  { note: '아주 느리게 — 움직이는 게 보이면 안 됩니다',
                params: { rateHz: 0.06, depthMs: 1.5, delayMs: 7, feedback: 0.2, mix: 18 } },
    synth:    { note: '깊고 강한 피드백. 신스에서 플랜저는 악기의 일부가 됩니다',
                params: { rateHz: 0.4, depthMs: 4, delayMs: 2, feedback: 0.75, mix: 55 } },
  }),

  ...inst('phaser', {
    drumloop: { note: '하이햇에 움직임만 줍니다. 중심 주파수를 높게',
                params: { rateHz: 0.5, depth: 0.5, centreHz: 2200, feedback: 0.25, mix: 28 } },
    bass:     { note: '중심을 높게 잡아 저역을 피합니다. 펑크 베이스의 그 소리',
                params: { rateHz: 0.35, depth: 0.6, centreHz: 900, feedback: 0.4, mix: 30 } },
    egtr:     { note: '기타 페이저. 느리게 돌면서 깊게',
                params: { rateHz: 0.25, depth: 0.8, centreHz: 800, feedback: 0.5, mix: 45 } },
    agtr:     { note: '옅게 — 통기타는 페이저가 걸린 게 티 나면 이상합니다',
                params: { rateHz: 0.2, depth: 0.45, centreHz: 1200, feedback: 0.3, mix: 22 } },
    piano:    { note: '전자 피아노의 그 흔들림',
                params: { rateHz: 0.3, depth: 0.6, centreHz: 1000, feedback: 0.35, mix: 30 } },
    strings:  { note: '아주 느리게, 넓게. 패드가 숨쉬는 느낌',
                params: { rateHz: 0.08, depth: 0.7, centreHz: 700, feedback: 0.3, mix: 25 } },
    synth:    { note: '빠르고 깊게, 피드백 크게. 신스 페이저는 감출 이유가 없습니다',
                params: { rateHz: 0.9, depth: 0.9, centreHz: 1400, feedback: 0.7, mix: 55 } },
  }),

  ...inst('tremolo', {
    drumloop: { note: '박에 맞춘 게이팅. 깊이를 크게 주면 리듬 장치가 됩니다',
                params: { rateHz: 8, depth: 0.7, shape: 0.9 } },
    bass:     { note: '느리고 얕게. 베이스 트레몰로는 레벨이 흔들리는 것으로 들립니다',
                params: { rateHz: 3, depth: 0.25, shape: 0 } },
    egtr:     { note: '서프 기타. 이 악기의 고전적 트레몰로',
                params: { rateHz: 5.5, depth: 0.6, shape: 0.2 } },
    agtr:     { note: '아주 얕게 — 통기타에는 흔들림보다 숨결 정도',
                params: { rateHz: 4, depth: 0.32, shape: 0 } },
    piano:    { note: '로즈 피아노의 그 흔들림. 부드러운 사인 파형',
                params: { rateHz: 4.5, depth: 0.45, shape: 0 } },
    strings:  { note: '아주 느리게, 더 얕게. 섹션이 숨쉬는 정도지 떠는 게 아닙니다',
                params: { rateHz: 1.2, depth: 0.2, shape: 0 } },
    synth:    { note: '빠르고 각지게. 신스에서는 게이트 시퀀서처럼 씁니다',
                params: { rateHz: 12, depth: 0.85, shape: 1 } },
  }),

  ...inst('autopan', {
    drumloop: { note: '루프를 패닝하면 킥이 움직입니다. 아주 얕게만',
                params: { rateHz: 0.3, depth: 0.2 } },
    bass:     { note: '베이스는 움직이면 안 됩니다. 사실상 끈 값',
                params: { rateHz: 0.1, depth: 0.05 } },
    egtr:     { note: '느리게 좌우로. 더블 트랙이 아닐 때 폭을 만듭니다',
                params: { rateHz: 0.25, depth: 0.55 } },
    agtr:     { note: '아주 느리게, 절반 폭으로',
                params: { rateHz: 0.15, depth: 0.4 } },
    piano:    { note: '피아노는 이미 스테레오입니다. 거의 움직이지 않게',
                params: { rateHz: 0.12, depth: 0.15 } },
    strings:  { note: '느리게 크게 — 섹션이 방 안에서 움직이는 느낌',
                params: { rateHz: 0.08, depth: 0.5 } },
    synth:    { note: '빠르고 넓게. 아르페지오가 좌우로 튀게 됩니다',
                params: { rateHz: 1.2, depth: 0.85 } },
  }),

  // ══ Delay ══════════════════════════════════════════════════════════════════

  ...inst('delay', {
    drumloop: { note: '8분음표 슬랩. 피드백을 낮게 해야 그루브가 안 흐려집니다',
                params: { timeMs: 250, feedback: 0.18, mix: 0.16 } },
    bass:     { note: '베이스에 딜레이는 저역을 겹칩니다. 짧고 거의 안 들리게',
                params: { timeMs: 120, feedback: 0.1, mix: 0.1 } },
    egtr:     { note: '슬랩백 120 ms. 로카빌리부터 지금까지 안 바뀐 값',
                params: { timeMs: 120, feedback: 0.22, mix: 0.24 } },
    agtr:     { note: '점8분음표. 아르페지오가 자기 자신과 엮입니다',
                params: { timeMs: 375, feedback: 0.3, mix: 0.2 } },
    piano:    { note: '길고 옅게. 피아노 딜레이는 방처럼 들려야 합니다',
                params: { timeMs: 500, feedback: 0.25, mix: 0.15 } },
    strings:  { note: '아주 길고 아주 옅게. 꼬리를 늘리는 용도',
                params: { timeMs: 700, feedback: 0.35, mix: 0.14 } },
    synth:    { note: '피드백을 크게 — 신스 딜레이는 반복 자체가 파트가 됩니다',
                params: { timeMs: 375, feedback: 0.55, mix: 0.32 } },
  }),

  ...inst('pingpong', {
    drumloop: { note: '탑라인만 좌우로 튀게. 톤을 닫아 킥이 따라가지 않게 합니다',
                params: { timeMs: 250, feedback: 0.25, toneHz: 4000, mix: 18 } },
    bass:     { note: '핑퐁은 베이스에 쓰지 않는 게 맞습니다. 흔적만 남긴 값',
                params: { timeMs: 180, feedback: 0.12, toneHz: 1500, mix: 8 } },
    egtr:     { note: '리드 기타를 좌우로 벌립니다',
                params: { timeMs: 375, feedback: 0.35, toneHz: 5000, mix: 28 } },
    agtr:     { note: '아르페지오가 좌우로 흐릅니다. 톤은 밝게 열어둡니다',
                params: { timeMs: 333, feedback: 0.3, toneHz: 8000, mix: 24 } },
    piano:    { note: '넓고 옅게. 피드백을 낮춰 화음이 뭉치지 않게',
                params: { timeMs: 500, feedback: 0.28, toneHz: 7000, mix: 20 } },
    strings:  { note: '아주 길게. 홀 뒤에서 되돌아오는 소리처럼',
                params: { timeMs: 750, feedback: 0.4, toneHz: 5000, mix: 18 } },
    synth:    { note: '빠르고 강하게. 신스 아르페지오와 핑퐁은 한 세트입니다',
                params: { timeMs: 187, feedback: 0.55, toneHz: 9000, mix: 35 } },
  }),

  ...inst('tapedelay', {
    drumloop: { note: '와우를 낮게 — 테이프 흔들림이 드럼에서는 박자가 밀린 것처럼 들립니다',
                params: { timeMs: 250, feedback: 0.2, toneHz: 4000, wowMs: 0.2, drive: 0.2, mix: 15 } },
    bass:     { note: '거의 안 씁니다. 드라이브만 조금 빌려 쓰는 값',
                params: { timeMs: 160, feedback: 0.12, toneHz: 2000, wowMs: 0.1, drive: 0.35, mix: 10 } },
    egtr:     { note: '테이프 에코. 어두운 톤과 드라이브가 이 장치의 전부입니다',
                params: { timeMs: 300, feedback: 0.4, toneHz: 3000, wowMs: 0.8, drive: 0.45, mix: 28 } },
    agtr:     { note: '따뜻하게 한 번만 되돌아옵니다',
                params: { timeMs: 375, feedback: 0.25, toneHz: 4500, wowMs: 0.5, drive: 0.25, mix: 20 } },
    piano:    { note: '길고 어둡게. 반복이 화음이 아니라 공간으로 들리게',
                params: { timeMs: 550, feedback: 0.3, toneHz: 3000, wowMs: 0.6, drive: 0.2, mix: 18 } },
    strings:  { note: '아주 길고 어둡게. 와우를 크게 줘도 스트링은 견딥니다',
                params: { timeMs: 800, feedback: 0.42, toneHz: 2500, wowMs: 1.2, drive: 0.15, mix: 16 } },
    synth:    { note: '피드백을 거의 발진 직전까지. 테이프 딜레이의 그 자기발진',
                params: { timeMs: 400, feedback: 0.7, toneHz: 5000, wowMs: 1, drive: 0.5, mix: 35 } },
  }),

  // ══ Reverb ═════════════════════════════════════════════════════════════════

  ...inst('reverb', {
    drumloop: { note: '짧은 방. 드럼 리버브는 길면 그루브를 지웁니다',
                params: { decaySec: 0.9, mix: 0.14, preDelayMs: 10 } },
    bass:     { note: '베이스에 리버브는 저역을 흐립니다. 거의 드라이',
                params: { decaySec: 0.6, mix: 0.06, preDelayMs: 0 } },
    egtr:     { note: '중간 길이. 프리딜레이를 줘서 피킹이 앞에 남게 합니다',
                params: { decaySec: 1.6, mix: 0.2, preDelayMs: 25 } },
    agtr:     { note: '일렉보다 짧게. 통기타는 리버브가 많으면 바로 아마추어처럼 들립니다',
                params: { decaySec: 1.1, mix: 0.16, preDelayMs: 18 } },
    piano:    { note: '홀 쪽으로. 피아노는 원래 큰 방에 있는 악기입니다',
                params: { decaySec: 2.4, mix: 0.26, preDelayMs: 30 } },
    strings:  { note: '가장 깁니다. 스트링에 긴 홀은 효과가 아니라 기본입니다',
                params: { decaySec: 3.4, mix: 0.34, preDelayMs: 40 } },
    synth:    { note: '길고 많이. 신스는 공간이 곧 사운드 디자인입니다',
                params: { decaySec: 3, mix: 0.38, preDelayMs: 18 } },
  }),

  ...inst('spacereverb', {
    drumloop: { note: '드럼 룸. 짧고 어둡게, 초기 반사 위주로 — 꼬리는 눌러둡니다',
                params: { space: S('room-drum'), sizePct: 90, decayPct: 65, preDelayMs: 8,
                          dampingPct: 130, erDb: 2, tailDb: -6, lowCutHz: 180,
                          highCutHz: 8000, widthPct: 105, mixPct: 16 } },
    bass:     { note: '부스에 가깝게, 저역을 크게 잘라냅니다. 베이스가 흐려지면 실패입니다',
                params: { space: S('room-booth'), sizePct: 60, decayPct: 45, preDelayMs: 0,
                          dampingPct: 150, erDb: 0, tailDb: -10, lowCutHz: 400,
                          highCutHz: 4000, widthPct: 60, mixPct: 7 } },
    egtr:     { note: '나무 방. 앰프가 있던 공간을 흉내냅니다',
                params: { space: S('room-wood'), sizePct: 100, decayPct: 90, preDelayMs: 18,
                          dampingPct: 110, erDb: 1, tailDb: -2, lowCutHz: 200,
                          highCutHz: 7000, widthPct: 110, mixPct: 20 } },
    agtr:     { note: '스튜디오 룸에 공기만. 하이컷을 높게 열어 피크 소리를 남깁니다',
                params: { space: S('room-studio'), sizePct: 110, decayPct: 95, preDelayMs: 22,
                          dampingPct: 90, erDb: 1, tailDb: -1, lowCutHz: 260,
                          highCutHz: 13000, widthPct: 120, mixPct: 22 } },
    piano:    { note: '리사이틀 홀. 피아노에 맞춰 만들어진 공간입니다',
                params: { space: S('hall-recital'), sizePct: 120, decayPct: 110, preDelayMs: 28,
                          dampingPct: 85, erDb: 0, tailDb: 0, lowCutHz: 140,
                          highCutHz: 12000, widthPct: 120, mixPct: 26 } },
    strings:  { note: '스코어링 스테이지. 스트링 섹션이 실제로 녹음되는 곳',
                params: { space: S('hall-scoring'), sizePct: 140, decayPct: 130, preDelayMs: 35,
                          dampingPct: 75, erDb: -2, tailDb: 2, lowCutHz: 110,
                          highCutHz: 10000, widthPct: 135, mixPct: 32 } },
    synth:    { note: '넓은 앰비언스. 초기 반사를 죽이고 꼬리만 남깁니다',
                params: { space: S('amb-wide'), sizePct: 150, decayPct: 160, preDelayMs: 12,
                          dampingPct: 70, erDb: -8, tailDb: 3, lowCutHz: 220,
                          highCutHz: 11000, widthPct: 145, mixPct: 38 } },
  }),

  ...inst('plate', {
    drumloop: { note: '짧은 플레이트. 스네어에 몸을 붙이는 고전적 방법입니다',
                params: { decaySec: 1.2, preDelayMs: 8, dampHz: 6000, diffusion: 0.8,
                          lowCutHz: 250, highCutHz: 11000, widthPct: 105, mixPct: 14 } },
    bass:     { note: '플레이트는 베이스에 맞지 않습니다. 최소한으로만',
                params: { decaySec: 0.8, preDelayMs: 0, dampHz: 2500, diffusion: 0.6,
                          lowCutHz: 500, highCutHz: 4000, widthPct: 50, mixPct: 6 } },
    egtr:     { note: '중간 길이 플레이트. 스프링과 달리 색이 없어 리드에 잘 붙습니다',
                params: { decaySec: 2, preDelayMs: 20, dampHz: 6500, diffusion: 0.72,
                          lowCutHz: 220, highCutHz: 9000, widthPct: 115, mixPct: 22 } },
    agtr:     { note: '통기타에는 스프링이 아니라 플레이트입니다. 밝고 깨끗하게',
                params: { decaySec: 1.8, preDelayMs: 24, dampHz: 9000, diffusion: 0.75,
                          lowCutHz: 260, highCutHz: 14000, widthPct: 125, mixPct: 24 } },
    piano:    { note: '길고 부드럽게. 확산을 높여 화음이 뭉치지 않게 합니다',
                params: { decaySec: 3, preDelayMs: 26, dampHz: 8000, diffusion: 0.88,
                          lowCutHz: 180, highCutHz: 13000, widthPct: 120, mixPct: 26 } },
    strings:  { note: '가장 길게. 플레이트는 초기 반사가 없어서 섹션이 가까우면서 거대해집니다',
                params: { decaySec: 4.5, preDelayMs: 32, dampHz: 7000, diffusion: 0.9,
                          lowCutHz: 150, highCutHz: 11000, widthPct: 135, mixPct: 32 } },
    synth:    { note: '길고 넓게, 많이. 신스 패드에 플레이트를 깊게 거는 건 흔한 정답입니다',
                params: { decaySec: 5, preDelayMs: 14, dampHz: 7500, diffusion: 0.85,
                          lowCutHz: 240, highCutHz: 12000, widthPct: 140, mixPct: 40 } },
  }),

  ...inst('spring', {
    drumloop: { note: '짧게. 스프링의 보잉이 드럼에서는 스프링이 튕기는 소리로 들킵니다',
                params: { decaySec: 0.9, toneHz: 1800, dampHz: 5000, boing: 0.3, mixPct: 12 } },
    bass:     { note: '스프링은 베이스와 상극입니다. 톤을 높여 저역을 피한 최소값',
                params: { decaySec: 0.7, toneHz: 2200, dampHz: 3000, boing: 0.2, mixPct: 8 } },
    egtr:     { note: '이 장치가 존재하는 이유입니다. 보잉을 크게 열어둡니다',
                params: { decaySec: 2.4, toneHz: 1200, dampHz: 4200, boing: 0.72, mixPct: 30 } },
    agtr:     { note: '통기타에 스프링은 대체로 오답이지만, 아주 옅으면 성격이 됩니다',
                params: { decaySec: 1.4, toneHz: 1600, dampHz: 6000, boing: 0.35, mixPct: 14 } },
    piano:    { note: '로파이 피아노용. 어쿠스틱 피아노에는 어울리지 않습니다',
                params: { decaySec: 1.8, toneHz: 1000, dampHz: 3500, boing: 0.45, mixPct: 18 } },
    strings:  { note: '거의 쓰지 않습니다. 톤을 높여 몸통을 피합니다',
                params: { decaySec: 2, toneHz: 2000, dampHz: 4500, boing: 0.25, mixPct: 12 } },
    synth:    { note: '보잉을 크게 — 신스에 스프링은 빈티지 장비 느낌을 만듭니다',
                params: { decaySec: 2.8, toneHz: 900, dampHz: 5500, boing: 0.65, mixPct: 28 } },
  }),

  ...inst('shimmer', {
    drumloop: { note: '드럼에 시머는 거의 안 씁니다. 심벌 꼬리에만 아주 옅게',
                params: { space: S('amb-wide'), decayPct: 90, shimmer: 0.2, loopMs: 140,
                          preDelayMs: 20, lowCutHz: 400, highCutHz: 10000,
                          widthPct: 110, mixPct: 10 } },
    bass:     { note: '옥타브 위로 올리면 베이스가 아니게 됩니다. 사실상 끈 값',
                params: { space: S('room-studio'), decayPct: 60, shimmer: 0.12, loopMs: 100,
                          preDelayMs: 0, lowCutHz: 600, highCutHz: 6000,
                          widthPct: 60, mixPct: 6 } },
    egtr:     { note: '앰비언트 기타. 시머가 파트를 만들어주는 대표 사례',
                params: { space: S('hall-concert'), decayPct: 150, shimmer: 0.55, loopMs: 200,
                          preDelayMs: 40, lowCutHz: 220, highCutHz: 10000,
                          widthPct: 125, mixPct: 35 } },
    agtr:     { note: '아르페지오 위에 옅게. 통기타는 이미 배음이 많아 조금만',
                params: { space: S('hall-recital'), decayPct: 120, shimmer: 0.35, loopMs: 180,
                          preDelayMs: 35, lowCutHz: 280, highCutHz: 13000,
                          widthPct: 120, mixPct: 24 } },
    piano:    { note: '길게, 옥타브를 옅게. 피아노 위의 시머는 금방 과해집니다',
                params: { space: S('hall-symphony'), decayPct: 170, shimmer: 0.3, loopMs: 220,
                          preDelayMs: 45, lowCutHz: 200, highCutHz: 12000,
                          widthPct: 125, mixPct: 26 } },
    strings:  { note: '아주 길게. 섹션 위 옥타브가 또 하나의 섹션처럼 들립니다',
                params: { space: S('hall-cathedral'), decayPct: 200, shimmer: 0.45, loopMs: 260,
                          preDelayMs: 50, lowCutHz: 160, highCutHz: 10000,
                          widthPct: 140, mixPct: 32 } },
    synth:    { note: '최대에 가깝게. 신스 패드와 시머는 사실상 한 악기입니다',
                params: { space: S('spec-infinite'), decayPct: 240, shimmer: 0.7, loopMs: 300,
                          preDelayMs: 25, lowCutHz: 240, highCutHz: 11000,
                          widthPct: 145, mixPct: 45 } },
  }),

  // ══ Imaging ════════════════════════════════════════════════════════════════

  ...inst('widener', {
    drumloop: { note: '오버헤드를 벌리되 킥은 가운데 묶습니다',
                params: { width: 1.25, lowMonoHz: 140 } },
    bass:     { note: '폭 1.0 — 베이스는 넓히지 않습니다. 모노 지점을 높게 잡습니다',
                params: { width: 1, lowMonoHz: 300 } },
    egtr:     { note: '더블 트랙이 아닐 때 폭을 만듭니다',
                params: { width: 1.35, lowMonoHz: 160 } },
    agtr:     { note: '넓게. 통기타는 폭이 넓을수록 좋아지는 몇 안 되는 악기입니다',
                params: { width: 1.45, lowMonoHz: 180 } },
    piano:    { note: '자연 스테레오를 조금만 도와줍니다',
                params: { width: 1.15, lowMonoHz: 120 } },
    strings:  { note: '섹션은 넓어야 섹션입니다',
                params: { width: 1.5, lowMonoHz: 110 } },
    synth:    { note: '가장 넓게, 그러나 저역은 크게 묶습니다. 넓은 신스 저역이 모노를 무너뜨립니다',
                params: { width: 1.7, lowMonoHz: 260 } },
  }),

  ...inst('monomaker', {
    drumloop: { note: '킥 대역을 모노로. 오버헤드는 그대로 둡니다',
                params: { freqHz: 130, widthPct: 115 } },
    bass:     { note: '300 Hz 아래 전부 모노. 베이스에서 이건 취향이 아니라 규칙입니다',
                params: { freqHz: 300, widthPct: 100 } },
    egtr:     { note: '앰프 저역만 모아줍니다',
                params: { freqHz: 150, widthPct: 120 } },
    agtr:     { note: '통울림만 모노로, 위는 넓게',
                params: { freqHz: 170, widthPct: 135 } },
    piano:    { note: '낮게 — 피아노 저역의 자연 스테레오를 너무 뺏지 않습니다',
                params: { freqHz: 100, widthPct: 108 } },
    strings:  { note: '첼로·콘트라베이스 대역을 모아 섹션 중심을 잡습니다',
                params: { freqHz: 120, widthPct: 140 } },
    synth:    { note: '가장 높게 — 신스 서브는 반드시 모노여야 합니다',
                params: { freqHz: 260, widthPct: 155 } },
  }),

  ...inst('haas', {
    drumloop: { note: '루프에 하스는 위상을 망칩니다. 아주 짧게, 아주 약하게',
                params: { delayMs: 6, amount: 0.2 } },
    bass:     { note: '베이스에는 쓰지 않습니다. 흔적만 남긴 값',
                params: { delayMs: 3, amount: 0.1 } },
    egtr:     { note: '한 번 친 기타를 더블처럼 만듭니다. 하스가 제일 잘 먹히는 악기',
                params: { delayMs: 18, amount: 0.6 } },
    agtr:     { note: '넓게 — 통기타 한 트랙을 스테레오처럼 벌립니다',
                params: { delayMs: 22, amount: 0.65 } },
    piano:    { note: '이미 스테레오라 거의 필요 없습니다',
                params: { delayMs: 8, amount: 0.25 } },
    strings:  { note: '중간 정도. 섹션 폭을 조금 더 벌립니다',
                params: { delayMs: 16, amount: 0.45 } },
    synth:    { note: '가장 길게. 모노 신스를 넓히는 가장 싼 방법입니다',
                params: { delayMs: 28, amount: 0.7 } },
  }),

  // ══ Restore · Pitch ════════════════════════════════════════════════════════

  ...inst('denoise', {
    drumloop: { note: '루프에는 잔향이 노이즈처럼 보입니다. 아주 약하게',
                params: { thresholdDb: -58, amount: 0.2, releaseMs: 80 } },
    bass:     { note: '앰프 히스를 낮은 문턱에서. 릴리스를 길게 해야 저음이 안 잘립니다',
                params: { thresholdDb: -54, amount: 0.35, releaseMs: 260 } },
    egtr:     { note: '하이게인 앰프 노이즈. 이 악기에서 가장 자주 필요합니다',
                params: { thresholdDb: -48, amount: 0.5, releaseMs: 150 } },
    agtr:     { note: '룸 노이즈만. 세게 걸면 통기타 고역이 같이 사라집니다',
                params: { thresholdDb: -60, amount: 0.28, releaseMs: 200 } },
    piano:    { note: '페달 노이즈와 룸 톤. 약하게, 길게',
                params: { thresholdDb: -62, amount: 0.25, releaseMs: 300 } },
    strings:  { note: '가장 약하게 — 스트링에서 디노이즈는 활 소리를 먼저 지웁니다',
                params: { thresholdDb: -66, amount: 0.18, releaseMs: 350 } },
    synth:    { note: '신스는 노이즈가 없습니다. 샘플 소스용 최소값',
                params: { thresholdDb: -70, amount: 0.12, releaseMs: 120 } },
  }),

  ...inst('hum', {
    drumloop: { note: '루프에 험이 있는 경우는 드뭅니다. 기본 배음만',
                params: { baseHz: 60, harmonics: 3, q: 28 } },
    bass:     { note: '베이스 앰프 험. 저역 배음이 실제로 겹치므로 Q 를 좁게',
                params: { baseHz: 60, harmonics: 5, q: 38 } },
    egtr:     { note: '싱글코일 험. 이 악기가 이 장치의 주 고객입니다 — 배음을 많이',
                params: { baseHz: 60, harmonics: 8, q: 46 } },
    agtr:     { note: '픽업 통기타의 험. 중간 정도',
                params: { baseHz: 60, harmonics: 4, q: 34 } },
    piano:    { note: '마이크 라인 험만. 배음은 적게, Q 는 넓지 않게',
                params: { baseHz: 60, harmonics: 2, q: 42 } },
    strings:  { note: '기본파 하나만, Q 를 가장 좁게 — 스트링 몸통을 건드리면 안 됩니다',
                params: { baseHz: 60, harmonics: 1, q: 54 } },
    synth:    { note: '아날로그 신스의 전원 험. 하드웨어를 녹음했을 때만',
                params: { baseHz: 60, harmonics: 6, q: 50 } },
  }),

  ...inst('pitchcorrect', {
    drumloop: { note: '드럼에 피치 보정은 의미가 없습니다. 사실상 끈 값',
                params: { amount: 0.05, formant: 0 } },
    bass:     { note: '베이스 인토네이션을 약하게 잡습니다. 세게 걸면 음이 계단처럼 됩니다',
                params: { amount: 0.35, formant: 0 } },
    egtr:     { note: '벤딩을 지우면 안 되므로 약하게',
                params: { amount: 0.25, formant: 0 } },
    agtr:     { note: '튜닝이 살짝 어긋난 통기타를 부드럽게 당깁니다. 여기서 가장 세게',
                params: { amount: 0.45, formant: 0 } },
    piano:    { note: '피아노는 조율된 악기입니다. 보정할 것이 거의 없습니다',
                params: { amount: 0.12, formant: 0 } },
    strings:  { note: '비브라토를 죽이지 않도록 아주 약하게',
                params: { amount: 0.18, formant: 0 } },
    synth:    { note: '신스 자체는 정확합니다. 샘플 소스를 붙일 때를 위해 가장 높게',
                params: { amount: 0.55, formant: 0 } },
  }),
];
