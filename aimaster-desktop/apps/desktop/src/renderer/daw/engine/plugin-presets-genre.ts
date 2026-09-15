// Genre starting points.
//
// The factory presets in `plugin-presets.ts` are organised by SOURCE — you have
// a snare, you pick the snare preset.  These are organised by RECORD: you know
// what the song is supposed to sound like before you know what is on track 7,
// and a genre carries a whole set of decisions with it.  A 재즈 compressor and
// a K-POP compressor are not the same device set differently by taste; they are
// answers to different questions about how much of the performance survives.
//
// ── What a genre profile is ──────────────────────────────────────────────────
//
// Every genre below is one paragraph of production practice turned into numbers
// that every device has to agree with.  The point of writing them down is that
// they can be argued with: if you think 힙합 does not sit at −9.5 LUFS, that is
// a claim about a number in a table, not about taste.
//
//   재즈       −16 LUFS.  The least-processed music here.  Wide dynamics kept on
//              purpose; compression is glue, not level.  Upright bass lives at
//              60–100 Hz so the high-pass stays low.  Brushes and ride need air
//              at 8–12 kHz.  Room, never hall — the band is in a place.
//
//   로파이      −14 LUFS, and degraded deliberately.  Low-passed around
//              8–10 kHz so there is no air at all, the 200–500 Hz box KEPT
//              rather than carved, bit depth and tape wow audible, no deep sub.
//              Everything a mix engineer removes, this genre puts back.
//
//   앰비언트     −17 LUFS.  Long tails (4–8 s), high wet mix, very wide, slow
//              everything.  Transients are the enemy; the sound has no front
//              edge.  Sub is kept because there is room for it.
//
//   클래식      −20 LUFS.  Effectively no processing: 1.2:1 if anything, a real
//              hall at 2–2.6 s, flat EQ, no width manipulation, no saturation.
//              The dynamic range IS the recording.  Presets here look almost
//              like the device defaults and that is the correct answer.
//
//   K-POP      −8.5 LUFS.  Very bright (a big shelf at 8–14 kHz), low end tight
//              and mono under ~120 Hz, hard fast limiting, and heavy de-essing
//              because stacked vocal layers multiply sibilance.  Vocal presence
//              at 3–5 kHz is the centre of the record.
//
//   팝         −10.5 LUFS.  K-POP's decisions with the extremes taken off: bright
//              but not harsh, vocal-forward, plate on the voice, moderate
//              compression.  The safe middle of the ten.
//
//   EDM        −8 LUFS.  Sub is the instrument: big, and mono under ~130 Hz.
//              The sidechain pump against the kick is structural, not an
//              effect.  Fast release everywhere, very wide highs, hard clipping
//              before the limiter.
//
//   힙합        −9.5 LUFS.  The 808 sits at 30–60 Hz, lower than any other genre
//              here, and it must be mono.  Warmth at 100–200 Hz is kept.  Space
//              is a slap, not a tail — the vocal stays in your face.  Hats are
//              bright at 8–14 kHz.
//
//   R&B        −11.5 LUFS.  Warm rather than bright: less 3–5 kHz than 팝, more
//              200–400 Hz.  Slow compressor attacks so the voice keeps its
//              shape.  Lush plate on the lead, wide backing vocals, rounded sub.
//
//   J-POP      −9 LUFS.  As loud as K-POP and denser: busy arrangements mean
//              mid-forward carving rather than a scoop, very fast compression,
//              a lot of high sheen, and narrower low-mids so the parts fit.
//
// ── What is NOT here ─────────────────────────────────────────────────────────
//
// Four devices have no genre presets, because a genre cannot change what they
// do and a preset that pretends otherwise is the thing this project keeps
// deleting:
//
//   dcblock  has no parameters at all.
//   phase    is invert / swap / mono — a wiring decision, not a sound.
//   trim     is one gain in dB; a "genre gain" would be a number made up.
//   dither   is bit depth and TPDF amount, decided by the delivery format.
//
// Every other device in the registry has ten, one per genre, and no two of
// them are the same map — `scripts/genre-presets-selftest.ts` fails if they are.

import { spaceIndex } from './reverb-spaces.js';
import type { PluginPreset } from './plugin-presets.js';

const S = spaceIndex;

export type GenreId =
  | 'jazz' | 'lofi' | 'ambient' | 'classic' | 'kpop'
  | 'pop' | 'edm' | 'hiphop' | 'rnb' | 'jpop';

/** The order the ten appear in every device's menu. */
export const GENRE_ORDER: readonly GenreId[] = [
  'jazz', 'lofi', 'ambient', 'classic', 'kpop', 'pop', 'edm', 'hiphop', 'rnb', 'jpop',
];

export const GENRE_LABEL: Record<GenreId, string> = {
  jazz: '재즈', lofi: '로파이', ambient: '앰비언트', classic: '클래식', kpop: 'K-POP',
  pop: '팝', edm: 'EDM', hiphop: '힙합', rnb: 'R&B', jpop: 'J-POP',
};

/** Integrated loudness each genre is aiming at, in LUFS.  Used by the meter
 *  preset and asserted against by the self-test, so the profile above and the
 *  numbers below cannot drift apart. */
export const GENRE_TARGET_LUFS: Record<GenreId, number> = {
  jazz: -16, lofi: -14, ambient: -17, classic: -20, kpop: -8.5,
  pop: -10.5, edm: -8, hiphop: -9.5, rnb: -11.5, jpop: -9,
};

/** The group these appear under in every plugin window. */
export const GENRE_GROUP = '장르';

/**
 * Pull the genre group out of a device's preset groups.
 *
 * The window draws these as a row of ten chips rather than leaving them in the
 * dropdown.  A dropdown is the right control for "one of an open-ended list I
 * mostly do not know" — the source presets, and whatever the user has saved.
 * The genres are the opposite: a closed set of ten, the same ten on every
 * device, that you already know the name of before you open the menu.  Making
 * someone open a list and scroll past 27 reverb rooms to find 힙합 is the
 * dropdown being used for the one job it is worst at.
 *
 * Returns them separately so the caller can draw each with the control that
 * fits, and so the dropdown does not list the same ten twice.
 */
export function partitionGenre(
  groups: ReadonlyArray<{ group: string; presets: PluginPreset[] }>,
): { genre: PluginPreset[]; rest: Array<{ group: string; presets: PluginPreset[] }> } {
  const found = groups.find((g) => g.group === GENRE_GROUP);
  return {
    // In GENRE_ORDER, not in whatever order they happen to be stored, so the
    // chips read the same way on every device.
    genre: GENRE_ORDER
      .map((id) => found?.presets.find((p) => p.name === GENRE_LABEL[id]))
      .filter((p): p is PluginPreset => p !== undefined),
    rest: groups.filter((g) => g.group !== GENRE_GROUP),
  };
}

interface GenreEntry { note: string; params: Record<string, number> }

/**
 * Ten presets for one device.
 *
 * The `Record<GenreId, …>` is doing real work: leaving a genre out is a type
 * error, so "I did nine and got bored" cannot reach the repository.
 */
function genrePresets(
  pluginId: string, entries: Record<GenreId, GenreEntry>,
): PluginPreset[] {
  return GENRE_ORDER.map((genre) => ({
    id: `genre-${pluginId}-${genre}`,
    pluginId,
    name: GENRE_LABEL[genre],
    group: GENRE_GROUP,
    note: entries[genre].note,
    params: entries[genre].params,
  }));
}

export const GENRE_PRESETS: readonly PluginPreset[] = [

  // ══ EQ ═════════════════════════════════════════════════════════════════════

  ...genrePresets('eq3', {
    jazz:    { note: '하이패스를 28 Hz 까지만 — 콘트라베이스 몸통이 그 위에 있습니다',
               params: { hpfHz: 28, lowDb: 1, midDb: -1.5, midHz: 450, highDb: 2 } },
    lofi:    { note: '8 kHz 위를 버리고 400 Hz 박스는 그대로 둡니다. 일부러 탁하게',
               params: { hpfHz: 90, lowDb: 2.5, midDb: 2, midHz: 320, highDb: -6 } },
    ambient: { note: '900 Hz 를 −4 dB. 패드가 몇 겹이든 가운데가 비어 있어야 합니다',
               params: { hpfHz: 45, lowDb: 1.5, midDb: -4, midHz: 900, highDb: 2 } },
    classic: { note: '거의 아무것도 하지 않습니다 — 클래식에서 EQ 는 대체로 오답입니다',
               params: { hpfHz: 24, lowDb: 0, midDb: 0, midHz: 1000, highDb: 0.5 } },
    kpop:    { note: '8 kHz 위를 +5 dB 올리고 400 Hz 를 깎습니다. 보컬 자리 만들기',
               params: { hpfHz: 60, lowDb: -1, midDb: -2, midHz: 400, highDb: 5 } },
    pop:     { note: 'K-POP 에서 끝을 덜어낸 것. 밝지만 쏘지 않습니다',
               params: { hpfHz: 52, lowDb: 0, midDb: -1.5, midHz: 380, highDb: 3 } },
    edm:     { note: '서브를 살리려고 하이패스를 28 Hz 로 낮추고 중역을 파냅니다',
               params: { hpfHz: 28, lowDb: 2, midDb: -3, midHz: 500, highDb: 4 } },
    hiphop:  { note: '808 자리를 크게 열어둡니다. 저역이 이 장르의 주인공입니다',
               params: { hpfHz: 26, lowDb: 3.5, midDb: -1, midHz: 600, highDb: 2.5 } },
    rnb:     { note: '260 Hz 를 올려서 따뜻하게. 팝보다 덜 밝은 것이 맞습니다',
               params: { hpfHz: 38, lowDb: 2, midDb: 1, midHz: 260, highDb: 1.5 } },
    jpop:    { note: '1.6 kHz 를 올려 앞으로 냅니다. 편곡이 빽빽할 때 쓰는 방식',
               params: { hpfHz: 70, lowDb: -1.5, midDb: 1.5, midHz: 1600, highDb: 4 } },
  }),

  ...genrePresets('eq8', {
    jazz:    { note: '2.2 kHz 관악기 존재감, 9 kHz 브러시 공기. 나머지는 건드리지 않습니다',
               params: { hpfHz: 30, lowDb: 1, lowHz: 90, b1Db: -1.5, b1Hz: 320, b1Q: 1.1,
                         b2Db: 0.8, b2Hz: 2200, b2Q: 0.9, b3Db: 1.2, b3Hz: 9000, b3Q: 0.8,
                         highDb: 1, highHz: 12000, lpfHz: 20000 } },
    lofi:    { note: '9.5 kHz 로 잘라냅니다. 380 Hz 박스는 오히려 올립니다',
               params: { hpfHz: 110, lowDb: 2.5, lowHz: 140, b1Db: 2, b1Hz: 380, b1Q: 1.3,
                         b2Db: -2, b2Hz: 2600, b2Q: 1.6, b3Db: -4, b3Hz: 7000, b3Q: 0.9,
                         highDb: -7, highHz: 9000, lpfHz: 9500 } },
    ambient: { note: '500 Hz 와 1.6 kHz 를 둘 다 덜어내 꼬리가 쌓여도 탁해지지 않게',
               params: { hpfHz: 40, lowDb: 1.5, lowHz: 70, b1Db: -2.5, b1Hz: 500, b1Q: 1,
                         b2Db: -1.5, b2Hz: 1600, b2Q: 0.8, b3Db: 1.5, b3Hz: 6500, b3Q: 0.6,
                         highDb: 2.5, highHz: 11000, lpfHz: 19000 } },
    classic: { note: '전 대역 ±0.5 dB 안쪽. 홀이 이미 답을 냈습니다',
               params: { hpfHz: 24, lowDb: 0, lowHz: 100, b1Db: -0.5, b1Hz: 300, b1Q: 0.8,
                         b2Db: 0, b2Hz: 1200, b2Q: 1, b3Db: 0.5, b3Hz: 8000, b3Q: 0.6,
                         highDb: 0.5, highHz: 12000, lpfHz: 20000 } },
    kpop:    { note: '3.6 kHz 보컬 존재감 + 11 kHz 셸프. 420 Hz 는 그만큼 비워줘야 합니다',
               params: { hpfHz: 65, lowDb: -1, lowHz: 110, b1Db: -2.5, b1Hz: 420, b1Q: 1.4,
                         b2Db: 2.5, b2Hz: 3600, b2Q: 1.1, b3Db: 2, b3Hz: 8500, b3Q: 0.8,
                         highDb: 4.5, highHz: 11000, lpfHz: 20000 } },
    pop:     { note: '같은 모양을 한 단계 낮춘 것. 어디에 걸어도 안 틀리는 쪽',
               params: { hpfHz: 50, lowDb: 0, lowHz: 100, b1Db: -1.8, b1Hz: 380, b1Q: 1.2,
                         b2Db: 2, b2Hz: 3200, b2Q: 1, b3Db: 1.5, b3Hz: 7500, b3Q: 0.8,
                         highDb: 3, highHz: 10000, lpfHz: 20000 } },
    edm:     { note: '55 Hz 셸프로 서브를 밀고 480 Hz 를 파냅니다. 톱니 신스가 앉을 자리',
               params: { hpfHz: 28, lowDb: 2.5, lowHz: 55, b1Db: -3, b1Hz: 480, b1Q: 1.3,
                         b2Db: -1, b2Hz: 1800, b2Q: 1, b3Db: 2, b3Hz: 6000, b3Q: 0.7,
                         highDb: 4, highHz: 12000, lpfHz: 20000 } },
    hiphop:  { note: '50 Hz 808 과 160 Hz 온기를 같이 올리고 9.5 kHz 로 하이햇을 냅니다',
               params: { hpfHz: 26, lowDb: 3.5, lowHz: 50, b1Db: 1, b1Hz: 160, b1Q: 0.9,
                         b2Db: -1.5, b2Hz: 2400, b2Q: 1.2, b3Db: 2.5, b3Hz: 9500, b3Q: 0.8,
                         highDb: 2.5, highHz: 13000, lpfHz: 20000 } },
    rnb:     { note: '260 Hz 를 올리고 3.8 kHz 를 내립니다 — 밝히는 대신 데웁니다',
               params: { hpfHz: 36, lowDb: 2, lowHz: 75, b1Db: 1.5, b1Hz: 260, b1Q: 0.9,
                         b2Db: -1, b2Hz: 3800, b2Q: 1.3, b3Db: 1, b3Hz: 7000, b3Q: 0.7,
                         highDb: 1.5, highHz: 10500, lpfHz: 19000 } },
    jpop:    { note: '1.9 kHz 를 세게 밀어 올립니다. 파트가 많을수록 중역이 승부처입니다',
               params: { hpfHz: 75, lowDb: -1.5, lowHz: 130, b1Db: -1, b1Hz: 300, b1Q: 1.5,
                         b2Db: 2.8, b2Hz: 1900, b2Q: 1.2, b3Db: 2.5, b3Hz: 8000, b3Q: 0.9,
                         highDb: 4, highHz: 12500, lpfHz: 20000 } },
  }),

  // Tilt has two knobs, so the pivot is doing as much genre work as the tilt
  // itself: it decides how much of the spectrum the tilt is allowed to touch.
  // Ordered by how much low end the genre wants protected from it — 힙합 hinges
  // at 600 Hz so the 808 never moves, K-POP and J-POP hinge above 2.6 kHz so
  // the lift is presence and air rather than a general brightening.
  ...genrePresets('tilt', {
    jazz:    { note: '+0.8 dB · 축 1.38 kHz. 거의 수평입니다',
               params: { tiltDb: 0.8, pivotHz: 1380 } },
    lofi:    { note: '−5 dB · 축 1.9 kHz. 이 한 손잡이가 로파이의 절반입니다',
               params: { tiltDb: -5, pivotHz: 1900 } },
    ambient: { note: '축 1.12 kHz — 저역을 남기고 위만 엽니다',
               params: { tiltDb: 1.5, pivotHz: 1120 } },
    classic: { note: '+0.3 dB — 안 건드린 것과 같습니다. 그게 맞습니다',
               params: { tiltDb: 0.3, pivotHz: 1640 } },
    kpop:    { note: '축 2.68 kHz · +4 dB. 밝히는 게 아니라 존재감과 공기만 올립니다',
               params: { tiltDb: 4, pivotHz: 2680 } },
    pop:     { note: '축 2.16 kHz · +2.5 dB',
               params: { tiltDb: 2.5, pivotHz: 2160 } },
    edm:     { note: '축 860 Hz — 서브 바로 위에서 기울입니다. 아래가 같이 죽으면 안 됩니다',
               params: { tiltDb: 3, pivotHz: 860 } },
    hiphop:  { note: '축 600 Hz. 열 장르 중 가장 낮아서 808 무게가 그대로 남습니다',
               params: { tiltDb: 1.6, pivotHz: 600 } },
    rnb:     { note: '유일하게 아래로 기웁니다. 축 2.42 kHz 위만 눌러 부드럽게',
               params: { tiltDb: -0.8, pivotHz: 2420 } },
    jpop:    { note: '축 2.94 kHz · +3.5 dB. 중역은 EQ 로 내고 틸트는 광택만 담당합니다',
               params: { tiltDb: 3.5, pivotHz: 2940 } },
  }),

  ...genrePresets('mseq', {
    jazz:    { note: '사이드는 공기만 조금. 연주는 가운데에 있어야 합니다',
               params: { midLowDb: 0.5, midHighDb: 0.5, sideLowDb: -1, sideHighDb: 2.5 } },
    lofi:    { note: '사이드 고역을 −5 dB. 모노에 가까울수록 로파이다워집니다',
               params: { midLowDb: 2, midHighDb: -4, sideLowDb: -2, sideHighDb: -5 } },
    ambient: { note: '사이드 고역 +4 dB. 이 장르는 넓이가 곧 내용입니다',
               params: { midLowDb: 0, midHighDb: -1.5, sideLowDb: 1, sideHighDb: 4 } },
    classic: { note: '스테레오 이미지를 손대지 않습니다. 마이크가 이미 정해놨습니다',
               params: { midLowDb: 0, midHighDb: 0, sideLowDb: 0, sideHighDb: 0.5 } },
    kpop:    { note: '저역 사이드 −6 dB 로 모노화, 고역 사이드는 크게 벌립니다',
               params: { midLowDb: 1, midHighDb: 2.5, sideLowDb: -6, sideHighDb: 4 } },
    pop:     { note: '같은 처방을 한 단계 완화',
               params: { midLowDb: 0.5, midHighDb: 2, sideLowDb: -4, sideHighDb: 3 } },
    edm:     { note: '−9 dB. 열 장르 중 저역을 가장 강하게 모노로 묶습니다',
               params: { midLowDb: 2.5, midHighDb: 1, sideLowDb: -9, sideHighDb: 5 } },
    hiphop:  { note: '808 은 무조건 가운데. 고역은 EDM 만큼 벌리지 않습니다',
               params: { midLowDb: 3, midHighDb: 1.5, sideLowDb: -8, sideHighDb: 2 } },
    rnb:     { note: '미드 고역만 살짝 내립니다. 리드가 앞으로 튀어나오지 않게',
               params: { midLowDb: 1.5, midHighDb: -0.5, sideLowDb: -3, sideHighDb: 2.5 } },
    jpop:    { note: '미드 고역 +3.5 dB — 벌리는 것보다 가운데를 밝히는 쪽',
               params: { midLowDb: -0.5, midHighDb: 3.5, sideLowDb: -3.5, sideHighDb: 3.5 } },
  }),

  ...genrePresets('dyneq', {
    jazz:    { note: '320 Hz 박스만 울릴 때 −3 dB. 상시로 깎으면 몸통이 사라집니다',
               params: { freqHz: 320, q: 1.2, thresholdDb: -26, rangeDb: -3 } },
    lofi:    { note: '420 Hz 혼. 샘플 루프가 뭉칠 때만 들어갑니다',
               params: { freqHz: 420, q: 1.6, thresholdDb: -20, rangeDb: -5 } },
    ambient: { note: '250 Hz — 긴 꼬리가 겹치면서 쌓이는 대역입니다',
               params: { freqHz: 250, q: 0.9, thresholdDb: -30, rangeDb: -4 } },
    classic: { note: '200 Hz 홀 럼블에 −2.5 dB. 이 장르에서 이보다 더 하면 티가 납니다',
               params: { freqHz: 200, q: 0.8, thresholdDb: -32, rangeDb: -2.5 } },
    kpop:    { note: '5.2 kHz. 보컬을 겹겹이 쌓으면 이 대역이 같이 곱해집니다',
               params: { freqHz: 5200, q: 2.4, thresholdDb: -18, rangeDb: -6 } },
    pop:     { note: '3.4 kHz 존재감 대역을 상시가 아니라 필요할 때만',
               params: { freqHz: 3400, q: 2, thresholdDb: -20, rangeDb: -5 } },
    edm:     { note: '2.4 kHz — 톱니 신스가 쏘는 지점',
               params: { freqHz: 2400, q: 1.8, thresholdDb: -16, rangeDb: -7 } },
    hiphop:  { note: '240 Hz 에서 808 과 킥이 부딪힐 때만 비켜줍니다',
               params: { freqHz: 240, q: 1.4, thresholdDb: -17, rangeDb: -6.5 } },
    rnb:     { note: '900 Hz 비음. 리드가 강하게 들어올 때만 눌립니다',
               params: { freqHz: 900, q: 2.6, thresholdDb: -22, rangeDb: -4.5 } },
    jpop:    { note: '6.8 kHz — 광택을 유지하면서 귀 아픈 순간만 잡습니다',
               params: { freqHz: 6800, q: 2.2, thresholdDb: -17, rangeDb: -6 } },
  }),

  ...genrePresets('exciter', {
    jazz:    { note: '9 kHz 에 아주 조금. 심벌이 사라졌을 때만 쓰세요',
               params: { amount: 0.12, freqHz: 9000, mix: 0.15 } },
    lofi:    { note: '2.6 kHz — 유일하게 낮은 곳을 자극합니다. 위는 어차피 잘려 있습니다',
               params: { amount: 0.05, freqHz: 2600, mix: 0.08 } },
    ambient: { note: '7 kHz 를 은은하게. 꼬리에 반짝임이 남습니다',
               params: { amount: 0.2, freqHz: 7000, mix: 0.22 } },
    classic: { note: '사실상 꺼진 상태입니다. 클래식에 하모닉을 더하면 그건 다른 녹음입니다',
               params: { amount: 0.04, freqHz: 10500, mix: 0.06 } },
    kpop:    { note: '8.5 kHz 를 세게. 이 장르의 광택은 EQ 만으로는 안 나옵니다',
               params: { amount: 0.55, freqHz: 8500, mix: 0.5 } },
    pop:     { note: '7.5 kHz 중간 세기',
               params: { amount: 0.4, freqHz: 7500, mix: 0.4 } },
    edm:     { note: '6 kHz — 리드가 믹스를 뚫고 나오는 대역',
               params: { amount: 0.5, freqHz: 6000, mix: 0.45 } },
    hiphop:  { note: '9.5 kHz 하이햇 전용. 보컬 버스에 걸면 치찰음이 같이 커집니다',
               params: { amount: 0.42, freqHz: 9500, mix: 0.38 } },
    rnb:     { note: '6.5 kHz 를 부드럽게. 밝히는 게 아니라 결을 냅니다',
               params: { amount: 0.25, freqHz: 6500, mix: 0.28 } },
    jpop:    { note: '10 kHz 최대치에 가깝게. 열 장르 중 가장 셉니다',
               params: { amount: 0.6, freqHz: 10000, mix: 0.55 } },
  }),

  // ══ Dynamics ═══════════════════════════════════════════════════════════════

  ...genrePresets('comp', {
    jazz:    { note: '1.8:1 에 니 14 dB. 레벨을 잡는 게 아니라 붙이는 용도입니다',
               params: { thresholdDb: -22, ratio: 1.8, kneeDb: 14, attackMs: 25, releaseMs: 260, makeupDb: 2 } },
    lofi:    { note: '어택을 늦게(22 ms) 릴리즈를 빠르게(65 ms) — 이 조합이 로파이의 숨소리입니다',
               params: { thresholdDb: -24, ratio: 5, kneeDb: 3, attackMs: 22, releaseMs: 65, makeupDb: 5 } },
    ambient: { note: '전부 느리게. 컴프가 움직이는 게 들리면 실패입니다',
               params: { thresholdDb: -26, ratio: 1.6, kneeDb: 18, attackMs: 40, releaseMs: 500, makeupDb: 2 } },
    classic: { note: '1.3:1. 켜져 있다는 것만 확인되는 정도가 이 장르의 최대치입니다',
               params: { thresholdDb: -30, ratio: 1.3, kneeDb: 24, attackMs: 50, releaseMs: 700, makeupDb: 1 } },
    kpop:    { note: '어택 4 ms 로 자음을 살짝 남기고 5.5:1 로 붙입니다',
               params: { thresholdDb: -17, ratio: 5.5, kneeDb: 5, attackMs: 4, releaseMs: 75, makeupDb: 5.5 } },
    pop:     { note: '4:1 · 8 ms. 어디에 걸어도 실패하지 않는 설정',
               params: { thresholdDb: -18, ratio: 4, kneeDb: 6, attackMs: 8, releaseMs: 110, makeupDb: 5 } },
    edm:     { note: '10:1 · 1 ms · 35 ms. 열 장르 중 가장 폭력적입니다',
               params: { thresholdDb: -12, ratio: 10, kneeDb: 1, attackMs: 1, releaseMs: 35, makeupDb: 8 } },
    hiphop:  { note: '어택을 12 ms 로 늦춰 랩의 자음을 통과시킵니다. 비트는 따로 잡으세요',
               params: { thresholdDb: -13, ratio: 4, kneeDb: 8, attackMs: 12, releaseMs: 140, makeupDb: 6.5 } },
    rnb:     { note: '어택 18 ms · 니 10 dB. 목소리의 모양을 뭉개지 않는 것이 전부입니다',
               params: { thresholdDb: -19, ratio: 3, kneeDb: 10, attackMs: 18, releaseMs: 180, makeupDb: 4 } },
    jpop:    { note: 'K-POP 보다 조금 더 빠르고 세게. 편곡이 빽빽하면 그만큼 눌러야 자리가 납니다',
               params: { thresholdDb: -15, ratio: 6.5, kneeDb: 3, attackMs: 2.5, releaseMs: 55, makeupDb: 6.5 } },
  }),

  ...genrePresets('ducker', {
    jazz:    { note: '2:1 · 400 ms. 베이스가 잠깐 비켜서는 정도, 펌핑이 아닙니다',
               params: { thresholdDb: -28, ratio: 2, attackMs: 60, releaseMs: 400, makeupDb: 0 } },
    lofi:    { note: '느슨한 펌핑. 정확하게 맞추면 로파이가 아니게 됩니다',
               params: { thresholdDb: -22, ratio: 3.5, attackMs: 40, releaseMs: 220, makeupDb: 1 } },
    ambient: { note: '릴리즈 700 ms — 눌렸다 돌아오는 게 아니라 밀물처럼 차오릅니다',
               params: { thresholdDb: -30, ratio: 2.5, attackMs: 90, releaseMs: 700, makeupDb: 0 } },
    classic: { note: '클래식에는 사이드체인이 없습니다. 켜야 한다면 이 정도가 한계입니다',
               params: { thresholdDb: -36, ratio: 1.5, attackMs: 120, releaseMs: 800, makeupDb: 0 } },
    kpop:    { note: '보컬 앞에서 반주가 물러납니다. 킥 펌핑이 아니라 보컬 덕킹',
               params: { thresholdDb: -20, ratio: 5, attackMs: 15, releaseMs: 140, makeupDb: 2 } },
    pop:     { note: '같은 용도로 절반 세기',
               params: { thresholdDb: -22, ratio: 4, attackMs: 20, releaseMs: 180, makeupDb: 1.5 } },
    edm:     { note: '12:1 · 어택 5 ms. 이 펌핑은 효과가 아니라 곡의 구조입니다',
               params: { thresholdDb: -16, ratio: 12, attackMs: 5, releaseMs: 90, makeupDb: 3 } },
    hiphop:  { note: '킥이 올 때 808 이 자리를 비웁니다. 저역 두 개가 겹치면 둘 다 죽습니다',
               params: { thresholdDb: -18, ratio: 6, attackMs: 10, releaseMs: 110, makeupDb: 2 } },
    rnb:     { note: '릴리즈 260 ms 로 부드럽게 돌아옵니다',
               params: { thresholdDb: -24, ratio: 3.5, attackMs: 30, releaseMs: 260, makeupDb: 1 } },
    jpop:    { note: '7:1 — 파트가 많아서 비켜주지 않으면 아무것도 안 들립니다',
               params: { thresholdDb: -19, ratio: 7, attackMs: 12, releaseMs: 120, makeupDb: 2.5 } },
  }),

  ...genrePresets('limiter', {
    jazz:    { note: '−2 dB 실링에 릴리즈 250 ms. 다이내믹을 남기려고 일부러 여유를 둡니다',
               params: { ceilingDb: -2, lookaheadMs: 5, releaseMs: 250 } },
    lofi:    { note: '−1.2 dB. 로파이는 작아야 하는 음악이 아닙니다',
               params: { ceilingDb: -1.2, lookaheadMs: 3, releaseMs: 120 } },
    ambient: { note: '룩어헤드 8 ms · 릴리즈 380 ms. 리미터가 숨쉬는 게 들리면 안 됩니다',
               params: { ceilingDb: -2.5, lookaheadMs: 8, releaseMs: 380 } },
    classic: { note: '−3 dB. 리미터는 사고 방지용이고 그 이상 쓰면 녹음을 버립니다',
               params: { ceilingDb: -3, lookaheadMs: 10, releaseMs: 450 } },
    kpop:    { note: '−0.8 dB · 45 ms. 이 장르는 리미터 뒤에서 완성됩니다',
               params: { ceilingDb: -0.8, lookaheadMs: 1.5, releaseMs: 45 } },
    pop:     { note: '−1 dB · 90 ms',
               params: { ceilingDb: -1, lookaheadMs: 2.5, releaseMs: 90 } },
    edm:     { note: '−0.6 dB · 30 ms. 룩어헤드 1 ms — 킥의 앞면을 자릅니다',
               params: { ceilingDb: -0.6, lookaheadMs: 1, releaseMs: 30 } },
    hiphop:  { note: '−0.9 dB · 60 ms. 808 이 리미터를 흔들면 릴리즈를 늘리세요',
               params: { ceilingDb: -0.9, lookaheadMs: 2, releaseMs: 60 } },
    rnb:     { note: '−1.3 dB · 150 ms. 팝보다 한 칸 여유',
               params: { ceilingDb: -1.3, lookaheadMs: 4, releaseMs: 150 } },
    jpop:    { note: '룩어헤드를 2.5 ms 로 — 중역이 빽빽하면 짧은 룩어헤드가 왜곡으로 들립니다',
               params: { ceilingDb: -0.7, lookaheadMs: 2.5, releaseMs: 55 } },
  }),

  ...genrePresets('gate', {
    jazz:    { note: '레인지 12 dB — 완전히 닫지 않습니다. 방 소리도 연주의 일부입니다',
               params: { thresholdDb: -52, rangeDb: 12, attackMs: 8, releaseMs: 400 } },
    lofi:    { note: '히스를 다 지우면 로파이가 아닙니다. 18 dB 만',
               params: { thresholdDb: -44, rangeDb: 18, attackMs: 12, releaseMs: 260 } },
    ambient: { note: '릴리즈 900 ms. 게이트가 꼬리를 자르는 순간이 들리면 실패입니다',
               params: { thresholdDb: -58, rangeDb: 8, attackMs: 30, releaseMs: 900 } },
    classic: { note: '사실상 꺼둔 상태. 홀에 게이트를 거는 건 녹음을 되돌리는 일입니다',
               params: { thresholdDb: -64, rangeDb: 6, attackMs: 40, releaseMs: 1200 } },
    kpop:    { note: '45 dB · 어택 2 ms. 트랙 사이가 완전히 조용해야 합니다',
               params: { thresholdDb: -36, rangeDb: 45, attackMs: 2, releaseMs: 120 } },
    pop:     { note: '34 dB. 지우되 티는 안 나게',
               params: { thresholdDb: -40, rangeDb: 34, attackMs: 4, releaseMs: 180 } },
    edm:     { note: '55 dB · 1 ms. 게이트가 아니라 스위치처럼 씁니다',
               params: { thresholdDb: -32, rangeDb: 55, attackMs: 1, releaseMs: 90 } },
    hiphop:  { note: '48 dB. 랩 트랙의 숨소리는 남기고 방 소리만 지우려면 임계를 올리세요',
               params: { thresholdDb: -34, rangeDb: 48, attackMs: 2.5, releaseMs: 110 } },
    rnb:     { note: '22 dB · 릴리즈 320 ms. 꼬리를 남기는 쪽이 이 장르와 맞습니다',
               params: { thresholdDb: -46, rangeDb: 22, attackMs: 10, releaseMs: 320 } },
    jpop:    { note: '40 dB. 파트가 많을수록 안 쓰는 트랙이 조용해야 합계가 깨끗합니다',
               params: { thresholdDb: -38, rangeDb: 40, attackMs: 3, releaseMs: 150 } },
  }),

  ...genrePresets('mbcomp', {
    jazz:    { note: '세 대역 모두 1.5:1 안쪽. 대역을 나눈 이유는 컨트롤이지 압축이 아닙니다',
               params: { lowXHz: 140, highXHz: 3500, lowThrDb: -24, lowRatio: 1.6,
                         midThrDb: -26, midRatio: 1.4, hiThrDb: -28, hiRatio: 1.5, makeupDb: 1 } },
    lofi:    { note: '크로스오버를 2.6 kHz 로 낮춥니다 — 위쪽에는 어차피 내용이 없습니다',
               params: { lowXHz: 200, highXHz: 2600, lowThrDb: -20, lowRatio: 3.5,
                         midThrDb: -18, midRatio: 4, hiThrDb: -24, hiRatio: 2, makeupDb: 2.5 } },
    ambient: { note: '중역을 가장 약하게 잡습니다. 패드가 눌리면 움직임이 사라집니다',
               params: { lowXHz: 110, highXHz: 4200, lowThrDb: -28, lowRatio: 1.8,
                         midThrDb: -30, midRatio: 1.5, hiThrDb: -26, hiRatio: 2, makeupDb: 1 } },
    classic: { note: '세 대역 1.2:1 동일. 대역별로 다르게 누르면 홀의 균형이 무너집니다',
               params: { lowXHz: 160, highXHz: 3000, lowThrDb: -32, lowRatio: 1.2,
                         midThrDb: -34, midRatio: 1.2, hiThrDb: -34, hiRatio: 1.2, makeupDb: 0 } },
    kpop:    { note: '고역을 가장 세게(5:1) — 쌓아 올린 보컬의 위쪽이 가장 먼저 터집니다',
               params: { lowXHz: 130, highXHz: 3800, lowThrDb: -18, lowRatio: 4,
                         midThrDb: -16, midRatio: 3.5, hiThrDb: -14, hiRatio: 5, makeupDb: 4 } },
    pop:     { note: '세 대역을 3:1 근처로 고르게',
               params: { lowXHz: 150, highXHz: 3400, lowThrDb: -20, lowRatio: 3.2,
                         midThrDb: -19, midRatio: 3, hiThrDb: -18, hiRatio: 3.5, makeupDb: 3 } },
    edm:     { note: '저역 5.5:1 로 서브를 고정합니다. 서브가 흔들리면 곡 전체가 흔들립니다',
               params: { lowXHz: 120, highXHz: 4600, lowThrDb: -14, lowRatio: 5.5,
                         midThrDb: -18, midRatio: 3, hiThrDb: -16, hiRatio: 4.5, makeupDb: 5 } },
    hiphop:  { note: '크로스오버 90 Hz — 808 만 따로 떼어 6:1 로 묶습니다',
               params: { lowXHz: 90, highXHz: 5200, lowThrDb: -12, lowRatio: 6,
                         midThrDb: -20, midRatio: 2.6, hiThrDb: -18, hiRatio: 3.8, makeupDb: 4.5 } },
    rnb:     { note: '세 대역 2.2–2.6:1. 고르게 살짝 — 이 장르는 균일함이 곧 고급스러움입니다',
               params: { lowXHz: 170, highXHz: 3200, lowThrDb: -22, lowRatio: 2.6,
                         midThrDb: -22, midRatio: 2.4, hiThrDb: -22, hiRatio: 2.2, makeupDb: 2 } },
    jpop:    { note: '중역과 고역을 둘 다 세게. 크로스오버 180 Hz 로 저역을 좁게 잡습니다',
               params: { lowXHz: 180, highXHz: 4000, lowThrDb: -19, lowRatio: 4.5,
                         midThrDb: -15, midRatio: 4, hiThrDb: -15, hiRatio: 5.5, makeupDb: 4 } },
  }),

  ...genrePresets('clipper', {
    jazz:    { note: '드라이브 0.5 dB. 사고를 막는 용도이고 소리로 쓰지 않습니다',
               params: { driveDb: 0.5, ceilingDb: -3, hardness: 0.15 } },
    lofi:    { note: '4 dB · 하드니스 0.62. 클리핑 자체가 질감입니다',
               params: { driveDb: 4, ceilingDb: -1.5, hardness: 0.62 } },
    ambient: { note: '거의 꺼둡니다. 각진 파형은 이 장르에 없습니다',
               params: { driveDb: 0.8, ceilingDb: -3.5, hardness: 0.2 } },
    classic: { note: '드라이브 0 dB. 클리퍼를 통과만 시키는 설정입니다',
               params: { driveDb: 0, ceilingDb: -4, hardness: 0.1 } },
    kpop:    { note: '5 dB · 0.75. 리미터 앞에서 피크를 미리 깎아 라우드니스를 법니다',
               params: { driveDb: 5, ceilingDb: -0.9, hardness: 0.75 } },
    pop:     { note: '3 dB · 0.55',
               params: { driveDb: 3, ceilingDb: -1.2, hardness: 0.55 } },
    edm:     { note: '7.5 dB · 0.9. 킥 앞면을 잘라내는 것이 목적입니다',
               params: { driveDb: 7.5, ceilingDb: -0.6, hardness: 0.9 } },
    hiphop:  { note: '6 dB · 0.85. 드럼 버스에. 808 에 걸면 저역이 지저분해집니다',
               params: { driveDb: 6, ceilingDb: -1, hardness: 0.85 } },
    rnb:     { note: '2 dB · 0.35. 부드러운 무릎으로 최고점만 둥글립니다',
               params: { driveDb: 2, ceilingDb: -1.6, hardness: 0.35 } },
    jpop:    { note: '5.5 dB · 0.7. K-POP 과 EDM 사이',
               params: { driveDb: 5.5, ceilingDb: -0.8, hardness: 0.7 } },
  }),

  ...genrePresets('deesser', {
    jazz:    { note: '7.2 kHz 를 0.2 만큼. 재즈 보컬의 치찰음은 원래 살아 있습니다',
               params: { freqHz: 7200, thresholdDb: -18, amount: 0.2 } },
    lofi:    { note: '5.5 kHz — 샘플 소스의 디지털 치찰음은 더 낮은 곳에서 납니다',
               params: { freqHz: 5500, thresholdDb: -14, amount: 0.35 } },
    ambient: { note: '8 kHz 를 가볍게. 보컬이 있다면 대개 멀리 있습니다',
               params: { freqHz: 8000, thresholdDb: -22, amount: 0.18 } },
    classic: { note: '0.1. 성악의 치찰음을 지우면 발음이 사라집니다',
               params: { freqHz: 8500, thresholdDb: -28, amount: 0.1 } },
    kpop:    { note: '0.72 — 열 장르 중 가장 셉니다. 보컬을 겹칠수록 치찰음도 겹칩니다',
               params: { freqHz: 6800, thresholdDb: -26, amount: 0.72 } },
    pop:     { note: '6.5 kHz · 0.5',
               params: { freqHz: 6500, thresholdDb: -22, amount: 0.5 } },
    edm:     { note: '7.8 kHz — 보컬 촙과 하이햇이 같이 걸리는 대역',
               params: { freqHz: 7800, thresholdDb: -20, amount: 0.4 } },
    hiphop:  { note: '6 kHz · 0.45. 랩은 자음이 살아야 하니 임계를 높게 둡니다',
               params: { freqHz: 6000, thresholdDb: -19, amount: 0.45 } },
    rnb:     { note: '6.2 kHz · 0.55. 애드립이 많을수록 디에서가 일합니다',
               params: { freqHz: 6200, thresholdDb: -24, amount: 0.55 } },
    jpop:    { note: '7 kHz · 0.65. 고역을 많이 올리는 만큼 되돌려 받아야 합니다',
               params: { freqHz: 7000, thresholdDb: -25, amount: 0.65 } },
  }),

  ...genrePresets('transient', {
    jazz:    { note: '어택은 그대로, 서스테인만 조금. 연주자의 다이내믹을 다시 쓰지 않습니다',
               params: { attack: 0.05, sustain: 0.15, mix: 0.7 } },
    lofi:    { note: '어택을 −0.3 으로 뭉갭니다. 또렷한 드럼은 이 장르의 반대편입니다',
               params: { attack: -0.3, sustain: 0.25, mix: 0.8 } },
    ambient: { note: '−0.55. 소리에 앞면이 없어야 합니다',
               params: { attack: -0.55, sustain: 0.45, mix: 0.9 } },
    classic: { note: '거의 0. 트랜지언트를 다시 그리는 건 연주를 다시 하는 것입니다',
               params: { attack: 0, sustain: 0.05, mix: 0.5 } },
    kpop:    { note: '어택 +0.45 · 서스테인 −0.25. 방 소리를 걷어내고 앞면만 남깁니다',
               params: { attack: 0.45, sustain: -0.25, mix: 1 } },
    pop:     { note: '+0.3 · −0.1',
               params: { attack: 0.3, sustain: -0.1, mix: 1 } },
    edm:     { note: '+0.7 · −0.45. 킥이 스피커를 때리는 소리를 만듭니다',
               params: { attack: 0.7, sustain: -0.45, mix: 1 } },
    hiphop:  { note: '어택 +0.55, 서스테인은 −0.15 만 — 808 의 꼬리를 죽이면 안 됩니다',
               params: { attack: 0.55, sustain: -0.15, mix: 1 } },
    rnb:     { note: '+0.15 · +0.1. 때리는 게 아니라 밀어주는 정도',
               params: { attack: 0.15, sustain: 0.1, mix: 0.85 } },
    jpop:    { note: '+0.6 · −0.35. 빽빽한 편곡에서는 앞면이 없으면 묻힙니다',
               params: { attack: 0.6, sustain: -0.35, mix: 0.95 } },
  }),

  // ══ Saturation ═════════════════════════════════════════════════════════════

  ...genrePresets('saturation', {
    jazz:    { note: '2.5 dB · 22 % 병렬. 진공관 냄새만 나고 왜곡은 안 들립니다',
               params: { driveDb: 2.5, mix: 0.22, bias: 0.05 } },
    lofi:    { note: '바이어스 0.35 — 비대칭으로 짝수 배음을 크게. 지저분한 게 목적입니다',
               params: { driveDb: 8, mix: 0.55, bias: 0.35 } },
    ambient: { note: '바이어스를 음수로. 홀수 배음 쪽이 패드와 잘 섞입니다',
               params: { driveDb: 3, mix: 0.3, bias: -0.1 } },
    classic: { note: '6 % 병렬. 사실상 통과입니다',
               params: { driveDb: 0.5, mix: 0.06, bias: 0 } },
    kpop:    { note: '5 dB · 40 %. 밝기를 EQ 로만 만들면 얇아집니다',
               params: { driveDb: 5, mix: 0.4, bias: 0.1 } },
    pop:     { note: '4 dB · 30 %',
               params: { driveDb: 4, mix: 0.3, bias: 0.08 } },
    edm:     { note: '7 dB · 45 %. 신스 버스에 걸어 두께를 만듭니다',
               params: { driveDb: 7, mix: 0.45, bias: 0.2 } },
    hiphop:  { note: '바이어스 0.32 — 808 이 작은 스피커에서도 들리게 만드는 배음입니다',
               params: { driveDb: 6, mix: 0.4, bias: 0.32 } },
    rnb:     { note: '38 % 병렬로 넉넉하게, 드라이브는 낮게. 두껍되 거칠지 않게',
               params: { driveDb: 3.2, mix: 0.38, bias: 0.24 } },
    jpop:    { note: '5.5 dB · 48 %. 병렬량은 가장 많고 드라이브는 중간 — 거칠지 않게 두껍습니다',
               params: { driveDb: 5.5, mix: 0.48, bias: 0.14 } },
  }),

  ...genrePresets('tube', {
    jazz:    { note: '톤 11 kHz — 관을 통과시키되 위를 깎지 않습니다',
               params: { drive: 0.22, bias: 0.1, toneHz: 11000, mix: 45, outDb: 0 } },
    lofi:    { note: '톤 3.2 kHz · 믹스 85 %. 관이 소리를 먹는 게 이 장르에서는 장점입니다',
               params: { drive: 0.6, bias: 0.34, toneHz: 3200, mix: 85, outDb: -1.5 } },
    ambient: { note: '드라이브는 낮고 톤은 열어둡니다. 꼬리에 온기만',
               params: { drive: 0.25, bias: 0.12, toneHz: 9000, mix: 55, outDb: 0 } },
    classic: { note: '믹스 18 %. 관 소리를 더하는 순간 그건 다른 녹음입니다',
               params: { drive: 0.08, bias: 0.04, toneHz: 13000, mix: 18, outDb: 0 } },
    kpop:    { note: '0.45 · 톤 8 kHz. 보컬 버스에 두께를 붙이는 용도',
               params: { drive: 0.45, bias: 0.2, toneHz: 8000, mix: 65, outDb: -0.5 } },
    pop:     { note: '0.35 · 톤 9.5 kHz',
               params: { drive: 0.35, bias: 0.16, toneHz: 9500, mix: 55, outDb: -0.3 } },
    edm:     { note: '톤 6.5 kHz 로 낮춰 톱니의 날을 무디게 합니다',
               params: { drive: 0.55, bias: 0.24, toneHz: 6500, mix: 70, outDb: -1 } },
    hiphop:  { note: '바이어스 0.3 · 톤 5.5 kHz. 저역이 두꺼워지는 쪽으로 치우칩니다',
               params: { drive: 0.5, bias: 0.3, toneHz: 5500, mix: 75, outDb: -0.8 } },
    rnb:     { note: '믹스 80 % — 열 장르 중 관을 가장 많이 통과시킵니다. 따뜻함이 곧 장르입니다',
               params: { drive: 0.4, bias: 0.22, toneHz: 7000, mix: 80, outDb: -0.4 } },
    jpop:    { note: '톤 10.5 kHz 로 열어둡니다. 두껍게 하되 광택은 잃지 않게',
               params: { drive: 0.48, bias: 0.18, toneHz: 10500, mix: 68, outDb: -0.6 } },
  }),

  ...genrePresets('bitcrush', {
    jazz:    { note: '15 bit · 6 %. 소리로 쓰는 게 아니라 아주 미세한 결입니다',
               params: { bits: 15, mix: 6 } },
    lofi:    { note: '7 bit · 70 %. 열 장르 중 가장 낮은 비트, 가장 높은 믹스 — 이게 로파이입니다',
               params: { bits: 7, mix: 70 } },
    ambient: { note: '14 bit · 16 %. 패드 뒤에 옅은 그레인만',
               params: { bits: 14, mix: 16 } },
    classic: { note: '16 bit · 3 %. 켜지 않는 것과 같습니다',
               params: { bits: 16, mix: 3 } },
    kpop:    { note: '11 bit · 13 %. 신스 레이어 하나에만 살짝',
               params: { bits: 11, mix: 13 } },
    pop:     { note: '12 bit · 20 %. 이펙트 리턴에 병렬로',
               params: { bits: 12, mix: 20 } },
    edm:     { note: '9 bit · 28 %. 빌드업 구간에 오토메이션으로 올리세요',
               params: { bits: 9, mix: 28 } },
    hiphop:  { note: '8 bit · 36 %. 샘플러 시대의 질감을 되돌려 놓는 설정',
               params: { bits: 8, mix: 36 } },
    rnb:     { note: '13 bit · 9 %. 있는 줄 모르는 정도가 맞습니다',
               params: { bits: 13, mix: 9 } },
    jpop:    { note: '10 bit · 17 %. 신스 촙 구간용',
               params: { bits: 10, mix: 17 } },
  }),

  // ══ Reverb ═════════════════════════════════════════════════════════════════

  ...genrePresets('reverb', {
    jazz:    { note: '1.1 초 · 18 %. 홀이 아니라 방입니다. 밴드가 어디에 있는지가 들려야 합니다',
               params: { decaySec: 1.1, mix: 0.18, preDelayMs: 14 } },
    lofi:    { note: '0.8 초 · 프리딜레이 6 ms. 짧고 붙어 있고 어둡게',
               params: { decaySec: 0.8, mix: 0.22, preDelayMs: 6 } },
    ambient: { note: '6.5 초 · 55 %. 리버브가 반주입니다',
               params: { decaySec: 6.5, mix: 0.55, preDelayMs: 55 } },
    classic: { note: '2.4 초 · 35 %. 실제 콘서트홀의 잔향 시간',
               params: { decaySec: 2.4, mix: 0.35, preDelayMs: 26 } },
    kpop:    { note: '프리딜레이 32 ms 로 가사를 앞으로 밀고 꼬리는 짧게',
               params: { decaySec: 1.3, mix: 0.2, preDelayMs: 32 } },
    pop:     { note: '1.6 초 · 24 %',
               params: { decaySec: 1.6, mix: 0.24, preDelayMs: 24 } },
    edm:     { note: '2.8 초지만 믹스는 30 % — 길되 멀지 않게',
               params: { decaySec: 2.8, mix: 0.3, preDelayMs: 8 } },
    hiphop:  { note: '0.6 초 · 14 %. 열 장르 중 가장 마릅니다. 랩은 얼굴 앞에 있어야 합니다',
               params: { decaySec: 0.6, mix: 0.14, preDelayMs: 4 } },
    rnb:     { note: '2.1 초 · 프리딜레이 38 ms. 넉넉하되 가사를 덮지 않는 지점',
               params: { decaySec: 2.1, mix: 0.28, preDelayMs: 38 } },
    jpop:    { note: '1.4 초 · 12 %. 열 장르 중 가장 적게 섞습니다 — 파트가 이미 많습니다',
               params: { decaySec: 1.4, mix: 0.12, preDelayMs: 18 } },
  }),

  ...genrePresets('spacereverb', {
    jazz:    { note: '나무 방. 초기 반사를 +3 dB 로 올려 공간의 크기를 먼저 들려줍니다',
               params: { space: S('room-wood'), sizePct: 95, decayPct: 80, preDelayMs: 14,
                         dampingPct: 110, erDb: 3, tailDb: -3, lowCutHz: 140, highCutHz: 12000,
                         widthPct: 105, mixPct: 20 } },
    lofi:    { note: '침실. 5.5 kHz 로 잘라내고 댐핑을 160 % 까지 올립니다',
               params: { space: S('room-bedroom'), sizePct: 70, decayPct: 70, preDelayMs: 5,
                         dampingPct: 160, erDb: 2, tailDb: -5, lowCutHz: 200, highCutHz: 5500,
                         widthPct: 88, mixPct: 26 } },
    ambient: { note: '대성당 · 크기 170 % · 디케이 240 %. 초기 반사를 −6 dB 로 지워 꼬리만 남깁니다',
               params: { space: S('hall-cathedral'), sizePct: 170, decayPct: 240, preDelayMs: 70,
                         dampingPct: 70, erDb: -6, tailDb: 4, lowCutHz: 60, highCutHz: 9000,
                         widthPct: 145, mixPct: 55 } },
    classic: { note: '심포니 홀을 있는 그대로. ER 과 테일 둘 다 0 dB — 균형을 손대지 않습니다',
               params: { space: S('hall-symphony'), sizePct: 130, decayPct: 120, preDelayMs: 26,
                         dampingPct: 95, erDb: 0, tailDb: 0, lowCutHz: 40, highCutHz: 14000,
                         widthPct: 100, mixPct: 32 } },
    kpop:    { note: '밝은 플레이트. 로우컷 320 Hz — 잔향이 저역을 건드리면 안 됩니다',
               params: { space: S('plate-bright'), sizePct: 80, decayPct: 75, preDelayMs: 30,
                         dampingPct: 120, erDb: -2, tailDb: -1, lowCutHz: 320, highCutHz: 13000,
                         widthPct: 120, mixPct: 18 } },
    pop:     { note: '보컬 플레이트. K-POP 과 같은 처방을 한 단계 넉넉하게',
               params: { space: S('plate-vocal'), sizePct: 90, decayPct: 90, preDelayMs: 24,
                         dampingPct: 105, erDb: -1, tailDb: 0, lowCutHz: 260, highCutHz: 11000,
                         widthPct: 115, mixPct: 22 } },
    edm:     { note: '아레나 · 폭 140 %. 프리딜레이 8 ms 로 붙여야 킥과 싸우지 않습니다',
               params: { space: S('live-arena'), sizePct: 150, decayPct: 130, preDelayMs: 8,
                         dampingPct: 85, erDb: -4, tailDb: 2, lowCutHz: 180, highCutHz: 15000,
                         widthPct: 140, mixPct: 24 } },
    hiphop:  { note: '슬랩. 테일을 −8 dB 로 눌러 방 소리만 남기고 잔향은 지웁니다',
               params: { space: S('amb-slap'), sizePct: 60, decayPct: 55, preDelayMs: 4,
                         dampingPct: 140, erDb: 5, tailDb: -8, lowCutHz: 280, highCutHz: 10000,
                         widthPct: 95, mixPct: 14 } },
    rnb:     { note: '빈티지 플레이트 · 프리딜레이 34 ms · 믹스 28 %. 이 장르의 기본 공간입니다',
               params: { space: S('plate-vintage'), sizePct: 110, decayPct: 115, preDelayMs: 34,
                         dampingPct: 100, erDb: -2, tailDb: 1, lowCutHz: 220, highCutHz: 10500,
                         widthPct: 125, mixPct: 28 } },
    jpop:    { note: '스튜디오 룸 · 믹스 16 %. 편곡이 빽빽하면 공간은 가장 먼저 줄여야 합니다',
               params: { space: S('room-studio'), sizePct: 85, decayPct: 70, preDelayMs: 20,
                         dampingPct: 125, erDb: 1, tailDb: -2, lowCutHz: 300, highCutHz: 13500,
                         widthPct: 118, mixPct: 16 } },
  }),

  ...genrePresets('plate', {
    jazz:    { note: '1.4 초 · 디퓨전 0.6. 플레이트를 방처럼 씁니다',
               params: { decaySec: 1.4, preDelayMs: 16, dampHz: 8000, diffusion: 0.6,
                         lowCutHz: 180, highCutHz: 12000, widthPct: 108, mixPct: 18 } },
    lofi:    { note: '댐프 3.8 kHz · 하이컷 6 kHz. 판이 젖은 것처럼 들립니다',
               params: { decaySec: 1, preDelayMs: 6, dampHz: 3800, diffusion: 0.5,
                         lowCutHz: 260, highCutHz: 6000, widthPct: 92, mixPct: 24 } },
    ambient: { note: '7.5 초 · 디퓨전 0.85 · 폭 145 %. 판이 아니라 공간이 됩니다',
               params: { decaySec: 7.5, preDelayMs: 65, dampHz: 6500, diffusion: 0.85,
                         lowCutHz: 90, highCutHz: 10000, widthPct: 145, mixPct: 52 } },
    classic: { note: '2.6 초 · 폭 100 %. 플레이트로 홀을 흉내 낼 때의 최소 설정',
               params: { decaySec: 2.6, preDelayMs: 28, dampHz: 10000, diffusion: 0.72,
                         lowCutHz: 120, highCutHz: 15000, widthPct: 100, mixPct: 30 } },
    kpop:    { note: '로우컷 340 Hz · 믹스 17 %. 밝고 짧고 저역이 없습니다',
               params: { decaySec: 1.5, preDelayMs: 30, dampHz: 9500, diffusion: 0.78,
                         lowCutHz: 340, highCutHz: 13500, widthPct: 122, mixPct: 17 } },
    pop:     { note: '1.9 초 · 22 %. 보컬 플레이트의 표준값에 가장 가깝습니다',
               params: { decaySec: 1.9, preDelayMs: 24, dampHz: 8500, diffusion: 0.74,
                         lowCutHz: 280, highCutHz: 12000, widthPct: 116, mixPct: 22 } },
    edm:     { note: '3.2 초인데 프리딜레이는 10 ms. 길지만 멀지 않은 소리',
               params: { decaySec: 3.2, preDelayMs: 10, dampHz: 7500, diffusion: 0.8,
                         lowCutHz: 200, highCutHz: 15500, widthPct: 138, mixPct: 20 } },
    hiphop:  { note: '0.8 초 · 디퓨전 0.45. 확산을 낮춰 개별 반사가 들리게 — 방이지 잔향이 아닙니다',
               params: { decaySec: 0.8, preDelayMs: 5, dampHz: 5200, diffusion: 0.45,
                         lowCutHz: 300, highCutHz: 9500, widthPct: 96, mixPct: 12 } },
    rnb:     { note: '2.4 초 · 프리딜레이 36 ms · 폭 128 %. 리드 뒤로 넓게 깔립니다',
               params: { decaySec: 2.4, preDelayMs: 36, dampHz: 7000, diffusion: 0.7,
                         lowCutHz: 230, highCutHz: 11000, widthPct: 128, mixPct: 27 } },
    jpop:    { note: '1.6 초 · 믹스 15 %. 밝게 두되 양은 가장 적게',
               params: { decaySec: 1.6, preDelayMs: 18, dampHz: 9000, diffusion: 0.76,
                         lowCutHz: 320, highCutHz: 14000, widthPct: 118, mixPct: 15 } },
  }),

  ...genrePresets('spring', {
    jazz:    { note: '보잉 0.4. 앰프에 달린 스프링의 소리, 그 이상은 아닙니다',
               params: { decaySec: 1.6, toneHz: 1200, dampHz: 5000, boing: 0.4, mixPct: 16 } },
    lofi:    { note: '보잉 0.7 · 댐프 2.6 kHz. 스프링이 튕기는 게 들려야 합니다',
               params: { decaySec: 1.2, toneHz: 900, dampHz: 2600, boing: 0.7, mixPct: 30 } },
    ambient: { note: '4.5 초 · 보잉 0.25. 스프링의 금속성을 빼고 길이만 씁니다',
               params: { decaySec: 4.5, toneHz: 1600, dampHz: 6500, boing: 0.25, mixPct: 42 } },
    classic: { note: '스프링은 이 장르의 도구가 아닙니다. 보잉 0.15 · 12 % 가 한계입니다',
               params: { decaySec: 2, toneHz: 1400, dampHz: 7500, boing: 0.15, mixPct: 12 } },
    kpop:    { note: '톤 1.8 kHz 로 올려 밝게. 신스 리드의 리턴에',
               params: { decaySec: 1.1, toneHz: 1800, dampHz: 6000, boing: 0.5, mixPct: 14 } },
    pop:     { note: '1.5 초 · 18 %',
               params: { decaySec: 1.5, toneHz: 1500, dampHz: 5500, boing: 0.45, mixPct: 18 } },
    edm:     { note: '톤 2.2 kHz · 댐프 8 kHz. 스프링을 밝은 이펙트로 씁니다',
               params: { decaySec: 2.4, toneHz: 2200, dampHz: 8000, boing: 0.6, mixPct: 20 } },
    hiphop:  { note: '0.9 초 · 보잉 0.75. 스네어 한 방에만 걸어 튕기는 소리를 남깁니다',
               params: { decaySec: 0.9, toneHz: 1000, dampHz: 4200, boing: 0.75, mixPct: 15 } },
    rnb:     { note: '보잉 0.35 · 믹스 24 %. 금속성 없이 두께만 가져옵니다',
               params: { decaySec: 2.2, toneHz: 1300, dampHz: 4800, boing: 0.35, mixPct: 24 } },
    jpop:    { note: '톤 2 kHz · 보잉 0.55. 짧고 밝게 튕깁니다',
               params: { decaySec: 1.3, toneHz: 2000, dampHz: 6800, boing: 0.55, mixPct: 13 } },
  }),

  ...genrePresets('shimmer', {
    jazz:    { note: '시머 0.12. 옥타브가 들리면 재즈가 아니게 됩니다',
               params: { space: S('hall-recital'), decayPct: 90, shimmer: 0.12, loopMs: 220,
                         preDelayMs: 20, lowCutHz: 200, highCutHz: 11000, widthPct: 108, mixPct: 12 } },
    lofi:    { note: '루프 120 ms · 하이컷 6.5 kHz. 시머를 어둡게 만들면 테이프처럼 들립니다',
               params: { space: S('room-bedroom'), decayPct: 70, shimmer: 0.3, loopMs: 120,
                         preDelayMs: 8, lowCutHz: 260, highCutHz: 6500, widthPct: 90, mixPct: 22 } },
    ambient: { note: '시머 0.8 · 믹스 58 %. 이 장치가 존재하는 이유가 이 프리셋입니다',
               params: { space: S('hall-cathedral'), decayPct: 260, shimmer: 0.8, loopMs: 480,
                         preDelayMs: 80, lowCutHz: 70, highCutHz: 12000, widthPct: 148, mixPct: 58 } },
    classic: { note: '시머 0.06 — 옥타브 없이 홀만. 사실상 리버브로 씁니다',
               params: { space: S('hall-symphony'), decayPct: 120, shimmer: 0.06, loopMs: 300,
                         preDelayMs: 30, lowCutHz: 90, highCutHz: 14000, widthPct: 100, mixPct: 16 } },
    kpop:    { note: '로우컷 340 Hz. 후렴 뒤에서 반짝이되 저역은 건드리지 않습니다',
               params: { space: S('plate-bright'), decayPct: 95, shimmer: 0.42, loopMs: 180,
                         preDelayMs: 26, lowCutHz: 340, highCutHz: 14500, widthPct: 126, mixPct: 18 } },
    pop:     { note: '시머 0.35 · 22 %',
               params: { space: S('plate-vocal'), decayPct: 110, shimmer: 0.35, loopMs: 200,
                         preDelayMs: 22, lowCutHz: 280, highCutHz: 12500, widthPct: 118, mixPct: 22 } },
    edm:     { note: '시머 0.65 · 폭 142 %. 브레이크다운 구간의 기본값',
               params: { space: S('live-arena'), decayPct: 180, shimmer: 0.65, loopMs: 300,
                         preDelayMs: 12, lowCutHz: 160, highCutHz: 16000, widthPct: 142, mixPct: 30 } },
    hiphop:  { note: '믹스 10 % · 루프 100 ms. 훅 뒤에만 아주 조금',
               params: { space: S('amb-close'), decayPct: 60, shimmer: 0.25, loopMs: 100,
                         preDelayMs: 6, lowCutHz: 300, highCutHz: 9500, widthPct: 94, mixPct: 10 } },
    rnb:     { note: '시머 0.45 · 프리딜레이 34 ms. 애드립 뒤로 옥타브가 번집니다',
               params: { space: S('plate-vintage'), decayPct: 140, shimmer: 0.45, loopMs: 260,
                         preDelayMs: 34, lowCutHz: 220, highCutHz: 11500, widthPct: 130, mixPct: 26 } },
    jpop:    { note: '시머 0.5 인데 믹스는 17 %. 세게 걸고 조금만 섞습니다',
               params: { space: S('room-studio'), decayPct: 100, shimmer: 0.5, loopMs: 150,
                         preDelayMs: 18, lowCutHz: 320, highCutHz: 15000, widthPct: 122, mixPct: 17 } },
  }),

  // ══ Delay ══════════════════════════════════════════════════════════════════

  ...genrePresets('delay', {
    jazz:    { note: '180 ms · 피드백 0.15. 한 번 되돌아오고 끝납니다',
               params: { timeMs: 180, feedback: 0.15, mix: 0.14 } },
    lofi:    { note: '375 ms (140 BPM 8분). 피드백 0.42 로 뭉개지게 두세요',
               params: { timeMs: 375, feedback: 0.42, mix: 0.28 } },
    ambient: { note: '900 ms · 0.62. 딜레이와 리버브의 경계가 없어지는 지점',
               params: { timeMs: 900, feedback: 0.62, mix: 0.42 } },
    classic: { note: '60 ms · 6 %. 딜레이는 이 장르의 어휘가 아닙니다',
               params: { timeMs: 60, feedback: 0.05, mix: 0.06 } },
    kpop:    { note: '250 ms · 0.24. 후렴 끝 단어에만 오토메이션으로 여세요',
               params: { timeMs: 250, feedback: 0.24, mix: 0.16 } },
    pop:     { note: '320 ms · 0.3',
               params: { timeMs: 320, feedback: 0.3, mix: 0.2 } },
    edm:     { note: '500 ms (120 BPM 4분). 브레이크다운에서 피드백을 올리세요',
               params: { timeMs: 500, feedback: 0.5, mix: 0.26 } },
    hiphop:  { note: '140 ms 슬랩. 랩 뒤에 그림자 하나만 붙습니다',
               params: { timeMs: 140, feedback: 0.2, mix: 0.12 } },
    rnb:     { note: '420 ms · 0.34. 애드립이 다음 마디로 번져 나갑니다',
               params: { timeMs: 420, feedback: 0.34, mix: 0.24 } },
    jpop:    { note: '210 ms · 피드백 0.34. 짧게 잡고 여러 번 되돌아오게',
               params: { timeMs: 210, feedback: 0.34, mix: 0.18 } },
  }),

  ...genrePresets('pingpong', {
    jazz:    { note: '200 ms · 톤 9 kHz · 12 %. 좌우로 벌어지는 게 티나면 안 됩니다',
               params: { timeMs: 200, feedback: 0.18, toneHz: 9000, mix: 12 } },
    lofi:    { note: '톤 4.2 kHz. 되돌아올수록 어두워지는 게 핵심입니다',
               params: { timeMs: 375, feedback: 0.45, toneHz: 4200, mix: 26 } },
    ambient: { note: '800 ms · 0.65 · 40 %. 좌우가 번갈아 차오릅니다',
               params: { timeMs: 800, feedback: 0.65, toneHz: 7000, mix: 40 } },
    classic: { note: '6 %. 켜져 있는지 확인만 되는 수준',
               params: { timeMs: 120, feedback: 0.08, toneHz: 11000, mix: 6 } },
    kpop:    { note: '톤 10.5 kHz — 반복될수록 밝게 남습니다',
               params: { timeMs: 250, feedback: 0.3, toneHz: 10500, mix: 18 } },
    pop:     { note: '320 ms · 22 %',
               params: { timeMs: 320, feedback: 0.34, toneHz: 9500, mix: 22 } },
    edm:     { note: '톤 12 kHz · 피드백 0.52. 좌우 폭을 딜레이로 만듭니다',
               params: { timeMs: 375, feedback: 0.52, toneHz: 12000, mix: 28 } },
    hiphop:  { note: '160 ms · 톤 6.5 kHz. 짧고 어둡게 — 넓히려는 게 아닙니다',
               params: { timeMs: 160, feedback: 0.24, toneHz: 6500, mix: 14 } },
    rnb:     { note: '440 ms · 0.38 · 24 %',
               params: { timeMs: 440, feedback: 0.38, toneHz: 8000, mix: 24 } },
    jpop:    { note: '220 ms · 톤 11.5 kHz. 짧고 밝게',
               params: { timeMs: 220, feedback: 0.32, toneHz: 11500, mix: 16 } },
  }),

  ...genrePresets('tapedelay', {
    jazz:    { note: '와우 0.3 ms. 테이프가 돌고 있다는 것만 느껴지는 정도',
               params: { timeMs: 220, feedback: 0.2, toneHz: 6000, wowMs: 0.3, drive: 0.15, mix: 14 } },
    lofi:    { note: '와우 1.6 ms · 드라이브 0.55 · 톤 2.4 kHz. 이 장치의 로파이 그 자체',
               params: { timeMs: 400, feedback: 0.5, toneHz: 2400, wowMs: 1.6, drive: 0.55, mix: 32 } },
    ambient: { note: '850 ms · 피드백 0.68. 와우를 0.9 로 두면 꼬리가 살아 움직입니다',
               params: { timeMs: 850, feedback: 0.68, toneHz: 4500, wowMs: 0.9, drive: 0.3, mix: 44 } },
    classic: { note: '와우 0.1 ms · 드라이브 0.05. 피치가 흔들리면 안 되는 장르입니다',
               params: { timeMs: 140, feedback: 0.08, toneHz: 8000, wowMs: 0.1, drive: 0.05, mix: 6 } },
    kpop:    { note: '톤 7.5 kHz · 와우 0.25. 테이프의 온기만 빌리고 흔들림은 뺍니다',
               params: { timeMs: 250, feedback: 0.32, toneHz: 7500, wowMs: 0.25, drive: 0.2, mix: 16 } },
    pop:     { note: '330 ms · 20 %',
               params: { timeMs: 330, feedback: 0.36, toneHz: 6500, wowMs: 0.4, drive: 0.25, mix: 20 } },
    edm:     { note: '500 ms · 드라이브 0.4. 반복될수록 두꺼워집니다',
               params: { timeMs: 500, feedback: 0.55, toneHz: 5500, wowMs: 0.5, drive: 0.4, mix: 24 } },
    hiphop:  { note: '톤 3.8 kHz · 와우 0.8 · 드라이브 0.45. 낡은 샘플러의 소리에 가깝게',
               params: { timeMs: 170, feedback: 0.26, toneHz: 3800, wowMs: 0.8, drive: 0.45, mix: 18 } },
    rnb:     { note: '440 ms · 26 %. 애드립과 함께 번지게',
               params: { timeMs: 440, feedback: 0.42, toneHz: 5000, wowMs: 0.55, drive: 0.3, mix: 26 } },
    jpop:    { note: '톤 8.5 kHz — 테이프인데 밝습니다. 이 장르는 그 조합을 씁니다',
               params: { timeMs: 230, feedback: 0.34, toneHz: 8500, wowMs: 0.35, drive: 0.22, mix: 15 } },
  }),

  // ══ Modulation ═════════════════════════════════════════════════════════════

  ...genrePresets('chorus', {
    jazz:    { note: '0.35 Hz · 18 %. 일렉 기타 한 대에만',
               params: { rateHz: 0.35, depthMs: 2, delayMs: 22, mix: 18 } },
    lofi:    { note: '깊이 5.5 ms · 45 %. 튜닝이 흔들리는 게 이 장르에서는 맞는 소리입니다',
               params: { rateHz: 0.8, depthMs: 5.5, delayMs: 26, mix: 45 } },
    ambient: { note: '0.12 Hz — 한 주기가 8 초. 움직이는 걸 알아차리기 전에 바뀝니다',
               params: { rateHz: 0.12, depthMs: 7, delayMs: 30, mix: 55 } },
    classic: { note: '8 %. 현악 앙상블에 코러스를 걸면 인원이 는 게 아니라 튜닝이 나갑니다',
               params: { rateHz: 0.2, depthMs: 1, delayMs: 18, mix: 8 } },
    kpop:    { note: '딜레이 14 ms 로 짧게. 신스를 넓히되 붙어 있게',
               params: { rateHz: 0.9, depthMs: 3, delayMs: 14, mix: 28 } },
    pop:     { note: '0.6 Hz · 32 %',
               params: { rateHz: 0.6, depthMs: 3.5, delayMs: 18, mix: 32 } },
    edm:     { note: '1.4 Hz · 깊이 4.5 ms. 슈퍼소 위에 한 겹 더',
               params: { rateHz: 1.4, depthMs: 4.5, delayMs: 12, mix: 38 } },
    hiphop:  { note: '20 %. 훅의 백보컬에만. 랩 트랙에 걸면 발음이 흐려집니다',
               params: { rateHz: 0.5, depthMs: 2.5, delayMs: 16, mix: 20 } },
    rnb:     { note: '딜레이 24 ms · 34 %. 백보컬 스택을 두껍게 하는 고전적인 방법',
               params: { rateHz: 0.45, depthMs: 4, delayMs: 24, mix: 36 } },
    jpop:    { note: '1.2 Hz · 딜레이 20 ms. 빠르고 얕게 — 편곡이 빽빽할수록 깊이를 줄입니다',
               params: { rateHz: 1.2, depthMs: 2.6, delayMs: 20, mix: 34 } },
  }),

  ...genrePresets('flanger', {
    jazz:    { note: '피드백 0.2 · 14 %. 제트기 소리가 나면 지나친 겁니다',
               params: { rateHz: 0.15, depthMs: 0.8, delayMs: 4, feedback: 0.2, mix: 14 } },
    lofi:    { note: '0.4 Hz · 피드백 0.55. 테이프가 겹쳐 돌아가는 느낌',
               params: { rateHz: 0.4, depthMs: 2.2, delayMs: 2.5, feedback: 0.55, mix: 40 } },
    ambient: { note: '0.08 Hz · 깊이 3.5 ms. 아주 느리고 아주 깊게',
               params: { rateHz: 0.08, depthMs: 3.5, delayMs: 6, feedback: 0.35, mix: 48 } },
    classic: { note: '6 %. 사실상 쓰지 않는 장치입니다',
               params: { rateHz: 0.1, depthMs: 0.3, delayMs: 5, feedback: 0.05, mix: 6 } },
    kpop:    { note: '딜레이 2 ms 로 금속적으로. 프리코러스 전환에',
               params: { rateHz: 0.5, depthMs: 1.5, delayMs: 2, feedback: 0.5, mix: 30 } },
    pop:     { note: '0.3 Hz · 34 %',
               params: { rateHz: 0.3, depthMs: 1.8, delayMs: 3, feedback: 0.45, mix: 34 } },
    edm:     { note: '0.9 Hz · 피드백 0.72. 빌드업에서 오토메이션으로 올리는 자리',
               params: { rateHz: 0.9, depthMs: 2.8, delayMs: 1.2, feedback: 0.72, mix: 46 } },
    hiphop:  { note: '22 %. 훅 한 번에만 스치듯',
               params: { rateHz: 0.25, depthMs: 1.2, delayMs: 3.5, feedback: 0.4, mix: 22 } },
    rnb:     { note: '딜레이 4.5 ms · 피드백 0.3. 금속성 없이 두께만',
               params: { rateHz: 0.2, depthMs: 2, delayMs: 4.5, feedback: 0.3, mix: 26 } },
    jpop:    { note: '0.65 Hz · 피드백 0.6. 짧고 세게',
               params: { rateHz: 0.65, depthMs: 1.6, delayMs: 1.8, feedback: 0.6, mix: 32 } },
  }),

  ...genrePresets('phaser', {
    jazz:    { note: '센터 800 Hz · 20 %. 로즈 피아노에 걸던 그 소리',
               params: { rateHz: 0.25, depth: 0.4, centreHz: 800, feedback: 0.2, mix: 20 } },
    lofi:    { note: '센터 600 Hz · 45 %. 낮은 곳에서 흔들려야 탁하게 들립니다',
               params: { rateHz: 0.6, depth: 0.7, centreHz: 600, feedback: 0.5, mix: 45 } },
    ambient: { note: '0.1 Hz · 깊이 0.85 · 55 %. 패드가 스스로 숨쉬는 것처럼',
               params: { rateHz: 0.1, depth: 0.85, centreHz: 1200, feedback: 0.3, mix: 55 } },
    classic: { note: '8 %. 목록에 있으니 값은 채우지만 쓸 일은 없습니다',
               params: { rateHz: 0.15, depth: 0.2, centreHz: 1000, feedback: 0.05, mix: 8 } },
    kpop:    { note: '센터 1.6 kHz — 높은 곳에서 흔들면 밝기를 잃지 않습니다',
               params: { rateHz: 0.8, depth: 0.6, centreHz: 1600, feedback: 0.45, mix: 32 } },
    pop:     { note: '0.5 Hz · 센터 1.2 kHz',
               params: { rateHz: 0.5, depth: 0.55, centreHz: 1200, feedback: 0.4, mix: 36 } },
    edm:     { note: '1.6 Hz · 피드백 0.65. 리드가 회전하는 소리',
               params: { rateHz: 1.6, depth: 0.8, centreHz: 900, feedback: 0.65, mix: 48 } },
    hiphop:  { note: '센터 700 Hz · 24 %. 키보드 루프에만',
               params: { rateHz: 0.35, depth: 0.5, centreHz: 700, feedback: 0.35, mix: 24 } },
    rnb:     { note: '0.3 Hz · 센터 1.4 kHz. 느리고 부드럽게',
               params: { rateHz: 0.3, depth: 0.65, centreHz: 1400, feedback: 0.28, mix: 30 } },
    jpop:    { note: '1.1 Hz · 센터 1.9 kHz. 열 장르 중 가장 높은 곳에서 돕니다',
               params: { rateHz: 1.1, depth: 0.62, centreHz: 1900, feedback: 0.55, mix: 34 } },
  }),

  ...genrePresets('tremolo', {
    jazz:    { note: '4.5 Hz · 깊이 0.3 · 사인. 옛날 앰프의 트레몰로입니다',
               params: { rateHz: 4.5, depth: 0.3, shape: 0.15 } },
    lofi:    { note: '3 Hz · 0.45. 테이프가 늘어난 것처럼 느리게 출렁입니다',
               params: { rateHz: 3, depth: 0.45, shape: 0.35 } },
    ambient: { note: '0.6 Hz · 완전한 사인파. 한 주기가 거의 2 초입니다',
               params: { rateHz: 0.6, depth: 0.25, shape: 0 } },
    classic: { note: '깊이 0.1. 현악의 트레몰로는 연주 기법이지 이펙트가 아닙니다',
               params: { rateHz: 2, depth: 0.1, shape: 0.05 } },
    kpop:    { note: '8 Hz · 셰이프 0.7. 사각파에 가까워 게이트처럼 들립니다',
               params: { rateHz: 8, depth: 0.5, shape: 0.7 } },
    pop:     { note: '6 Hz · 0.4',
               params: { rateHz: 6, depth: 0.4, shape: 0.5 } },
    edm:     { note: '12 Hz · 깊이 0.7 · 셰이프 0.9. 이건 트레몰로가 아니라 게이트입니다',
               params: { rateHz: 12, depth: 0.7, shape: 0.9 } },
    hiphop:  { note: '5 Hz · 셰이프 0.6. 훅의 신스 코드에',
               params: { rateHz: 5, depth: 0.35, shape: 0.6 } },
    rnb:     { note: '3.5 Hz · 깊이 0.32. 로즈에 걸어 흔들리게',
               params: { rateHz: 3.5, depth: 0.32, shape: 0.25 } },
    jpop:    { note: '9 Hz · 0.55. K-POP 보다 한 칸 빠르게',
               params: { rateHz: 9, depth: 0.55, shape: 0.8 } },
  }),

  ...genrePresets('autopan', {
    jazz:    { note: '0.2 Hz · 깊이 0.22. 좌우로 도는 게 아니라 숨쉬는 정도',
               params: { rateHz: 0.2, depth: 0.22 } },
    lofi:    { note: '0.5 Hz · 0.5. 샘플 루프가 좌우로 미끄러집니다',
               params: { rateHz: 0.5, depth: 0.5 } },
    ambient: { note: '0.08 Hz · 0.66. 한 주기가 12 초 — 위치가 바뀐 걸 나중에 알게 됩니다',
               params: { rateHz: 0.08, depth: 0.66 } },
    classic: { note: '깊이 0.1. 오토팬은 마이크가 움직인다는 뜻이고 그건 사고입니다',
               params: { rateHz: 0.12, depth: 0.1 } },
    kpop:    { note: '1.2 Hz · 0.72. 신스 아르페지오에 걸면 스테레오가 살아납니다',
               params: { rateHz: 1.2, depth: 0.72 } },
    pop:     { note: '0.7 Hz · 0.58',
               params: { rateHz: 0.7, depth: 0.58 } },
    edm:     { note: '2.4 Hz · 0.88. 열 장르 중 가장 빠르고 가장 깊습니다',
               params: { rateHz: 2.4, depth: 0.88 } },
    hiphop:  { note: '0.35 Hz · 0.3. 하이햇에만 아주 조금',
               params: { rateHz: 0.35, depth: 0.3 } },
    rnb:     { note: '0.28 Hz · 0.4. 백보컬이 천천히 좌우로 흐릅니다',
               params: { rateHz: 0.28, depth: 0.4 } },
    jpop:    { note: '1.6 Hz · 0.8. 빠르고 깊게, 다만 EDM 만큼은 아니게',
               params: { rateHz: 1.6, depth: 0.8 } },
  }),

  // ══ Imaging ════════════════════════════════════════════════════════════════

  ...genrePresets('widener', {
    jazz:    { note: '1.08× · 로우모노 65 Hz. 마이크가 잡은 폭이 이미 정답에 가깝습니다',
               params: { width: 1.08, lowMonoHz: 65 } },
    lofi:    { note: '0.92× — 유일하게 좁힙니다. 좁을수록 오래된 소리로 들립니다',
               params: { width: 0.92, lowMonoHz: 90 } },
    ambient: { note: '1.6× · 로우모노 40 Hz. 저역까지 넓혀도 되는 유일한 장르',
               params: { width: 1.6, lowMonoHz: 40 } },
    classic: { note: '1.0× · 20 Hz. 스테레오 이미지를 손대지 않습니다',
               params: { width: 1, lowMonoHz: 20 } },
    kpop:    { note: '1.38× · 로우모노 115 Hz. 위는 넓게, 아래는 확실하게 가운데',
               params: { width: 1.38, lowMonoHz: 115 } },
    pop:     { note: '1.3× · 165 Hz',
               params: { width: 1.3, lowMonoHz: 165 } },
    edm:     { note: '1.5× · 로우모노 240 Hz. 저역을 가장 높은 지점까지 모노로 묶습니다',
               params: { width: 1.5, lowMonoHz: 240 } },
    hiphop:  { note: '1.12× · 215 Hz. 넓히기보다 808 을 가운데 고정하는 게 목적입니다',
               params: { width: 1.12, lowMonoHz: 215 } },
    rnb:     { note: '1.24× · 140 Hz. 백보컬은 넓게, 베이스는 가운데',
               params: { width: 1.24, lowMonoHz: 140 } },
    jpop:    { note: '1.34× · 190 Hz',
               params: { width: 1.34, lowMonoHz: 190 } },
  }),

  ...genrePresets('monomaker', {
    jazz:    { note: '60 Hz 아래만 모노. 콘트라베이스의 스테레오감을 남깁니다',
               params: { freqHz: 60, widthPct: 105 } },
    lofi:    { note: '85 Hz · 폭 92 %. 전체적으로 좁혀 오래된 소리에 가깝게',
               params: { freqHz: 85, widthPct: 92 } },
    ambient: { note: '40 Hz. 이 장르는 저역까지 넓어도 됩니다',
               params: { freqHz: 40, widthPct: 140 } },
    classic: { note: '20 Hz — 사실상 아무것도 모노로 만들지 않습니다',
               params: { freqHz: 20, widthPct: 100 } },
    kpop:    { note: '160 Hz. 킥과 베이스를 통째로 가운데로 묶습니다',
               params: { freqHz: 160, widthPct: 132 } },
    pop:     { note: '135 Hz · 124 %',
               params: { freqHz: 135, widthPct: 124 } },
    edm:     { note: '235 Hz — 열 장르 중 가장 높습니다. 클럽 시스템에서 저역이 사라지지 않게',
               params: { freqHz: 235, widthPct: 145 } },
    hiphop:  { note: '210 Hz · 폭 108 %. 808 이 한 점에 모여야 서브가 밀립니다',
               params: { freqHz: 210, widthPct: 108 } },
    rnb:     { note: '110 Hz · 118 %',
               params: { freqHz: 110, widthPct: 118 } },
    jpop:    { note: '185 Hz · 128 %',
               params: { freqHz: 185, widthPct: 128 } },
  }),

  ...genrePresets('haas', {
    jazz:    { note: '8 ms · 0.26. 하스는 위상을 흔듭니다 — 재즈에서는 최소한만',
               params: { delayMs: 8, amount: 0.26 } },
    lofi:    { note: '5 ms · 0.18. 짧고 약하게',
               params: { delayMs: 5, amount: 0.18 } },
    ambient: { note: '26 ms · 0.82. 위상이 무너져도 상관없는 유일한 장르입니다',
               params: { delayMs: 26, amount: 0.82 } },
    classic: { note: '0 ms · 0.05. 끄고 쓰세요',
               params: { delayMs: 0, amount: 0.05 } },
    kpop:    { note: '12 ms · 0.58. 백보컬 더블에. 모노 호환은 반드시 확인하세요',
               params: { delayMs: 12, amount: 0.58 } },
    pop:     { note: '14 ms · 0.5',
               params: { delayMs: 14, amount: 0.5 } },
    edm:     { note: '22 ms · 0.74. 신스 레이어를 벌리는 용도',
               params: { delayMs: 22, amount: 0.74 } },
    hiphop:  { note: '6 ms · 0.34. 저역에 걸면 모노에서 808 이 사라집니다',
               params: { delayMs: 6, amount: 0.34 } },
    rnb:     { note: '18 ms · 0.66. 애드립 스택 전용',
               params: { delayMs: 18, amount: 0.66 } },
    jpop:    { note: '11 ms · 0.42. 짧게 벌려 파트가 겹쳐도 구분되게',
               params: { delayMs: 11, amount: 0.42 } },
  }),

  // ══ Restore ════════════════════════════════════════════════════════════════

  ...genrePresets('denoise', {
    jazz:    { note: '−58 dB · 0.25. 방 소리를 지우면 연주가 어디 있었는지 사라집니다',
               params: { thresholdDb: -58, amount: 0.25, releaseMs: 160 } },
    lofi:    { note: '0.08 — 거의 끕니다. 히스는 이 장르에서 지울 대상이 아닙니다',
               params: { thresholdDb: -70, amount: 0.08, releaseMs: 220 } },
    ambient: { note: '릴리즈 320 ms. 노이즈 게이트처럼 열고 닫히면 안 됩니다',
               params: { thresholdDb: -62, amount: 0.2, releaseMs: 320 } },
    classic: { note: '−66 dB · 0.15. 홀의 정적도 녹음의 일부입니다',
               params: { thresholdDb: -66, amount: 0.15, releaseMs: 260 } },
    kpop:    { note: '−46 dB · 0.5. 트랙이 많을수록 바닥 잡음이 합산됩니다',
               params: { thresholdDb: -46, amount: 0.5, releaseMs: 90 } },
    pop:     { note: '−50 dB · 0.42',
               params: { thresholdDb: -50, amount: 0.42, releaseMs: 120 } },
    edm:     { note: '−42 dB · 0.55. 합성음에는 지울 잡음이 원래 없어야 합니다',
               params: { thresholdDb: -42, amount: 0.55, releaseMs: 70 } },
    hiphop:  { note: '−48 dB · 0.34. 샘플에 딸려온 잡음만 걷어냅니다',
               params: { thresholdDb: -48, amount: 0.34, releaseMs: 100 } },
    rnb:     { note: '−54 dB · 0.3 · 릴리즈 180 ms',
               params: { thresholdDb: -54, amount: 0.3, releaseMs: 180 } },
    jpop:    { note: '−40 dB · 0.66. 열 장르 중 가장 공격적입니다 — 트랙 수가 가장 많습니다',
               params: { thresholdDb: -40, amount: 0.66, releaseMs: 65 } },
  }),

  ...genrePresets('hum', {
    jazz:    { note: '60 Hz · 배음 5. 앰프와 진공관 장비에서 올라오는 험',
               params: { baseHz: 60, harmonics: 5, q: 34 } },
    lofi:    { note: '50 Hz · 배음 3 · Q 22. 넓게 잡아 웅웅거림만 걷어냅니다',
               params: { baseHz: 50, harmonics: 3, q: 22 } },
    ambient: { note: '배음 2 · Q 44. 좁게 두 개만 — 패드의 저역을 건드리면 안 됩니다',
               params: { baseHz: 60, harmonics: 2, q: 44 } },
    classic: { note: '50 Hz · 배음 6 · Q 48. 가장 좁고 가장 깊게, 홀 음색은 그대로',
               params: { baseHz: 50, harmonics: 6, q: 48 } },
    kpop:    { note: '60 Hz · 배음 4 · Q 28',
               params: { baseHz: 60, harmonics: 4, q: 28 } },
    pop:     { note: '60 Hz · 배음 3 · Q 30',
               params: { baseHz: 60, harmonics: 3, q: 30 } },
    edm:     { note: '50 Hz · 배음 2 · Q 18. 서브와 겹치니 최소한만 건드립니다',
               params: { baseHz: 50, harmonics: 2, q: 18 } },
    hiphop:  { note: '60 Hz · 배음 6. 샘플 소스가 낡을수록 배음이 위까지 올라옵니다',
               params: { baseHz: 60, harmonics: 6, q: 26 } },
    rnb:     { note: '50 Hz · 배음 5 · Q 38',
               params: { baseHz: 50, harmonics: 5, q: 38 } },
    jpop:    { note: '50 Hz · 배음 4 · Q 32',
               params: { baseHz: 50, harmonics: 4, q: 32 } },
  }),

  // ══ Pitch ══════════════════════════════════════════════════════════════════

  ...genrePresets('pitchcorrect', {
    jazz:    { note: '0.18. 재즈 보컬의 피치는 표현입니다 — 고치면 연주가 사라집니다',
               params: { amount: 0.18, formant: 0 } },
    lofi:    { note: '0.48 · 포먼트 −1.2. 살짝 어긋난 채로 고쳐야 로파이답습니다',
               params: { amount: 0.48, formant: -1.2 } },
    ambient: { note: '0.26 · 포먼트 +0.6. 목소리를 악기처럼 띄웁니다',
               params: { amount: 0.26, formant: 0.6 } },
    classic: { note: '0.1. 성악에 피치 보정은 논외입니다',
               params: { amount: 0.1, formant: -0.3 } },
    kpop:    { note: '0.9 · 포먼트 +1.2. 완전히 붙이고 톤을 밝게 올립니다',
               params: { amount: 0.9, formant: 1.2 } },
    pop:     { note: '0.62 · +0.3',
               params: { amount: 0.62, formant: 0.3 } },
    edm:     { note: '0.98 — 최대치. 이 장르에서 보컬은 신스입니다',
               params: { amount: 0.98, formant: 2 } },
    hiphop:  { note: '0.7 · 포먼트 −0.6. 낮게 깔리는 톤을 유지한 채로 붙입니다',
               params: { amount: 0.7, formant: -0.6 } },
    rnb:     { note: '0.4 · +0.9. 멜리스마가 살아야 하니 절반만 붙입니다',
               params: { amount: 0.4, formant: 0.9 } },
    jpop:    { note: '0.82 · 포먼트 +1.5. 열 장르 중 포먼트를 가장 높이 올립니다',
               params: { amount: 0.82, formant: 1.5 } },
  }),

  // ══ Master ═════════════════════════════════════════════════════════════════

  ...genrePresets('loudness', {
    jazz:    { note: '−16 LUFS. 다이내믹을 남기는 대신 크기를 포기합니다',
               params: { targetLufs: -16 } },
    lofi:    { note: '−14 LUFS. 어둡되 작지는 않습니다',
               params: { targetLufs: -14 } },
    ambient: { note: '−17 LUFS. 조용한 구간이 정말 조용해야 합니다',
               params: { targetLufs: -17 } },
    classic: { note: '−20 LUFS. 다이내믹 레인지 자체가 이 녹음의 내용입니다',
               params: { targetLufs: -20 } },
    kpop:    { note: '−8.5 LUFS. 스트리밍 정규화를 감수하고 밀어붙이는 쪽',
               params: { targetLufs: -8.5 } },
    pop:     { note: '−10.5 LUFS. 크되 정규화 후에도 손해가 적은 지점',
               params: { targetLufs: -10.5 } },
    edm:     { note: '−8 LUFS. 열 장르 중 가장 큽니다',
               params: { targetLufs: -8 } },
    hiphop:  { note: '−9.5 LUFS. 808 이 라우드니스를 다 먹으니 이 위로는 잘 안 올라갑니다',
               params: { targetLufs: -9.5 } },
    rnb:     { note: '−11.5 LUFS. 팝보다 한 칸 조용하게 — 목소리의 셈여림이 들려야 합니다',
               params: { targetLufs: -11.5 } },
    jpop:    { note: '−9 LUFS. K-POP 과 EDM 사이 — 밀도가 이미 높아 더 올릴 여지가 없습니다',
               params: { targetLufs: -9 } },
  }),
];
