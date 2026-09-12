// Factory patches — the instruments' presets.
//
// Until now the drum kit was the only instrument in the app with presets, and
// the only thing anywhere that wrote `instrumentParams` at all: every other
// instrument ran on its defaults, and none of their parameters were reachable
// from the UI.  So "one sound per instrument" was not a figure of speech.
//
// A patch here is a set of OVERRIDES, not a full parameter dump.  Two reasons,
// and the second is the one that matters:
//
//   · what a patch says about itself is then readable — `{ voices: 7, detune:
//     26, attack: 1.2 }` is a wide slow pad, where twenty-one numbers would
//     have to be diffed against the defaults to see that
//   · a parameter added later lands at its default in every existing patch
//     rather than at whatever value was frozen into it
//
// WHICH patch a track is on is DERIVED, never stored.  The kit stores an index
// and carries a comment worrying about what happens if the genre order ever
// shifts; this avoids that question rather than answering it.  Comparing the
// track's parameters against each patch costs nothing, survives save, undo,
// freeze and bounce for free because they already carry the parameters, and
// cannot go stale — the moment the user moves a knob the answer becomes "편집
// 됨", which is the truth and which stored state would have had to be told.
//
// That derivation is only unambiguous if no two patches of an instrument hold
// the same numbers, which is exactly what `instrument-patches-selftest.ts`
// asserts.  A duplicated patch would not merely be a dull menu entry; it would
// make this function's answer arbitrary.
//
// A patch may trim `level` DOWN and never up.  Level is calibrated (see
// instrument-level.ts) and 0.7 is where an instrument sits on target; a patch
// that pushed past it would spend the headroom the calibration exists to
// guarantee, and picking a sound would be a level change again.  Trimming
// down is the opposite case and a real need: a patch can be brighter or
// denser than the default it was measured against, and then it peaks higher
// playing the same notes.  That is what the trim is for, and the rendered
// check is what says whether it was needed.

import { defaultInstrumentParams, findInstrument } from './instruments.js';

export const PATCH_CATEGORIES = [
  'init', 'bass', 'lead', 'pad', 'pluck', 'keys', 'brass', 'organ', 'fx', 'guitar',
] as const;
export type PatchCategory = typeof PATCH_CATEGORIES[number];

export const CATEGORY_LABEL: Readonly<Record<PatchCategory, string>> = {
  init: '기본', bass: '베이스', lead: '리드', pad: '패드', pluck: '플럭',
  keys: '키보드', brass: '브라스', organ: '오르간', fx: 'FX', guitar: '기타',
};

export interface InstrumentPatch {
  /** Unique within its instrument. */
  id: string;
  name: string;
  category: PatchCategory;
  /** One line: what it is, and what it is for.  Shown beside the picker. */
  note: string;
  /** Only what differs from the instrument's defaults. */
  params: Readonly<Record<string, number>>;
}

// ── Poly Synth ───────────────────────────────────────────────────────────────
//
// The instrument with the most to say, now that it has a filter envelope, a
// stack and a shape to choose.  The categories below are the ones a subtractive
// synth actually divides into — which is also a check on the engine: a bank
// that cannot make a convincing pad is a bank missing a slow filter envelope.

const POLY: InstrumentPatch[] = [
  { id: 'init', name: 'Init Saw', category: 'init',
    note: '두 대의 톱니와 고정 필터 — 무엇이든 여기서 시작합니다',
    params: {} },

  { id: 'sub-bass', name: 'Sub Bass', category: 'bass',
    note: '서브가 음을 만들고 필터는 거의 닫혀 있습니다 — 킥 밑에 깔립니다',
    params: { voices: 1, sub: 1, cutoffHz: 400, keyTrack: 0.3, fegAmount: 1.5,
      fegDecay: 0.25, attack: 0.001, decay: 0.3, sustain: 0.4, release: 0.08 } },
  { id: 'acid', name: 'Acid Line', category: 'bass',
    note: '레조넌스를 세우고 엔벨로프로 쓸어내립니다 — 303 계열',
    params: { voices: 1, cutoffHz: 300, resonance: 9, keyTrack: 0.4, fegAmount: 3.5,
      fegDecay: 0.28, attack: 0.001, decay: 0.2, sustain: 0.2, release: 0.06, drive: 0.55 } },
  { id: 'reese', name: 'Reese Bass', category: 'bass',
    note: '넓게 디튠한 다섯 대가 서로 맥놀이합니다 — 드럼앤베이스의 그 소리',
    params: { voices: 5, detune: 28, sub: 0.4, cutoffHz: 700, fegAmount: 1,
      fegDecay: 0.6, sustain: 0.9, release: 0.15, drive: 0.3 } },
  { id: 'pluck-bass', name: 'Pluck Bass', category: 'bass',
    note: '사각파에 짧은 필터 엔벨로프 — 손가락으로 튕긴 것처럼 끊깁니다',
    params: { wave: 1, voices: 1, sub: 0.6, cutoffHz: 900, fegAmount: 2.5,
      fegDecay: 0.12, attack: 0.001, decay: 0.12, sustain: 0.15, release: 0.07 } },

  { id: 'saw-lead', name: 'Saw Lead', category: 'lead',
    note: '세 대를 살짝 벌리고 키트랙을 걸었습니다 — 높이 올라가도 흐려지지 않습니다',
    params: { voices: 3, detune: 14, cutoffHz: 4200, keyTrack: 0.6, fegAmount: 1.2,
      fegDecay: 0.5, sustain: 0.8, release: 0.2, drive: 0.25 } },
  { id: 'square-lead', name: 'Square Lead', category: 'lead',
    note: '사각파에 비브라토 — 길게 끄는 음에서 살아납니다',
    params: { wave: 1, detune: 6, cutoffHz: 3200, keyTrack: 0.5,
      sustain: 0.85, release: 0.18, lfoRate: 5.5, lfoPitch: 25 } },
  { id: 'pwm-lead', name: 'PWM Lead', category: 'lead',
    note: '좁은 펄스에 느린 필터 흔들림 — 가만히 있어도 소리가 움직입니다',
    params: { wave: 2, pulseWidth: 0.16, detune: 10, cutoffHz: 3600,
      sustain: 0.8, lfoRate: 0.8, lfoFilter: 0.6, drive: 0.2 } },
  { id: 'hard-lead', name: 'Hard Lead', category: 'lead',
    note: '가장 좁은 펄스 네 대를 드라이브로 밀었습니다 — 믹스를 뚫고 나옵니다',
    params: { wave: 2, pulseWidth: 0.1, voices: 4, detune: 18, cutoffHz: 5200,
      resonance: 3, fegAmount: 1.6, fegDecay: 0.3, sustain: 0.75, drive: 0.7 } },

  { id: 'warm-pad', name: 'Warm Pad', category: 'pad',
    note: '느리게 열리는 필터 — 코드가 다 울린 뒤에야 밝아집니다',
    params: { voices: 5, detune: 20, cutoffHz: 1800, keyTrack: 0.4, fegAmount: 1.2,
      fegAttack: 0.9, fegDecay: 2.5, attack: 0.7, decay: 1.2, sustain: 0.8, release: 1.8 } },
  { id: 'glass-pad', name: 'Glass Pad', category: 'pad',
    note: '삼각파라 배음이 적고, LFO 가 그 위를 천천히 씻어냅니다',
    params: { wave: 3, voices: 5, detune: 16, cutoffHz: 5200, attack: 0.9,
      sustain: 0.85, release: 2.4, lfoRate: 0.5, lfoFilter: 0.8 } },
  { id: 'dark-pad', name: 'Dark Pad', category: 'pad',
    note: '일곱 대에 서브까지 — 넓고 어둡고, 릴리스가 3초입니다',
    params: { voices: 7, detune: 26, sub: 0.35, cutoffHz: 700, resonance: 2,
      fegAmount: 0.8, fegAttack: 1.5, fegDecay: 3, attack: 1.2, sustain: 0.9, release: 3 } },
  { id: 'air-pad', name: 'Air Pad', category: 'pad',
    note: '노이즈를 섞어 바람 소리를 냅니다 — 배경에 깔아두는 용도',
    params: { wave: 3, voices: 3, detune: 12, noise: 0.35, cutoffHz: 3800,
      attack: 1.4, sustain: 0.7, release: 2.8, lfoRate: 0.35, lfoFilter: 0.5 } },

  { id: 'synth-pluck', name: 'Synth Pluck', category: 'pluck',
    note: '필터가 순식간에 닫힙니다 — 아르페지오에 쓰는 소리',
    params: { detune: 10, cutoffHz: 2400, keyTrack: 0.7, fegAmount: 2.2,
      fegDecay: 0.18, attack: 0.001, decay: 0.22, sustain: 0.05, release: 0.25 } },
  { id: 'bell', name: 'Bell', category: 'pluck',
    note: '사인파를 드라이브로 깎아 배음을 만듭니다 — 서스테인 없이 길게 감쇠',
    params: { wave: 4, detune: 4, cutoffHz: 9000, attack: 0.001,
      decay: 1.1, sustain: 0, release: 1.2, drive: 0.35 } },
  { id: 'stab', name: 'Chord Stab', category: 'pluck',
    note: '짧고 날카롭게 — 코드를 찍는 용도라 서스테인이 0 입니다',
    params: { wave: 2, pulseWidth: 0.3, voices: 3, detune: 12, cutoffHz: 2600,
      resonance: 4, fegAmount: 2, fegDecay: 0.14, attack: 0.004, decay: 0.16,
      sustain: 0, release: 0.12, drive: 0.3 } },

  { id: 'synth-brass', name: 'Synth Brass', category: 'brass',
    note: '필터가 어택보다 느리게 열립니다 — 관악기의 그 밀려오는 느낌',
    params: { voices: 3, detune: 9, cutoffHz: 1600, keyTrack: 0.5, fegAmount: 2,
      fegAttack: 0.08, fegDecay: 0.9, attack: 0.05, sustain: 0.8, release: 0.25, drive: 0.3 } },
  { id: 'organ', name: 'Organ', category: 'organ',
    note: '엔벨로프가 없는 것이나 마찬가지 — 누르면 나고 떼면 멎습니다',
    params: { wave: 1, detune: 2, sub: 0.7, cutoffHz: 6000,
      attack: 0.004, decay: 0.02, sustain: 1, release: 0.06 } },

  { id: 'noise-sweep', name: 'Noise Sweep', category: 'fx',
    note: '노이즈만 남기고 필터를 2 초에 걸쳐 엽니다 — 드롭 앞에 까는 것',
    params: { wave: 3, voices: 1, noise: 1, cutoffHz: 300, resonance: 6,
      fegAmount: 5, fegAttack: 1.6, fegDecay: 1.8, attack: 1.2, sustain: 1, release: 1.5 } },
  { id: 'siren', name: 'Siren', category: 'fx',
    note: '비브라토를 끝까지 올렸습니다 — 음정이 아니라 효과음입니다',
    params: { voices: 1, cutoffHz: 4000, lfoRate: 0.7, lfoPitch: 100,
      sustain: 1, release: 0.3, drive: 0.4 } },
];

// ── Rhodes (FM) ──────────────────────────────────────────────────────────────
//
// Two numbers do most of the work here — the FM ratio and the index — and the
// rest is what the instrument is made of: how hard the tine is struck, how
// much pickup asymmetry, whether the suitcase tremolo is running.

const EPIANO: InstrumentPatch[] = [
  { id: 'init', name: 'Init Rhodes', category: 'init',
    note: '기본 로즈 — 트레몰로 없이, 중간 세기의 바크',
    params: {} },
  { id: 'suitcase', name: 'Suitcase', category: 'keys',
    note: '트레몰로가 도는 수트케이스 — 코드를 길게 누를 때 살아납니다',
    params: { decay: 2.2, bark: 0.55, tine: 0.45, pickup: 0.3, tremRate: 5.2, tremDepth: 0.5 } },
  { id: 'stage-bark', name: 'Stage Bark', category: 'keys',
    note: '세게 치면 짖습니다 — 인덱스를 올려 벨로시티가 음색을 크게 바꿉니다',
    params: { index: 5.2, decay: 1.4, bark: 1, tine: 0.7, pickup: 0.55 } },
  { id: 'mellow', name: 'Mellow Tine', category: 'keys',
    note: '바크를 거의 죽였습니다 — 발라드에서 노래를 가리지 않습니다',
    params: { index: 1.8, decay: 2.6, release: 0.5, bark: 0.25, tine: 0.3, pickup: 0.15 } },
  { id: 'wurly', name: 'Wurlitzer', category: 'keys',
    note: '2:1 비율이라 더 갈대 같은 소리 — 로즈가 아니라 울리처 쪽',
    params: { ratio: 2, index: 4.2, decay: 1.1, bark: 0.8, tine: 0.25, pickup: 0.7,
      tremRate: 6.5, tremDepth: 0.6 } },
  { id: 'dark-rhodes', name: 'Dark Rhodes', category: 'keys',
    note: '비율을 내리고 길게 울립니다 — 왼손 코드용',
    params: { ratio: 1.5, index: 2.2, decay: 3.2, release: 0.8, bark: 0.35,
      tine: 0.2, pickup: 0.2 } },
  { id: 'bright-comp', name: 'Bright Comp', category: 'keys',
    note: '짧고 밝게 — 컴핑할 때 코드가 서로 뭉치지 않습니다',
    params: { ratio: 4, index: 4.8, decay: 1, release: 0.25, bark: 0.75,
      tine: 0.8, pickup: 0.6 } },
  { id: 'fm-bell', name: 'FM Bell', category: 'pluck',
    note: '7:1 의 비조화 배음 — 로즈가 아니라 종입니다',
    params: { ratio: 7, index: 6.5, decay: 4.5, release: 1.6, bark: 0.4,
      tine: 0.9, pickup: 0.1 } },
  { id: 'clav', name: 'Clav', category: 'keys',
    note: '인덱스와 픽업을 끝까지 — 금속성이고 짧습니다',
    params: { ratio: 6, index: 7, decay: 0.35, release: 0.08, bark: 1,
      tine: 0.75, pickup: 1 } },
  { id: 'marimba', name: 'Marimba', category: 'pluck',
    note: '배음이 거의 없는 순한 FM — 나무를 때린 소리에 가깝습니다',
    params: { index: 1.1, decay: 0.5, release: 0.12, bark: 0.3,
      tine: 0.08, pickup: 0.02 } },

  // The corners the first ten left empty.  Two operators is not many, but
  // the RATIO is where almost all of an FM instrument's identity lives, and
  // the bank above only ever used 1.5 to 7 — integers mostly, which is the
  // half of the space that sounds like a piano.  Below 1 the modulator is
  // sub-harmonic and growls; a half-integer is inharmonic and rings like
  // metal; a high ratio with a LOW index is a bell rather than a bark.
  { id: 'sub-rhodes', name: 'Sub Rhodes', category: 'keys',
    note: '모듈레이터가 음보다 한 옥타브 아래 — 으르렁거리는 로즈',
    params: { ratio: 0.5, index: 4, decay: 2.4, release: 0.5, bark: 0.6,
      tine: 0.2, pickup: 0.45 } },
  { id: 'dyno', name: 'Dyno', category: 'keys',
    note: '타인을 끝까지 올린 개조 로즈 — 80년대 발라드의 그 반짝임',
    params: { index: 6.5, decay: 1.8, release: 0.4, bark: 0.85,
      tine: 1, pickup: 0.5 } },
  { id: 'tremolo-wide', name: 'Wide Tremolo', category: 'keys',
    note: '느리고 깊은 트레몰로 — 수트케이스보다 훨씬 넓게 흔듭니다',
    params: { index: 2.6, decay: 3, bark: 0.5, pickup: 0.4,
      tremRate: 2.2, tremDepth: 0.95 } },
  { id: 'soft-keys', name: 'Soft Keys', category: 'keys',
    note: '인덱스를 거의 0 으로 — 배음이 없어 노래 뒤에 숨습니다',
    params: { ratio: 2, index: 1.3, decay: 5.5, release: 2.6, bark: 0.15,
      tine: 0.05, pickup: 0.25 } },
  { id: 'metal-tine', name: 'Metal Tine', category: 'keys',
    note: '인덱스와 픽업을 함께 올렸습니다 — 금속을 때린 쪽에 가깝습니다',
    params: { ratio: 3.5, index: 8.5, decay: 1, release: 0.15, bark: 0.75,
      tine: 1, pickup: 0.95 } },
  { id: 'harpsi', name: 'Harpsichord', category: 'keys',
    note: '짧고 날카롭게 뜯긴 소리 — 릴리스가 0.06 초입니다',
    params: { ratio: 4.5, index: 5.5, decay: 0.75, release: 0.06, bark: 0.95,
      tine: 0.9, pickup: 0.75 } },
  { id: 'fm-bass', name: 'FM Bass', category: 'bass',
    note: '1:1 비율에 픽업을 세게 — 왼손으로 치는 베이스',
    // Trimmed: a 1:1 ratio driven into the pickup is the densest thing this
    // instrument makes, and it came out 10 dB above the calibrated init.
    params: { ratio: 1, index: 3.5, decay: 0.8, release: 0.12, bark: 0.5,
      tine: 0.05, pickup: 0.9, level: 0.4 } },
  { id: 'glass-keys', name: 'Glass Keys', category: 'pluck',
    note: '5.5 라는 반정수 비율을 짧게 끊습니다 — 배음이 어긋난 채로 사라집니다',
    params: { ratio: 5.5, index: 3.8, decay: 1.2, release: 0.3, bark: 0.55,
      tine: 0.25, pickup: 0.2 } },
  { id: 'tubular', name: 'Tubular', category: 'pluck',
    note: '높은 비율에 낮은 인덱스 — 짖지 않고 종처럼 오래 남습니다',
    params: { ratio: 7.5, index: 1.6, decay: 5.5, release: 2.2, bark: 0.15,
      tine: 0.85, pickup: 0.03 } },
  { id: 'celeste', name: 'Celeste', category: 'pluck',
    note: '가장 높은 비율에 거의 없는 인덱스 — 작고 맑은 종',
    params: { ratio: 8, index: 0.8, decay: 2, release: 0.6, bark: 0.1,
      tine: 0.3, pickup: 0.02 } },
];

// ── The guitars ──────────────────────────────────────────────────────────────
//
// Fewer parameters, so fewer patches: what a plucked string has to say is the
// body resonance, how bright it starts, where it was picked and how long it
// rings.  Padding this out with near-copies would be worse than a short list.

const AGTR: InstrumentPatch[] = [
  { id: 'init', name: 'Init Steel', category: 'init',
    note: '기본 스틸 스트링',
    params: {} },
  { id: 'dreadnought', name: 'Dreadnought', category: 'guitar',
    note: '큰 통 — 공기 공명이 95 Hz 까지 내려가고 오래 울립니다',
    params: { damp: 0.9975, bright: 0.9, pick: 0.16, bodyHz: 95, bodyQ: 1.4,
      body: 11, plate: 5, sustain: 5, release: 0.22 } },
  { id: 'nylon', name: 'Nylon', category: 'guitar',
    note: '나일론은 어두운 스틸이 아니라 다른 줄입니다 — 고음이 적게 시작해 빨리 죽습니다',
    params: { damp: 0.9925, bright: 0.45, pick: 0.3, bodyHz: 125, bodyQ: 1,
      body: 4, plate: 3, tone: 4200, sustain: 2.6, release: 0.25 } },
  { id: 'parlour', name: 'Parlour', category: 'guitar',
    note: '작은 통이라 공명이 높고 좁습니다 — 노래 밑에 깔기 좋습니다',
    params: { damp: 0.994, bright: 0.8, pick: 0.2, bodyHz: 140, bodyQ: 2.2,
      body: 2, plate: 6, tone: 6000, sustain: 2, release: 0.14 } },
  { id: 'fingerpick', name: 'Bright Fingerpick', category: 'guitar',
    note: '브리지 가까이서 손톱으로 — 아르페지오에서 음이 또렷합니다',
    // Trimmed: picking this close to the bridge peaks above the body the
    // instrument was calibrated on, and that would spend the headroom
    // rather than use it.
    params: { damp: 0.998, bright: 0.95, pick: 0.05, body: 4, plate: 2,
      tone: 12000, sustain: 4.5, release: 0.15, level: 0.5 } },
  { id: 'twelve', name: '12-String', category: 'guitar',
    note: '코스마다 줄이 둘 — EQ 로는 흉내 낼 수 없는 맥놀이가 생깁니다',
    params: { double: 0.9, damp: 0.997, bright: 0.9, bodyHz: 105, body: 8,
      plate: 4, tone: 9000, sustain: 4.5, release: 0.2, level: 0.6 } },
  { id: 'resonator', name: 'Resonator', category: 'guitar',
    note: '나무가 아니라 금속 콘 — 공명이 300 Hz 로 올라가고 날카롭습니다',
    params: { damp: 0.992, bright: 1, pick: 0.08, bodyHz: 300, bodyQ: 4.5,
      body: 10, plate: 8, tone: 11000, sustain: 1.8, release: 0.1 } },
  { id: 'muted-thumb', name: 'Muted Thumb', category: 'guitar',
    note: '손바닥으로 막고 엄지로 — 줄 자체가 빨리 죽습니다',
    params: { damp: 0.985, bright: 0.6, pick: 0.25, body: 6, tone: 3500,
      sustain: 0.7, release: 0.05 } },
  { id: 'baritone-ac', name: 'Deep Body', category: 'guitar',
    note: '두꺼운 줄에 큰 통 — 고음이 거의 없이 7 초를 웁니다',
    params: { damp: 0.9992, bright: 0.3, pick: 0.42, bodyHz: 88, bodyQ: 3,
      body: 12, plate: 9, tone: 2600, sustain: 7, release: 0.3, level: 0.62 } },
];

const EGTR: InstrumentPatch[] = [
  { id: 'init', name: 'Init Electric', category: 'init',
    note: '기본 일렉 — 앰프 없이, 인서트 체인에서 만드세요',
    params: {} },
  { id: 'clean-strat', name: 'Clean Strat', category: 'guitar',
    note: '싱글코일 — 픽업 공명이 3.4 kHz 라 얇고 맑습니다',
    params: { damp: 0.9989, bright: 0.8, pick: 0.07, bodyHz: 3400, bodyQ: 2.2,
      body: 4, tone: 4800, sustain: 5.5, release: 0.12 } },
  { id: 'jazz-box', name: 'Jazz Box', category: 'guitar',
    note: '넥 픽업을 1.4 kHz 에 두고 줄도 어둡게 — 재즈 컴핑용',
    params: { damp: 0.9975, bright: 0.4, pick: 0.3, bodyHz: 1400, bodyQ: 1.2,
      body: 8, tone: 1800, sustain: 4, release: 0.2 } },
  { id: 'tele-twang', name: 'Tele Twang', category: 'guitar',
    note: '브리지에서 바짝, 픽업 공명은 좁고 높게 — 컨트리의 그 팅 소리',
    params: { damp: 0.9991, bright: 0.95, pick: 0.035, bodyHz: 3800, bodyQ: 3,
      tone: 6200, sustain: 4.5, release: 0.08 } },
  { id: 'humbucker', name: 'Humbucker', category: 'guitar',
    note: '공명이 낮고 넓습니다 — 두껍고, 드라이브 앞단으로 보내세요',
    params: { damp: 0.9992, bright: 0.55, pick: 0.14, bodyHz: 1900, bodyQ: 1.1,
      body: 10, tone: 2600, sustain: 6.5, release: 0.15 } },
  { id: 'p90', name: 'P-90', category: 'guitar',
    note: '싱글과 험버커 사이 — 중음이 있고 고음이 살아 있습니다',
    params: { damp: 0.999, bright: 0.62, pick: 0.1, bodyHz: 2600, bodyQ: 1.8,
      body: 8, tone: 3800, sustain: 5.5, release: 0.13 } },
  { id: 'chorus-clean', name: 'Chorus Clean', category: 'guitar',
    note: '줄을 겹쳐 흔들리게 — 코러스 페달 없이 나는 그 소리',
    params: { double: 0.85, damp: 0.9989, bright: 0.8, bodyHz: 3200, bodyQ: 2,
      body: 5, tone: 5200, sustain: 4.2, release: 0.14, level: 0.6 } },
  { id: 'baritone', name: 'Baritone', category: 'guitar',
    note: '가장 어둡고 가장 깁니다 — 리프를 낮게 깔 때',
    params: { damp: 0.9994, bright: 0.35, pick: 0.2, bodyHz: 1200, bodyQ: 1.4,
      body: 9, tone: 1600, sustain: 7.5, release: 0.22 } },
  { id: 'glass-bell', name: 'Glass Bell', category: 'guitar',
    note: '브리지 바로 위 + 4 kHz 공명 — 종에 가까운 하모닉',
    params: { damp: 0.9997, bright: 1, pick: 0.03, bodyHz: 4000, bodyQ: 5.5,
      body: 12, plate: 9, tone: 12000, sustain: 8, release: 0.35, level: 0.45 } },
  { id: 'palm-mute', name: 'Palm Mute', category: 'guitar',
    note: '손바닥으로 막은 것 — 줄이 0.6 초면 끝납니다',
    params: { damp: 0.982, bright: 0.6, pick: 0.12, body: 4, tone: 3000,
      sustain: 0.6, release: 0.05 } },
];

export const INSTRUMENT_PATCHES: Readonly<Record<string, readonly InstrumentPatch[]>> = {
  polysynth: POLY,
  epiano: EPIANO,
  agtr: AGTR,
  egtr: EGTR,
  // The kit has its own preset system — eleven genre kits, which are a patch
  // per DRUM rather than per instrument.  The sampler has none because its
  // sound is the file the user dropped in.
};

export function patchesFor(instrumentId: string): readonly InstrumentPatch[] {
  return INSTRUMENT_PATCHES[instrumentId] ?? [];
}

export function findPatch(instrumentId: string, patchId: string): InstrumentPatch | undefined {
  return patchesFor(instrumentId).find((p) => p.id === patchId);
}

/**
 * The full parameter set a patch means — its overrides over the defaults.
 *
 * Whole rather than merged into whatever was there, for the reason the kit
 * picker gives: a preset is a set of decisions, and half of one laid over half
 * of another is a sound nobody designed.
 */
export function patchParams(instrumentId: string, patchId: string): Record<string, number> {
  const patch = findPatch(instrumentId, patchId);
  return { ...defaultInstrumentParams(instrumentId), ...(patch?.params ?? {}) };
}

/**
 * Which patch these parameters are, or null for "편집됨".
 *
 * Compared on the instrument's own parameter list, so a stray key left in a
 * session by an older build cannot make every patch look edited.
 */
export function activePatch(
  instrumentId: string, params: Readonly<Record<string, number>>,
): InstrumentPatch | null {
  const instrument = findInstrument(instrumentId);
  if (!instrument) return null;
  const effective = { ...defaultInstrumentParams(instrumentId), ...params };
  for (const patch of patchesFor(instrumentId)) {
    const want = patchParams(instrumentId, patch.id);
    if (instrument.params.every((p) => effective[p.id] === want[p.id])) return patch;
  }
  return null;
}

/** Categories an instrument's patches actually use, in PATCH_CATEGORIES order. */
export function categoriesFor(instrumentId: string): PatchCategory[] {
  const used = new Set(patchesFor(instrumentId).map((p) => p.category));
  return PATCH_CATEGORIES.filter((c) => used.has(c));
}
