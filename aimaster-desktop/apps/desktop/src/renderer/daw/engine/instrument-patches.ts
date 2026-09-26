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
    params: { decay: 2.6, bark: 0.55, tine: 0.45, pickup: 0.22, tremRate: 5.6, tremDepth: 0.72 } },
  { id: 'stage-bark', name: 'Stage Bark', category: 'keys',
    note: '세게 치면 짖습니다 — 바크를 끝까지 올려 벨로시티가 음색을 크게 바꿉니다',
    params: { index: 6.8, decay: 1.9, release: 0.4, bark: 1, tine: 0.6, pickup: 0.5 } },
  { id: 'mellow', name: 'Mellow Tine', category: 'keys',
    note: '바크를 거의 죽이고 2.2:1 로 살짝 어긋냈습니다 — 발라드에서 노래를 가리지 않습니다',
    params: { ratio: 2.2, index: 0.8, decay: 4, release: 1.4, bark: 0.12, tine: 0.22,
      pickup: 0.1 } },
  { id: 'wurly', name: 'Wurlitzer', category: 'keys',
    note: '2:1 비율이라 더 갈대 같은 소리 — 로즈가 아니라 울리처 쪽',
    params: { ratio: 2, index: 4.2, decay: 1.1, bark: 0.8, tine: 0.25, pickup: 0.7,
      tremRate: 6.5, tremDepth: 0.6 } },
  { id: 'dark-rhodes', name: 'Dark Rhodes', category: 'keys',
    note: '비율을 내리고 길게 울립니다 — 왼손 코드용',
    params: { ratio: 1.5, index: 2.2, decay: 3.2, release: 0.8, bark: 0.35,
      tine: 0.2, pickup: 0.2 } },
  { id: 'bright-comp', name: 'Bright Comp', category: 'keys',
    note: '4:1 에 트레몰로를 빠르게 — 컴핑할 때 코드가 서로 뭉치지 않습니다',
    params: { ratio: 4, index: 2.8, decay: 2, release: 0.55, bark: 0.6,
      tine: 0.8, pickup: 0.5, tremRate: 7.6, tremDepth: 0.6 } },
  { id: 'fm-bell', name: 'FM Bell', category: 'pluck',
    note: '7:1 의 비조화 배음 — 로즈가 아니라 종입니다',
    params: { ratio: 7, index: 8, decay: 3.6, release: 1.3, bark: 0.4,
      tine: 0.9, pickup: 0.1 } },
  { id: 'clav', name: 'Clav', category: 'keys',
    note: '6.5:1 에 인덱스와 픽업을 끝까지 — 금속성이고 짧습니다',
    params: { ratio: 6.5, index: 7.6, decay: 0.28, release: 0.05, bark: 1,
      tine: 0.65, pickup: 1 } },
  { id: 'marimba', name: 'Marimba', category: 'pluck',
    note: '배음이 거의 없는 순한 FM — 나무를 때린 소리에 가깝습니다',
    params: { index: 0.8, decay: 0.42, release: 0.1, bark: 0.3,
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
    note: '타인을 끝까지 올린 개조 로즈에 트레몰로를 깊게 — 80년대 발라드의 그 반짝임',
    params: { index: 7.4, decay: 2.2, release: 0.45, bark: 0.9,
      tine: 1, pickup: 0.6, tremRate: 4.8, tremDepth: 0.62 } },
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
    params: { ratio: 3.5, index: 8.5, decay: 0.6, release: 0.1, bark: 0.75,
      tine: 1, pickup: 0.95 } },
  { id: 'harpsi', name: 'Harpsichord', category: 'keys',
    note: '뜯긴 뒤 댐퍼가 내려올 때까지 조금 울립니다 — 클라비보다 배음이 위에 있습니다',
    params: { ratio: 4.5, index: 6.4, decay: 0.9, release: 0.22, bark: 0.85,
      tine: 0.9, pickup: 0.45 } },
  { id: 'fm-bass', name: 'FM Bass', category: 'bass',
    note: '1:1 비율에 픽업을 세게 — 왼손으로 치는 베이스',
    // Trimmed: a 1:1 ratio driven into the pickup is the densest thing this
    // instrument makes, and it came out 10 dB above the calibrated init.
    params: { ratio: 1, index: 3.5, decay: 0.8, release: 0.12, bark: 0.5,
      tine: 0.05, pickup: 0.9, level: 0.4 } },
  { id: 'glass-keys', name: 'Glass Keys', category: 'pluck',
    note: '5.5 라는 반정수 비율에 아주 느린 흔들림 — 배음이 어긋난 채로 천천히 흔들립니다',
    params: { ratio: 5.5, index: 3.4, decay: 0.85, release: 0.15, bark: 0.45,
      tine: 0.15, pickup: 0.08, tremRate: 1.4, tremDepth: 0.5 } },
  { id: 'tubular', name: 'Tubular', category: 'pluck',
    note: '7.5:1 을 6 초 동안 — 짖지 않고 종처럼 오래 남습니다',
    params: { ratio: 7.5, index: 4, decay: 6, release: 2.2, bark: 0.15,
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
    // Trimmed again when the two courses were placed apart: holding the
    // total power across the pair raises what EACH channel peaks at, because
    // the strings no longer sum into both.
    params: { double: 0.9, damp: 0.997, bright: 0.9, bodyHz: 105, body: 8,
      plate: 4, tone: 9000, sustain: 4.5, release: 0.2, level: 0.56 } },
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

// ── Wavetable Synth ──────────────────────────────────────────────────────────
//
// A bank for this instrument has a second job beyond sounding good.  With a
// hundred and thirteen parameters and an eight-row matrix, "what can it do"
// is not answerable by turning knobs at random — a patch is the shortest
// honest answer, and a bank that never uses the matrix would be evidence that
// the matrix is decoration.  So every patch below except the init one routes
// at least one source somewhere, and `wave-synth-selftest` checks that.
//
// Matrix rows read as three numbers.  The indices are positions in
// `MOD_SOURCES` and `MOD_DESTS` — 4 is LFO 1, 5 is CUTOFF, 2 is ENV 2 — and
// the reason they are numbers rather than names is in `mod-matrix.ts`.

const WAVESYNTH: InstrumentPatch[] = [
  { id: 'init', name: 'Init Table', category: 'init',
    note: '기본 파형 표 하나, 유니즌 3, 필터 열림 — 여기서 시작합니다',
    params: {} },

  { id: 'supersaw', name: 'Supersaw', category: 'lead',
    note: '유니즌 7에 폭을 끝까지 — 트랜스 리드의 그 소리',
    params: {
      aPos: 3, aUnison: 7, aDetune: 26, aBlend: 0.85, aWidth: 1,
      bTable: 0, bPos: 3, bUnison: 7, bDetune: 18, bWidth: 0.8, bLevel: 0.5, bOct: -1,
      cutoff: 122, res: 0.1, e1a: 0.008, e1d: 1.2, e1s: 0.85, e1r: 0.5,
      m1src: 8, m1dst: 5, m1amt: 0.25 } },

  { id: 'reese', name: 'Reese Bass', category: 'bass',
    note: '두 표를 크게 디튠해 서로 때리게 합니다 — LFO 가 필터를 훑습니다',
    params: {
      aPos: 3, aUnison: 2, aDetune: 34, aWidth: 0.3,
      bTable: 7, bPos: 5, bUnison: 2, bDetune: 30, bLevel: 0.75, bWidth: 0.3, bFine: 9,
      cutoff: 78, res: 0.35, subLevel: 0.35, e1d: 0.6, e1s: 0.9, e1r: 0.12,
      l1beats: 2, m1src: 4, m1dst: 5, m1amt: 0.18 } },

  { id: 'growl-bass', name: 'Growl Bass', category: 'bass',
    note: '표 위치를 LFO 로 흔듭니다 — 이게 웨이브테이블 신스로만 되는 소리입니다',
    params: {
      aTable: 4, aDetune: 10, aWidth: 0.4,
      cutoff: 90, res: 0.42, fltKey: 0.3, drive: 0.35, subLevel: 0.45,
      e1a: 0.003, e1d: 0.35, e1s: 0.9, e1r: 0.1,
      l1beats: 0.5, l1shape: 1, l1skew: 0.3,
      m1src: 4, m1dst: 1, m1amt: 0.55,
      m2src: 4, m2dst: 5, m2amt: 0.12,
      m3src: 8, m3dst: 15, m3amt: 0.3 } },

  { id: 'vowel-lead', name: 'Vowel Lead', category: 'lead',
    note: '모음 표를 엔벨로프로 훑습니다 — A 에서 U 까지 한 음 안에서',
    params: {
      aTable: 3, aDetune: 8, aWidth: 0.5,
      cutoff: 120, res: 0.2, e1a: 0.01, e1d: 0.4, e1s: 0.8, e1r: 0.3,
      e2a: 0.25, e2d: 1.4, e2s: 0.2, e2r: 0.6,
      m1src: 2, m1dst: 1, m1amt: 0.6,
      m2src: 6, m2dst: 1, m2amt: 0.08,
      l3beats: 0.25 } },

  { id: 'glass-pad', name: 'Glass Pad', category: 'pad',
    note: '느리게 열리고 두 오실레이터가 반대로 흐릅니다 — 가만히 있지 않는 패드',
    params: {
      aTable: 6, aPos: 1, aUnison: 5, aDetune: 16, aWidth: 1, aPan: -0.35,
      bTable: 2, bPos: 4, bUnison: 5, bDetune: 12, bLevel: 0.6, bWidth: 1, bPan: 0.35, bOct: 1,
      cutoff: 104, res: 0.12, e1a: 0.9, e1d: 2, e1s: 0.8, e1r: 2.4,
      l1beats: 8, l2beats: 5, l2phase: 0.3,
      m1src: 4, m1dst: 1, m1amt: 0.3,
      m2src: 5, m2dst: 2, m2amt: -0.3,
      m3src: 4, m3dst: 5, m3amt: 0.1 } },

  { id: 'pluck', name: 'Digital Pluck', category: 'pluck',
    note: '엔벨로프가 표와 필터를 동시에 닫습니다 — 짧고 단단하게',
    params: {
      aTable: 5, aPos: 6, aDetune: 9, aWidth: 0.7,
      cutoff: 118, res: 0.28, e1a: 0.001, e1d: 0.24, e1s: 0, e1r: 0.14,
      e2a: 0.001, e2d: 0.16, e2r: 0.1,
      m1src: 2, m1dst: 5, m1amt: 0.45,
      m2src: 2, m2dst: 1, m2amt: -0.4,
      m3src: 8, m3dst: 5, m3amt: 0.2 } },

  { id: 'bell', name: 'Bell', category: 'keys',
    note: '금속 표에 서브를 섞고 길게 놔둡니다',
    params: {
      aTable: 6, aPos: 5, aUnison: 1, aWidth: 0,
      bTable: 6, bPos: 2, bLevel: 0.5, bOct: 1, bFine: 4,
      cutoff: 126, res: 0.05, subLevel: 0.25, e1a: 0.002, e1d: 2.6, e1s: 0, e1r: 1.8,
      e2a: 0.002, e2d: 0.9, e2r: 0.6,
      m1src: 2, m1dst: 2, m1amt: -0.35 } },

  { id: 'wobble', name: 'Wobble', category: 'bass',
    note: '박자에 묶인 LFO 가 필터를 흔듭니다 — 매크로 1이 흔드는 속도',
    params: {
      aTable: 4, aPos: 4, aWidth: 0.5,
      cutoff: 76, res: 0.55, drive: 0.4, subLevel: 0.4,
      e1s: 1, e1r: 0.12,
      l1beats: 0.5, l1shape: 1, l1skew: 0.65,
      macro1: 0.5,
      m1src: 4, m1dst: 5, m1amt: 0.4,
      m2src: 11, m2dst: 15, m2amt: 0.5,
      m3src: 4, m3dst: 1, m3amt: 0.2 } },

  { id: 'noise-sweep', name: 'Noise Riser', category: 'fx',
    note: '노이즈가 엔벨로프로 올라갑니다 — 드랍 앞에 붙이는 그것',
    params: {
      aLevel: 0.2, aTable: 2, aPos: 7, aUnison: 5, aDetune: 40, aWidth: 1,
      noiseLevel: 0.7, noiseColour: 0.25,
      cutoff: 60, res: 0.5, e1a: 2, e1d: 0.2, e1s: 1, e1r: 0.4,
      e2a: 3.5, e2d: 0.2, e2s: 1, e2r: 0.3,
      m1src: 2, m1dst: 5, m1amt: 0.75,
      m2src: 2, m2dst: 3, m2amt: 0.18,
      m3src: 2, m3dst: 6, m3amt: 0.3 } },

  { id: 'sh-stab', name: 'S&H Stab', category: 'fx',
    note: '샘플 앤 홀드가 피치를 계단으로 던집니다 — 같은 노트는 언제나 같은 계단',
    params: {
      aTable: 5, aPos: 3, aDetune: 12, aWidth: 0.8,
      cutoff: 112, res: 0.3, e1a: 0.002, e1d: 0.3, e1s: 0.3, e1r: 0.2,
      l1beats: 0.25, l1shape: 5,
      l2shape: 5,
      m1src: 4, m1dst: 3, m1amt: 0.25,
      m2src: 5, m2dst: 1, m2amt: 0.5,
      m3src: 10, m3dst: 11, m3amt: 0.6 } },
];

// ── Analog Synth ─────────────────────────────────────────────────────────────
//
// A bank for a subtractive synth is a check on the engine as much as a set of
// sounds: a machine that cannot make a convincing bass is a machine whose
// filter does not track, and one that cannot make a pad is one whose
// envelopes are too fast.  The names below are the archetypes because those
// are the ones a missing feature shows up in.
//
// Three of them move `drift` and `tolerance` well past the defaults, which is
// the point of having them as knobs: "vintage" is mostly those two numbers,
// and a synth that ships them at one setting has decided how old it is.

const ANALOG: InstrumentPatch[] = [
  { id: 'init', name: 'Init Saw', category: 'init',
    note: '톱니 두 대, 래더 절반 열림 — 여기서 시작합니다',
    params: {} },

  { id: 'mini-bass', name: 'Mini Bass', category: 'bass',
    note: '래더가 엔벨로프로 닫힙니다. 베이스 보정 0 — 레조넌스를 올리면 저역이 빠지는 그 소리',
    params: {
      level: 0.467,
      o2fine: -7, o2level: 0.7, subLevel: 0.5,
      cutoff: 62, res: 0.35, drive: 3.2, fltKey: 0.45, envAmt: 34,
      e1a: 0.002, e1d: 0.5, e1s: 0.55, e1r: 0.12,
      e2a: 0.001, e2d: 0.28, e2s: 0.1, e2r: 0.2,
      drift: 2.5, voices: 1 } },

  { id: 'reso-lead', name: 'Reso Lead', category: 'lead',
    note: '레조넌스를 자기발진 직전까지 — 래더가 스스로 울기 시작하는 지점',
    params: {
      level: 0.42,
      o1shape: 1, o1width: 0.32, o2fine: 11, o2level: 0.6,
      cutoff: 84, res: 0.92, drive: 2.4, fltKey: 0.6, envAmt: 20,
      e1a: 0.006, e1d: 0.6, e1s: 0.8, e1r: 0.2,
      l1rate: 5.2, l1delay: 0.35, l1pitch: 14,
      drift: 4.5, voices: 1 } },

  { id: 'poly-brass', name: 'Poly Brass', category: 'brass',
    note: '엔벨로프가 필터를 밀어 올립니다. 보이스마다 부품이 달라서 코드가 저절로 넓어집니다',
    params: {
      level: 0.42,
      o2fine: 8, o2level: 0.75,
      cutoff: 60, res: 0.22, drive: 1.6, fltKey: 0.4, envAmt: 44, velFlt: 22,
      e1a: 0.03, e1d: 0.9, e1s: 0.75, e1r: 0.35,
      e2a: 0.05, e2d: 0.7, e2s: 0.35, e2r: 0.4,
      tolerance: 0.06, drift: 5, spread: 0.85 } },

  { id: 'warm-pad', name: 'Warm Pad', category: 'pad',
    note: '느리게 열리고 유니즌이 서로 어긋납니다 — 드리프트가 코러스를 대신합니다',
    params: {
      level: 0.52,
      o2shape: 2, o2oct: -1, o2level: 0.7,
      unison: 3, detune: 13, spread: 1,
      cutoff: 74, res: 0.18, drive: 1.2, envAmt: 22, fltKey: 0.25,
      e1a: 1.2, e1d: 2.4, e1s: 0.9, e1r: 3.6,
      e2a: 1.4, e2d: 2.4, e2s: 0.5, e2r: 2.4,
      l2rate: 0.22, l2flt: 9,
      drift: 7, tolerance: 0.07 } },

  { id: 'pwm-strings', name: 'PWM Strings', category: 'pad',
    note: 'LFO 가 펄스 폭을 흔듭니다 — 아날로그 스트링 머신의 그 움직임',
    params: {
      level: 0.427,
      o1shape: 1, o2shape: 1, o2width: 0.44, o2fine: -9, o2level: 0.8,
      cutoff: 80, res: 0.14, drive: 1.1, envAmt: 10,
      e1a: 0.35, e1d: 1.2, e1s: 0.85, e1r: 0.9,
      l1rate: 0.45, l1pw: 0.8,
      drift: 6, tolerance: 0.05, spread: 0.9 } },

  { id: 'sync-lead', name: 'Sync Lead', category: 'lead',
    note: '하드 싱크 — 2번이 1번에 끌려 다닙니다. 엔벨로프로 2번 피치를 밀면 그 찢어지는 소리',
    params: {
      level: 0.328,
      o2semi: 7, o2level: 0.9, sync: 1,
      cutoff: 96, res: 0.25, drive: 2, envAmt: 12,
      e1d: 0.5, e1s: 0.8, e1r: 0.15,
      l1rate: 0.3, l2rate: 0.35,
      drift: 3, voices: 1 } },

  { id: 'ring-bell', name: 'Ring Bell', category: 'fx',
    note: '링 모듈레이터 — 두 오실레이터의 합과 차가 남아서 음정이 사라집니다',
    params: {
      level: 0.666,
      o1shape: 3, o2shape: 3, o2semi: 6, o2fine: 22, ring: 0.85,
      o1level: 0.62, o2level: 0.62,
      cutoff: 104, res: 0.1, envAmt: 0,
      e1a: 0.002, e1d: 1.8, e1s: 0, e1r: 1.2,
      drift: 8 } },

  { id: 'acid', name: 'Acid', category: 'bass',
    note: '한 대, 좁은 래더, 엔벨로프가 깊게 쓸어내립니다 — 303 쪽',
    // One oscillator behind a nearly shut filter is genuinely quiet, and the
    // level for it comes from the SOURCE rather than from the output gain:
    // Level may only ever trim a patch down, because the headroom the
    // instrument was calibrated for is what sits above 0.7.  So the square
    // sub is doing the work here, which is also where a 303's bottom end
    // comes from.
    params: {
      o1level: 1, o2level: 0, subLevel: 0.6,
      cutoff: 52, res: 0.86, drive: 5, fltKey: 0.5, envAmt: 50,
      e1a: 0.001, e1d: 0.18, e1s: 0.2, e1r: 0.05,
      e2a: 0.001, e2d: 0.16, e2s: 0, e2r: 0.1,
      drift: 2, voices: 1 } },

  { id: 'broken', name: 'Needs Servicing', category: 'fx',
    note: '드리프트와 부품 오차를 끝까지 — 20년 방치된 기계. 코드가 화음으로 안 들립니다',
    params: {
      level: 0.422,
      o2fine: 19, o2level: 0.8,
      unison: 3, detune: 22,
      cutoff: 72, res: 0.3, drive: 2, envAmt: 18,
      e1a: 0.02, e1d: 0.8, e1r: 0.5,
      drift: 22, tolerance: 0.18, spread: 1 } },
];

/**
 * The FM synth's bank.
 *
 * Authored around what FM can do and the other two synths cannot: struck and
 * plucked spectra whose brightness decays on its own, inharmonic partials
 * that no filter can make, and the one electric piano sound the 1980s are
 * made of.  There is no filter in this instrument, so none of these patches
 * is "the same sound darker" — every difference is a ratio, an index or an
 * envelope.
 *
 * Operators that a patch does not use are set to level 0 explicitly rather
 * than left at their defaults, because the defaults are a tine piano and a
 * bell built on top of them would be a tine piano with a bell in it.
 */
const FM: InstrumentPatch[] = [
  { id: 'init', name: 'Init Tine', category: 'init',
    note: '2단 × 3 알고리듬, 배율 14 의 모듈레이터 — 튠 소리가 나는 출발점입니다',
    params: {} },

  { id: 'mk1', name: 'Electric Piano Mk I', category: 'keys',
    note: '튠은 살리고 인덱스를 내려 따뜻하게 — 세게 치면 밝아지고 약하게 치면 종소리가 없습니다',
    params: {
      level: 0.62,
      o2level: 0.42, o2vel: 0.95, o2d: 0.55,
      o4level: 0.22, o6level: 0.12,
      o1d: 2.6, o3d: 3.2, o5d: 2.4, o1r: 0.5, o3r: 0.5, o5r: 0.5 } },

  { id: 'tine-bright', name: 'Tine Bright', category: 'keys',
    note: '같은 악기를 앰프 앞에 놓은 소리 — 인덱스와 벨로시티를 끝까지',
    params: {
      level: 0.52,
      o2level: 0.78, o2vel: 1, o2d: 1.3,
      o4level: 0.4, o4ratio: 3, o6level: 0.26,
      o1d: 2.2, o3d: 2.6, o5d: 2 } },

  { id: 'wurly', name: 'Wurly Reed', category: 'keys',
    note: '튠이 아니라 리드입니다 — 배율 1 대 1 에 짧은 바크, 배음이 홀수로 섭니다',
    params: {
      level: 0.6,
      o2ratio: 1, o2level: 0.55, o2d: 0.16, o2vel: 0.9,
      o4ratio: 3, o4level: 0.2, o4d: 0.12,
      o6level: 0, o5level: 0.34, o5ratio: 1,
      o1d: 1.8, o3d: 1.6, o5d: 1.4 } },

  { id: 'clav', name: 'FM Clav', category: 'keys',
    note: '피드백으로 톱니를 만들고 곧바로 닫습니다 — 손가락을 떼면 끝납니다',
    params: {
      level: 0.6, algo: 0,
      feedback: 0.62,
      o2level: 0.34, o2ratio: 1, o3level: 0.2, o3ratio: 2,
      o4level: 0, o5level: 0, o6level: 0.3, o6ratio: 1,
      o1a: 0.001, o1d: 0.5, o1s: 0.12, o1r: 0.08,
      o2a: 0.001, o2d: 0.09, o2r: 0.06,
      o3a: 0.001, o3d: 0.06, o3r: 0.05 } },

  { id: 'bell', name: 'Tubular Bell', category: 'pluck',
    note: '네 모듈이 캐리어로 바로 — 비조화 배율이라 배음이 음계 위에 서지 않습니다',
    params: {
      level: 0.5, algo: 4,
      o1d: 9, o1r: 6,
      o2ratio: 3.51, o2level: 0.34, o2d: 2.2, o2vel: 0.7, o2key: -0.5,
      o3ratio: 7.13, o3level: 0.2, o3d: 1.1, o3vel: 0.8, o3key: -0.6,
      o4ratio: 1.41, o4level: 0.22, o4d: 4, o4key: -0.3,
      o5ratio: 11.2, o5level: 0.1, o5d: 0.5, o5key: -0.8,
      o6level: 0 } },

  { id: 'glass', name: 'Glass Bell', category: 'pluck',
    note: '같은 알고리듬을 더 높고 더 맑게 — 종보다 유리에 가깝습니다',
    params: {
      level: 0.55, algo: 4,
      o1d: 5, o1r: 3,
      o2ratio: 4.98, o2level: 0.24, o2d: 1.4, o2key: -0.7,
      o3ratio: 9.02, o3level: 0.14, o3d: 0.7, o3key: -0.8,
      o4ratio: 2.01, o4level: 0.16, o4d: 2.6, o4key: -0.4,
      o5level: 0, o6level: 0 } },

  { id: 'marimba', name: 'FM Marimba', category: 'pluck',
    note: '배율 4 의 모듈레이터가 아주 빨리 사라집니다 — 나무 막대의 그 딱 소리',
    params: {
      level: 0.62,
      o1d: 0.5, o1r: 0.2,
      o2ratio: 4, o2level: 0.5, o2d: 0.035, o2vel: 0.9,
      o3level: 0.34, o3d: 0.9, o3r: 0.3,
      o4ratio: 10, o4level: 0.2, o4d: 0.02,
      o5level: 0.2, o5ratio: 3.01, o5d: 0.3,
      o6ratio: 1, o6level: 0.1, o6d: 0.05 } },

  { id: 'bass', name: 'FM Bass', category: 'bass',
    note: '스택 하나에 피치 엔벨로프 — 시작에서 반음 위로 훅 떨어지는 그 클릭',
    params: {
      level: 0.6, algo: 0, transpose: -12,
      pAmt: 7, pAtk: 0.001, pDec: 0.03,
      o1a: 0.001, o1d: 0.9, o1s: 0.25, o1r: 0.1,
      o2ratio: 1, o2level: 0.42, o2d: 0.18, o2s: 0.02, o2r: 0.08, o2vel: 0.85,
      o3ratio: 2, o3level: 0.26, o3d: 0.1, o3r: 0.06,
      o4level: 0, o5level: 0, o6level: 0 } },

  { id: 'slap', name: 'Slap Bass', category: 'bass',
    note: '피드백이 얹힌 낮은 스택 — 손톱으로 튕기는 소리는 배음이 먼저 나왔다 사라집니다',
    params: {
      level: 0.56, algo: 0, transpose: -12,
      feedback: 0.5, fbOp: 4,
      pAmt: 12, pAtk: 0.0008, pDec: 0.018,
      o1a: 0.001, o1d: 0.6, o1s: 0.18, o1r: 0.08,
      o2ratio: 1, o2level: 0.5, o2d: 0.07, o2s: 0.02, o2vel: 1,
      o3ratio: 3, o3level: 0.3, o3d: 0.05,
      o4d: 0.04,
      o5level: 0, o6level: 0 } },

  { id: 'brass', name: 'FM Brass', category: 'brass',
    note: '모듈레이터가 캐리어보다 늦게 올라옵니다 — 입술이 자리를 잡는 그 시간',
    params: {
      level: 0.52, algo: 7,
      o1a: 0.03, o1d: 3, o1s: 0.85, o1r: 0.22,
      o2ratio: 1, o2level: 0.46, o2a: 0.09, o2d: 1.4, o2s: 0.34, o2r: 0.2, o2vel: 0.75,
      o3level: 0.3, o3a: 0.05, o3d: 1, o3s: 0.3,
      o4ratio: 2, o4level: 0.2, o4a: 0.08, o4d: 0.9, o4s: 0.2,
      o5ratio: 1, o5level: 0.16, o5a: 0.06, o5d: 0.8, o5s: 0.25,
      o6ratio: 3, o6level: 0.1, o6a: 0.1, o6s: 0.1,
      pAmt: -1.2, pAtk: 0.02, pDec: 0.09,
      lfoRate: 4.6, lfoDelay: 0.7, lfoPitch: 9,
      unison: 2, detune: 7, width: 0.5 } },

  { id: 'pad', name: 'Glass Pad', category: 'pad',
    note: '다섯 캐리어에 모듈 하나 — 거의 가산 합성이라 코드가 뭉치지 않습니다',
    params: {
      level: 0.5, algo: 26,
      o1level: 0.9, o2level: 0.2, o3level: 0.5, o4level: 0.4, o6level: 0.24,
      o2ratio: 2.01, o3ratio: 2, o4ratio: 3, o5ratio: 4.01, o6ratio: 6,
      o1a: 0.5, o3a: 0.7, o4a: 0.9, o5a: 1.2, o6a: 1.5,
      o1d: 9, o1s: 0.8, o3d: 9, o3s: 0.7, o4d: 9, o4s: 0.6, o5d: 9, o5s: 0.5, o6d: 9, o6s: 0.4,
      o1r: 1.6, o3r: 1.6, o4r: 1.6, o5r: 1.8, o6r: 2,
      o2a: 0.8, o2d: 6, o2s: 0.5, o2r: 1.4,
      lfoRate: 0.7, lfoDelay: 1.2, lfoPitch: 5,
      unison: 2, detune: 9, width: 0.7, spread: 0.6 } },

  { id: 'organ', name: 'Drawbar 888', category: 'organ',
    note: '변조 없는 가산 6 — 배율이 곧 드로우바입니다. FM 신스가 오르간이 되는 방식',
    params: {
      level: 0.52, algo: 31,
      o1ratio: 0.5, o2ratio: 1.5, o4ratio: 2, o5ratio: 3, o6ratio: 4,
      o1level: 0.7, o2level: 0.45, o3level: 1, o4level: 0.55, o6level: 0.28,
      o1a: 0.004, o2a: 0.004, o3a: 0.004, o4a: 0.004, o5a: 0.004, o6a: 0.004,
      o1d: 12, o2d: 12, o3d: 12, o4d: 12, o5d: 12, o6d: 12,
      o1s: 1, o2s: 1, o3s: 1, o4s: 1, o5s: 1, o6s: 1,
      o1r: 0.06, o2r: 0.06, o3r: 0.06, o4r: 0.06, o5r: 0.06, o6r: 0.06,
      o1vel: 0.1, o2vel: 0.1, o3vel: 0.1, o4vel: 0.1, o5vel: 0.1, o6vel: 0.1,
      o2key: 0, o4key: 0, o6key: 0,
      spread: 0.4 } },

  { id: 'lead', name: 'Bell Lead', category: 'lead',
    note: '종의 배율을 유지한 채 서스테인을 열어둔 소리 — 90년대 트랜스의 그 리드',
    params: {
      level: 0.5, algo: 12,
      o1a: 0.004, o1d: 3, o1s: 0.7, o1r: 0.25,
      o2ratio: 3.5, o2level: 0.3, o2d: 1.2, o2s: 0.18, o2key: -0.5,
      o3ratio: 7, o3level: 0.18, o3d: 0.6, o3s: 0.08, o3key: -0.7,
      o4ratio: 2, o4level: 0.22, o4d: 1.6, o4s: 0.2, o4key: -0.4,
      o5ratio: 1, o5level: 0.4, o5a: 0.01, o5d: 4, o5s: 0.6, o5r: 0.25,
      o6level: 0,
      lfoRate: 5.4, lfoDelay: 0.5, lfoPitch: 12,
      unison: 2, detune: 8, width: 0.4 } },

  { id: 'industrial', name: 'Industrial', category: 'fx',
    note: '피드백을 끝까지 올리고 노이즈 파형을 모듈레이터로 — 음정이 있는 금속 소음',
    params: {
      level: 0.42, algo: 0,
      feedback: 0.95, fbOp: 5,
      o1s: 0.3, o1r: 0.3,
      o2ratio: 1.37, o2level: 0.55, o2d: 1.2, o2s: 0.25, o2wave: 2,
      o3ratio: 5.77, o3level: 0.3, o3d: 0.8, o3s: 0.15, o3wave: 1,
      o4ratio: 2.4, o4level: 0.28, o4d: 0.6, o4s: 0.1,
      o5ratio: 0.5, o5d: 2, o5s: 0.2, o5wave: 7,
      o6level: 0,
      spread: 0.5 } },
];

// ── Grand Piano ──────────────────────────────────────────────────────────────
//
// A piano bank is not a set of tones, it is a set of INSTRUMENTS and a set of
// microphones, and the parameters here divide along that line: `hammer`,
// `strike` and `unison` are the piano, `body`, `tone` and `spread` are where
// it was recorded from.  Nothing below changes both at once without saying so.

const PIANO: InstrumentPatch[] = [
  { id: 'init', name: 'Init Grand', category: 'init',
    note: '기본 그랜드 — 무엇이든 여기서 시작합니다',
    params: {} },
  { id: 'concert', name: 'Concert Grand', category: 'keys',
    note: '큰 홀의 9피트 — 저음이 길게 남고 스테레오가 넓습니다',
    params: { hammer: 8600, strike: 0.085, stretch: 0.2, unison: 4.2, decay: 2.5,
      bloom: 20, after: 0.58, toneDecay: 0.042, bodyHz: 76, bodyQ: 0.5, body: 11,
      tone: 18000, spread: 1, release: 3, level: 0.5 } },
  { id: 'pop-close', name: 'Pop Close', category: 'keys',
    note: '가까이 붙인 마이크 — 통울림을 덜어내고 어택을 세웁니다',
    params: { hammer: 6200, strike: 0.09, decay: 0.8, bodyHz: 190, bodyQ: 2.2,
      body: 0.5, tone: 15000, spread: 0.25, release: 0.7 } },
  { id: 'felt', name: 'Felt', category: 'keys',
    note: '해머와 줄 사이에 펠트 — 어택이 사라지고 애프터톤만 남습니다',
    params: { hammer: 900, strike: 0.26, unison: 0.3, after: 0.88, decay: 1.3,
      toneDecay: 0.058, bodyHz: 115, bodyQ: 0.8, body: 6, tone: 1500,
      spread: 0.55, release: 1.8, level: 0.4 } },
  { id: 'ballad', name: 'Ballad', category: 'keys',
    note: '여리게 친 그랜드 — 길게 끌고 페달을 밟은 채로 둡니다',
    params: { hammer: 3200, strike: 0.155, decay: 1.9, bloom: 12, after: 0.52,
      toneDecay: 0.024, bodyHz: 130, body: 5.5, tone: 6800, spread: 0.65,
      release: 2.4 } },
  { id: 'bright-jazz', name: 'Bright Jazz', category: 'keys',
    note: '트리오 안에서 뚫고 나오게 — 해머를 올리고 통은 좁힙니다',
    params: { hammer: 8000, strike: 0.07, stretch: 1.8, decay: 0.85, bloom: 4.5,
      after: 0.12, toneDecay: 0.005, bodyHz: 250, bodyQ: 3, body: 0.5,
      tone: 17500, spread: 0.3, release: 0.6 } },
  { id: 'honky', name: 'Honky Tonk', category: 'keys',
    note: '조율이 흐트러진 유니즌 — 세 줄이 서로 다른 음을 냅니다',
    params: { hammer: 6800, strike: 0.085, unison: 9.5, stretch: 2.8, decay: 0.7,
      bodyHz: 260, bodyQ: 3.2, body: 2, tone: 12000, release: 0.6 } },
  { id: 'dark-night', name: 'Night', category: 'keys',
    note: '어둡고 짧게 — 늦은 밤에 세게 못 치는 소리',
    params: { hammer: 1900, strike: 0.21, decay: 0.7, after: 0.5, toneDecay: 0.04,
      bodyHz: 125, body: 6.5, tone: 2900, spread: 0.5, release: 0.85,
      level: 0.6 } },
  { id: 'cinematic', name: 'Cinematic', category: 'pad',
    note: '아주 넓고 아주 길게 — 한 음이 코드가 됩니다',
    params: { hammer: 2500, strike: 0.17, unison: 5.5, stretch: 0.3, decay: 2.5,
      bloom: 18, after: 0.6, bodyHz: 78, bodyQ: 0.5, body: 9, tone: 5200,
      spread: 1, release: 2.9, level: 0.52 } },
  { id: 'stab', name: 'Chord Stab', category: 'pluck',
    note: '짧게 끊어 치는 코드 — 리듬 악기로 쓰는 피아노',
    params: { hammer: 9000, strike: 0.045, decay: 0.28, bloom: 2, after: 0.02,
      toneDecay: 0.002, bodyHz: 340, bodyQ: 4.2, body: -4, tone: 18000,
      spread: 0.15, release: 0.16 } },
];

// ── Upright Piano ────────────────────────────────────────────────────────────
//
// The same parameters and a different instrument, which is the point of having
// both: an upright is shorter strings, a soundboard right behind the player,
// and unisons that drift because nobody tunes it.  The bank leans into that
// rather than trying to make it a small grand.

const UPRIGHT: InstrumentPatch[] = [
  { id: 'init', name: 'Init Upright', category: 'init',
    note: '기본 업라이트 — 짧은 줄과 바로 뒤에 붙은 향판',
    params: {} },
  { id: 'studio', name: 'Studio Upright', category: 'keys',
    note: '관리가 잘 된 업라이트 — 유니즌이 붙어 있고 통이 조용합니다',
    params: { hammer: 4200, strike: 0.095, unison: 1.4, stretch: 1.6, decay: 0.8,
      bodyHz: 165, bodyQ: 1.4, body: 2, tone: 9500, spread: 0.35 } },
  { id: 'bar-room', name: 'Bar Room', category: 'keys',
    note: '아무도 조율하지 않은 피아노 — 유니즌이 완전히 벌어졌습니다',
    params: { hammer: 3800, strike: 0.12, unison: 11, stretch: 3.4, decay: 0.55,
      bodyHz: 215, bodyQ: 2.6, body: 5, tone: 6800, release: 0.7 } },
  { id: 'tack', name: 'Tack Piano', category: 'pluck',
    note: '해머에 압정 — 나무가 아니라 금속이 줄을 때립니다',
    params: { hammer: 8800, strike: 0.045, unison: 5, decay: 0.42, bloom: 2.5,
      after: 0.05, toneDecay: 0.004, bodyQ: 3.4, body: 1, tone: 17500,
      release: 0.35 } },
  { id: 'mellow', name: 'Mellow', category: 'keys',
    note: '부드럽게 친 업라이트 — 노래 밑에 깔기 좋습니다',
    params: { hammer: 2100, strike: 0.16, after: 0.44, decay: 0.85, bodyHz: 160,
      body: 5, tone: 4800, spread: 0.55, release: 1.2, level: 0.5 } },
  { id: 'lofi', name: 'Lo-Fi', category: 'keys',
    note: '테이프에 한 번 통과한 업라이트 — 상단이 없고 통이 큽니다',
    params: { hammer: 1400, strike: 0.2, unison: 6.5, stretch: 3, decay: 0.5,
      after: 0.5, bodyHz: 240, bodyQ: 3.8, body: 8, tone: 2600, spread: 0.7,
      release: 0.8, level: 0.6 } },
  { id: 'ragtime', name: 'Ragtime', category: 'keys',
    note: '밝고 짧게 — 왼손이 쉬지 않는 음악을 위한 설정',
    params: { hammer: 7200, strike: 0.07, unison: 4, stretch: 2.8, decay: 0.45,
      bloom: 3.5, bodyHz: 230, bodyQ: 2.4, body: 2.5, tone: 14000,
      spread: 0.3, release: 0.4 } },
  { id: 'gospel', name: 'Gospel', category: 'keys',
    note: '통을 살리고 길게 — 코드를 꽉 눌러 잡는 연주에 맞춥니다',
    params: { hammer: 5200, strike: 0.11, unison: 3.2, decay: 1.3, bloom: 9,
      bodyHz: 140, bodyQ: 1.2, body: 7.5, tone: 10500, spread: 0.6,
      release: 1.7 } },
  { id: 'toy', name: 'Toy', category: 'pluck',
    note: '작은 몸통에 짧은 줄 — 거의 글로켄슈필입니다',
    params: { hammer: 9000, strike: 0.05, unison: 0.4, stretch: 4, decay: 0.3,
      bloom: 2, after: 0.03, bodyHz: 420, bodyQ: 4.5, body: -3, tone: 18000,
      spread: 0.15, release: 0.25, level: 0.58 } },
];

// ── Bass Guitar ──────────────────────────────────────────────────────────────
//
// `pick` is WHERE the string is struck, not what with: 0.02 is at the bridge
// and 0.5 is over the neck.  Most of what separates a Motown bass from a slap
// bass is that number and the damping, not an EQ — which is why the bank
// moves them and leaves `tone` mostly alone.

const BASS: InstrumentPatch[] = [
  { id: 'init', name: 'Init Finger', category: 'init',
    note: '기본 핑거 베이스',
    params: {} },
  { id: 'pick', name: 'Pick', category: 'bass',
    note: '피크로 브리지 가까이 — 어택에 딸깍이 붙습니다',
    params: { pick: 0.03, bright: 0.72, damp: 0.9988, bodyHz: 780, body: 3.5,
      tone: 4200, sustain: 3.4, release: 0.1 } },
  { id: 'motown', name: 'Motown Flatwound', category: 'bass',
    note: '플랫와운드에 폼 뮤트 — 상단이 거의 없고 근음만 굵게 남습니다',
    params: { pick: 0.24, bright: 0.12, damp: 0.9975, bodyHz: 380, bodyQ: 0.9,
      body: 7, tone: 1200, sustain: 2.2, release: 0.09 } },
  { id: 'slap', name: 'Slap', category: 'bass',
    note: '엄지로 때리고 검지로 당기는 소리 — 상단이 전부입니다',
    params: { pick: 0.02, bright: 1, damp: 0.9986, bodyHz: 900, bodyQ: 2.4,
      body: 2, plate: 5, tone: 9000, sustain: 3, release: 0.08, level: 0.56 } },
  { id: 'palm-mute', name: 'Palm Mute', category: 'bass',
    note: '손바닥으로 줄을 눌러 — 음이 서기 전에 죽습니다',
    params: { pick: 0.06, bright: 0.35, damp: 0.984, bodyHz: 520, body: 4,
      tone: 1800, sustain: 0.8, release: 0.05 } },
  { id: 'fretless', name: 'Fretless', category: 'bass',
    note: '프렛이 없어 줄이 지판을 직접 누릅니다 — 길게 울고 어택이 둥급니다',
    params: { pick: 0.34, bright: 0.28, damp: 0.9996, bodyHz: 440, bodyQ: 1.6,
      body: 6, tone: 2600, sustain: 7, release: 0.35 } },
  { id: 'octave', name: 'Octave Strung', category: 'bass',
    note: '옥타브 줄을 함께 — 두 줄이 만드는 맥놀이가 EQ 로는 안 나옵니다',
    params: { double: 0.85, pick: 0.08, bright: 0.6, damp: 0.9994, bodyHz: 700,
      body: 4, tone: 5200, width: 0.5, sustain: 4, release: 0.14, level: 0.58 } },
  { id: 'upright-bass', name: 'Upright', category: 'bass',
    note: '손가락으로 뜯는 콘트라베이스 — 통이 크고 상단이 빨리 죽습니다',
    params: { pick: 0.42, bright: 0.18, damp: 0.9965, bodyHz: 150, bodyQ: 1.8,
      body: 9, tone: 1500, sustain: 1.6, release: 0.22 } },
  { id: 'sub', name: 'Sub', category: 'bass',
    note: '거의 사인파에 가깝게 — 킥 밑에서 음만 담당합니다',
    params: { pick: 0.5, bright: 0, damp: 0.9998, bodyHz: 90, bodyQ: 0.6,
      body: 8, tone: 800, sustain: 8, release: 0.5 } },
  { id: 'grind', name: 'Grind', category: 'bass',
    note: '플레이트를 열어 상단을 갈아냅니다 — 기타 없이도 자리를 채웁니다',
    params: { pick: 0.025, bright: 0.95, damp: 0.999, bodyHz: 850, bodyQ: 3,
      body: 1, plate: 9, tone: 7500, sustain: 5, release: 0.16, level: 0.54 } },
];

// ── Mallets ──────────────────────────────────────────────────────────────────
//
// Four instruments behind `bar`, and the bank is mostly about which one — a
// marimba and a glockenspiel are not two settings of the same thing.  What is
// left over is the MALLET, which on a real one is the whole performance
// decision: the same bar struck with yarn and with plastic is two sounds.

const MALLET: InstrumentPatch[] = [
  { id: 'init', name: 'Init Marimba', category: 'init',
    note: '기본 마림바 — 중간 굳기의 말렛',
    params: {} },
  { id: 'marimba-soft', name: 'Marimba Soft', category: 'keys',
    note: '실로 감은 말렛 — 어택이 거의 없고 나무 울림만 남습니다',
    params: { hardness: 0.2, decay: 2.9, tube: 5.5, tubeQ: 2.8, spread: 0.6,
      level: 0.56 } },
  { id: 'marimba-hard', name: 'Marimba Hard', category: 'pluck',
    note: '딱딱한 말렛 — 나무가 딸깍이고 배음이 튀어나옵니다',
    params: { hardness: 3, decay: 0.45, tube: 0, tubeQ: 4.5, spread: 0.2 } },
  { id: 'marimba-bass', name: 'Bass Marimba', category: 'bass',
    note: '관을 좁고 세게 울려 근음만 남깁니다 — 아래 두 옥타브를 위한 설정',
    params: { hardness: 2.3, decay: 2.3, damp: 0.6, tube: 13, tubeQ: 8,
      spread: 0.82, level: 0.48 } },
  { id: 'vibes', name: 'Vibraphone', category: 'keys',
    note: '금속 바에 모터를 끄고 — 재즈에서 가장 흔한 설정입니다',
    params: { bar: 1, hardness: 0.8, decay: 1.6, tube: 6, tubeQ: 2.8,
      spread: 0.45 } },
  { id: 'vibes-motor', name: 'Vibes Motor', category: 'keys',
    note: '모터를 돌려 관 입구를 여닫습니다 — 트레몰로가 아니라 공명의 흔들림입니다',
    params: { bar: 1, hardness: 0.22, decay: 2.9, motor: 6.5, motorDepth: 0.85,
      tube: 8, tubeQ: 0.5, spread: 1, level: 0.4 } },
  { id: 'vibes-damped', name: 'Vibes Damped', category: 'pluck',
    note: '댐퍼 페달을 떼고 — 음이 서자마자 끊깁니다',
    params: { bar: 1, hardness: 2.4, decay: 0.32, damp: 0.9, tube: 1, tubeQ: 6,
      spread: 0.2 } },
  { id: 'xylophone', name: 'Xylophone', category: 'pluck',
    note: '실로폰은 3 배음이 12도로 조율됩니다 — 마림바와 같은 나무인데 화음이 다릅니다',
    params: { bar: 2, hardness: 3, decay: 0.22, damp: 0.6, tube: 6, tubeQ: 8,
      spread: 0.45 } },
  { id: 'glock', name: 'Glockenspiel', category: 'pluck',
    note: '작은 금속 바 — 배음이 조화롭지 않아 종처럼 들립니다',
    params: { bar: 3, hardness: 3, decay: 0.28, damp: 0.75, tube: -4, tubeQ: 7.5,
      spread: 0.25, level: 0.56 } },
  { id: 'bells', name: 'Bells', category: 'fx',
    note: '글로켄을 단단히 때리고 끝까지 울립니다 — 어긋난 배음이 그대로 남습니다',
    params: { bar: 3, hardness: 1.8, decay: 3, tube: 2, tubeQ: 1.2,
      spread: 0.9, level: 0.48 } },
];

// ── Drawbar Organ ────────────────────────────────────────────────────────────
//
// The one instrument whose presets are a NUMBER everybody already knows: a
// registration is nine digits, and an organist reads 888000000 the way a
// guitarist reads a chord shape.  So every note below prints the drawbars, and
// the patches are the registrations that have names rather than ones invented
// to fill a menu.

const ORGAN: InstrumentPatch[] = [
  { id: 'init', name: 'Init 888000000', category: 'init',
    note: '888 000 000 — 아래 세 개만 뽑은 가장 기본',
    params: {} },
  { id: 'jimmy', name: 'Jimmy Smith', category: 'organ',
    note: '888 800 000 에 3차 퍼커션 — 4 피트를 하나 더 뽑아 오른손이 앞으로 나옵니다',
    params: { db4: 8, perc: 0.85, percHarmonic: 1, percDecay: 0.16, click: 0.5 } },
  { id: 'full', name: 'Full Organ', category: 'organ',
    note: '888 888 888 — 드로바를 전부 뽑습니다. 코드 하나가 벽이 됩니다',
    params: { db4: 8, db223: 8, db2: 8, db135: 8, db113: 8, db1: 8,
      click: 0.6, level: 0.5 } },
  { id: 'rock', name: 'Rock', category: 'organ',
    note: '888 888 000 — 위 세 개만 밀어 넣습니다. 꽉 차되 귀를 찌르지는 않습니다',
    params: { db4: 8, db223: 8, db2: 8, click: 0.75, edge: 0.003, level: 0.54 } },
  { id: 'gospel', name: 'Gospel', category: 'organ',
    note: '848 800 008 — 5도를 반쯤 밀어 넣고 1 피트로 반짝임만 얹습니다',
    params: { db513: 4, db4: 8, db1: 8, click: 0.55, edge: 0.004, level: 0.58 } },
  { id: 'blues', name: 'Blues', category: 'organ',
    note: '808 000 000 — 5⅓ 피트를 밀어 넣습니다. 5도가 빠지면 소리가 둥글어집니다',
    params: { db513: 0, perc: 0.6, percDecay: 0.35, click: 0.45 } },
  { id: 'flutes', name: 'Soft Flutes', category: 'keys',
    note: '006 860 000 — 16 피트를 빼고 8 피트 위주로. 노래 밑에 깔립니다',
    params: { db16: 0, db513: 0, db8: 6, db4: 8, db223: 6, click: 0.08,
      edge: 0.012 } },
  { id: 'reed', name: 'Reed 8ft', category: 'organ',
    note: '008 000 000 — 8 피트 하나만. 오르간에서 가장 단순한 소리입니다',
    params: { db16: 0, db513: 0, click: 0.2, edge: 0.01 } },
  { id: 'whistle', name: 'Whistle Lead', category: 'lead',
    note: '800 000 888 — 아래 하나와 위 셋. 리드로 쓰면 뚫고 나옵니다',
    params: { db513: 0, db8: 0, db135: 8, db113: 8, db1: 8, perc: 0.7,
      percHarmonic: 1, percDecay: 0.1, click: 0.7, level: 0.56 } },
  { id: 'theatre', name: 'Theatre', category: 'pad',
    note: '806 000 008 — 5도를 빼고 8 피트를 반쯤. 속이 빈 울림 위에 1 피트만 섭니다',
    params: { db513: 0, db8: 6, db1: 8, click: 0.15, edge: 0.018 } },
  { id: 'perc-bite', name: 'Percussion Bite', category: 'pluck',
    note: '888 008 000 에 2차 퍼커션을 빠르게 — 코드를 끊어 칠 때 알갱이가 섭니다',
    params: { db2: 8, perc: 1, percDecay: 0.07, click: 0.9, edge: 0.0025 } },
];


// ── Bowed Strings ────────────────────────────────────────────────────────────
//
// `body` picks the instrument — violin, viola, cello, bass — and the rest is
// the BOW, which on a real one is the whole performance: where it sits between
// bridge and fingerboard, how hard it presses, how fast it travels.  Those
// three are `pos`, `force` and `speed`, and every named technique below is a
// place in that space rather than a filter setting.

const BOWED: InstrumentPatch[] = [
  { id: 'init', name: 'Init Violin', category: 'init',
    note: '기본 바이올린 — 활이 다리와 지판 사이 보통 자리에 있습니다',
    params: {} },
  { id: 'violin-solo', name: 'Solo Violin', category: 'lead',
    note: '비브라토를 건 독주 — 활을 조금 더 눌러 음을 붙잡습니다',
    params: { force: 0.66, speed: 0.58, vibDepth: 28, vibRate: 5.6,
      vibDelay: 0.18, bright: 0.58, width: 0.25 } },
  { id: 'viola', name: 'Viola', category: 'keys',
    note: '비올라 — 바이올린보다 몸이 크고 고음이 덜 납니다',
    params: { body: 1, force: 0.58, bright: 0.42, vibDepth: 20, vibDelay: 0.3,
      width: 0.35 } },
  { id: 'cello', name: 'Cello', category: 'keys',
    note: '첼로 — 활이 무겁고 몸이 오래 웁니다',
    params: { body: 2, speed: 0.42, force: 0.62, bright: 0.38, sustainRing: 0.75,
      vibDepth: 24, vibRate: 4.6, vibDelay: 0.3, attack: 0.08, release: 0.14 } },
  { id: 'double-bass', name: 'Double Bass', category: 'bass',
    note: '콘트라베이스 — 활이 느리고 음이 서기까지 시간이 걸립니다',
    params: { body: 3, size: 0.4, speed: 0.34, force: 0.86, bright: 0.3,
      sustainRing: 0.95, attack: 0.12, release: 0.24, width: 0.2 } },
  { id: 'sul-tasto', name: 'Sul Tasto', category: 'pad',
    note: '활을 지판 위로 — 배음이 거의 없는 플루트 같은 소리가 납니다',
    params: { pos: 0.26, force: 0.3, speed: 0.38, bright: 0.18, hair: 0.1,
      attack: 0.16, release: 0.22, sustainRing: 0.8 } },
  { id: 'sul-pont', name: 'Sul Ponticello', category: 'fx',
    note: '활을 다리 바로 위로 — 기본음이 사라지고 배음만 남아 유리처럼 들립니다',
    params: { pos: 0.028, force: 0.82, speed: 0.72, bright: 0.95, hair: 0.6,
      attack: 0.02, level: 0.33 } },
  { id: 'martele', name: 'Martelé', category: 'pluck',
    note: '활을 눌러 놓고 확 당깁니다 — 음 머리에 망치 같은 자국이 남습니다',
    params: { force: 1, speed: 0.95, attack: 0.005, release: 0.03,
      bright: 0.8, hair: 0.55, sustainRing: 0.12, level: 0.58 } },
  { id: 'spiccato', name: 'Spiccato', category: 'pluck',
    note: '활을 튕겨 떨어뜨립니다 — 짧고 가볍고 리듬이 됩니다',
    params: { force: 0.3, speed: 0.9, pos: 0.16, hair: 0.4, attack: 0.005,
      release: 0.02, sustainRing: 0.05, bright: 0.7, bodyAmt: 0.6 } },
  { id: 'section', name: 'Section', category: 'pad',
    note: '여러 명이 함께 — 활 잡음을 올리고 넓게 펼쳐 한 덩어리로 들리게 합니다',
    params: { body: 1, size: -0.2, force: 0.5, speed: 0.45, hair: 0.5,
      attack: 0.12, release: 0.3, vibDepth: 14, vibRate: 4.2, vibDelay: 0.5,
      width: 0.95, sustainRing: 0.7, level: 0.56 } },
  { id: 'harmonic', name: 'Flautando', category: 'pad',
    note: '활을 거의 얹기만 — 소리가 설까 말까 한 자리입니다',
    params: { pos: 0.2, force: 0.16, speed: 0.28, bright: 0.12, hair: 0.05,
      attack: 0.24, release: 0.4, sustainRing: 0.9, vibDepth: 8, width: 0.6 } },
];

// ── Analog Drums ─────────────────────────────────────────────────────────────
//
// Forty-six parameters and, until now, one sound — every voice's tune, decay,
// bend and level sitting at a default nobody could reach from the UI.  A patch
// here is a whole KIT rather than one drum, because that is the unit anybody
// picks: the difference between an 808 and a 909 is not the kick, it is the
// kick and the snare and the hats all having been designed by the same people
// on the same afternoon.
//
// The named machines below are what those designs actually did differently,
// and the parameters say which: an 808's kick is a long bridged-T ring with
// almost no pitch envelope, a 909's is a short one with a big sweep and some
// drive, a 606's everything is shorter and higher because it was cheaper.

const DRUMMACHINE: InstrumentPatch[] = [
  { id: 'init', name: 'Init Kit', category: 'init',
    note: '기본 아날로그 킷 — 어느 쪽으로도 치우치지 않은 자리',
    params: {} },
  { id: 'deep-808', name: 'Deep 808', category: 'bass',
    note: '킥이 1.9 초를 웁니다 — 피치 스윕을 거의 없애면 음이 되지 소리가 아닙니다',
    params: { bdtune: 40, bddec: 1.9, bdbend: 8, bdsnap: 0.15, bddrive: 1.1,
      sdtune: 168, sddec: 0.2, sdtone: 0.35, cydec: 3.4, ohdec: 0.85,
      cbtune: 500, level: 0.6 } },
  { id: 'nine-oh-nine', name: '909', category: 'keys',
    note: '짧고 세게 때리는 킥에 큰 스윕 — 드라이브가 어택을 앞으로 당깁니다',
    params: { bdtune: 60, bddec: 0.4, bdbend: 38, bdsnap: 0.8, bddrive: 3.2,
      sdtune: 230, sddec: 0.22, sdsnappy: 0.88, sdsnapdec: 0.1, ohdec: 0.95,
      chdec: 0.045, cytune: 420, cydec: 2.6 } },
  { id: 'six-oh-six', name: '606', category: 'pluck',
    note: '전부 짧고 높게 — 싸게 만든 기계의 소리이고, 그게 성격입니다',
    params: { tune: 3, bdtune: 72, bddec: 0.26, bdbend: 34, bdsnap: 0.65,
      sdtune: 290, sddec: 0.16, sdtone: 0.75, sdsnappy: 0.8, chdec: 0.03,
      ohdec: 0.24, cydec: 0.9, lttune: 130, mttune: 185, httune: 265 } },
  { id: 'seven-oh-seven', name: '707', category: 'keys',
    note: '드라이브를 빼고 정돈되게 — 무엇 위에 얹어도 자리를 다투지 않습니다',
    params: { bdtune: 55, bddec: 0.44, bdbend: 20, bdsnap: 0.5, bddrive: 1,
      sdtune: 205, sddec: 0.24, sdtone: 0.6, sdsnappy: 0.55, chdec: 0.05,
      ohdec: 0.4, cydec: 1.4, accent: 0.5, width: 0.4 } },
  { id: 'trap', name: 'Trap', category: 'bass',
    note: '킥을 서브까지 내리고 하이햇을 아주 짧게 — 롤이 뭉치지 않습니다',
    params: { bdtune: 32, bddec: 2.2, bdbend: 5, bdsnap: 0.1, bddrive: 1.2,
      sdtune: 250, sddec: 0.18, sdsnappy: 0.7, chdec: 0.022, chtune: 820,
      ohdec: 0.18, rstune: 2400, cbtune: 900, level: 0.58 } },
  { id: 'techno', name: 'Techno', category: 'lead',
    note: '킥을 조이고 드라이브를 올려 앞으로 — 심벌은 길게 남겨 공간을 만듭니다',
    params: { bdtune: 58, bddec: 0.34, bdbend: 30, bdsnap: 0.9, bddrive: 5.5,
      sdtune: 215, sddec: 0.2, sdtone: 0.7, chdec: 0.035, ohdec: 0.7,
      cytune: 240, cydec: 5, cylvl: 0.4, width: 0.85, level: 0.6 } },
  { id: 'boom-bap', name: 'Boom Bap', category: 'keys',
    note: '스네어를 어둡게 하고 스냅을 줄입니다 — 샘플러에서 꺼낸 것처럼 둔탁하게',
    params: { tune: -2, bdtune: 48, bddec: 0.7, bdbend: 16, bddrive: 2.2,
      sdtune: 165, sddec: 0.32, sdtone: 0.2, sdsnappy: 0.35, sdsnapdec: 0.24,
      chdec: 0.08, ohdec: 0.42, cydec: 1.2, width: 0.35 } },
  { id: 'disco', name: 'Disco', category: 'keys',
    note: '박수를 넓게 펼치고 오픈 하이햇을 길게 — 네 박이 다 들리게',
    params: { bdtune: 58, bddec: 0.62, bdbend: 28, bdsnap: 0.35, sddec: 0.3,
      sdtone: 0.72, cptune: 1600, cpdec: 0.62, cpspread: 3, cplvl: 1,
      ohdec: 1.4, ohlvl: 0.9, chdec: 0.07, cytune: 340, cydec: 3, width: 1 } },
  { id: 'lofi', name: 'Lo-Fi', category: 'fx',
    note: '전체를 내리고 감쇠를 줄입니다 — 테이프에 한 번 갔다 온 킷',
    params: { tune: -5, bdtune: 44, bddec: 0.38, bdbend: 12, bddrive: 2.8,
      sdtune: 150, sddec: 0.18, sdtone: 0.25, sdsnappy: 0.3, chdec: 0.04,
      ohdec: 0.3, cydec: 0.8, cylvl: 0.35, accent: 0.4, width: 0.25,
      level: 0.62 } },
  { id: 'percussion', name: 'Percussion Only', category: 'fx',
    note: '킥과 스네어를 내리고 카우벨과 림을 올립니다 — 위에 얹는 레이어용',
    params: { bdlvl: 0.2, sdlvl: 0.25, cplvl: 0.3, rstune: 2100, rsdec: 0.12,
      rslvl: 0.9, cbtune: 760, cbdec: 0.55, cblvl: 0.9, chlvl: 0.4,
      cytune: 500, cydec: 2.8, cylvl: 0.7, width: 0.8 } },
];

/**
 * The clarinet family's patches, built on the axes that measurably move it.
 *
 * Chosen from measurement rather than from what the knobs are called.  Rendered
 * one at a time against the default, the fingerprint distance each control can
 * reach on its own is:
 *
 *     Lip 0.2      2.748      Bore       0.120
 *     Register     2.095      Breath Nz  0.236
 *     Stiffness    1.031      Growl      0.196
 *     Attack       0.884      Spread     0.020
 *     Vibrato      0.816      Leak       0.020
 *     Breath       0.532      Tone       0.347
 *     Instrument   0.501      Release    0.496
 *
 * So the bank is built out of Lip, Register, Stiffness, Attack, Vibrato and the
 * second bore, and NOT out of Bore, Leak or Spread — those are honest controls
 * that barely colour this model, and a bank that leaned on them would be
 * thirteen names for one sound.  The first attempt did exactly that and the
 * differentiation check caught it: fifteen pairs measured as the same patch,
 * and the whole bank's spread was narrower than one knob's.
 *
 * Combining axes is also how patches end up alike, which is less obvious: a
 * harder lip and a stiffer reed pull the spectrum opposite ways, and a patch
 * with both measured 0.164 from the default while either alone measured over 1.
 * So each patch leans on ONE dominant move and uses the rest for taste.
 */
const REED: InstrumentPatch[] = [
  { id: 'init', name: 'Init Clarinet', category: 'init',
    note: '기본 클라리넷 — 원통관이라 홀수 배음, 레지스터 키는 옥타브가 아니라 12도',
    params: {} },
  { id: 'soft-lip', name: 'Soft Lip', category: 'keys',
    note: '입술을 아주 무르게 — 리드가 오래 움직여 굵고 무른 소리가 됩니다',
    params: { damp: 0.22, attack: 0.05 } },
  { id: 'tight-lip', name: 'Tight Lip', category: 'lead',
    note: '입술을 조이고 세게 불어 붙잡습니다 — 얇고 곧게 뚫고 나오는 리드 톤',
    params: { damp: 4, breath: 1.3, tone: 2, noise: 0.02, vibDepth: 0.1,
      vibRate: 6.4, attack: 0.014 } },
  { id: 'soft-reed', name: 'Soft Reed', category: 'keys',
    note: '무른 리드 — 리드 자신의 공명이 내려와 갈대 소리가 앞에 섭니다',
    params: { stiff: 0.4, damp: 0.6, noise: 0.34, attack: 0.1, breath: 1.15 } },
  { id: 'clarion', name: 'Clarion', category: 'lead',
    note: '레지스터 키를 눌러 12도 위 — 1901센트, 옥타브가 아닙니다',
    params: { register: 1, breath: 1.1 } },
  { id: 'clarion-soft', name: 'Clarion Soft', category: 'pad',
    note: '윗 레지스터를 무른 입술로 — 높고 부드러운 층',
    params: { register: 1, damp: 0.3, release: 0.5 } },
  { id: 'air', name: 'Air', category: 'pad',
    note: '아주 천천히 들어오고 길게 빠집니다 — 받치는 층으로',
    params: { attack: 0.4, release: 0.8, noise: 0.45 } },
  { id: 'staccato', name: 'Staccato', category: 'pluck',
    note: '짧게 끊어 붙는 텅잉 — 리듬을 치는 데',
    params: { attack: 0.004, release: 0.01, breath: 1.15 } },
  { id: 'vibrato', name: 'Vibrato Lead', category: 'lead',
    note: '비브라토로 노래하듯 — 재즈 쪽 클라리넷',
    params: { vibDepth: 0.25, vibRate: 4.6 } },
  { id: 'klezmer', name: 'Klezmer', category: 'lead',
    note: '넓고 빠른 비브라토에 그르렁거림 — 클레즈머 쪽',
    params: { vibDepth: 0.2, vibRate: 7.2, growl: 0.3, breath: 1.25 } },
  { id: 'bass-init', name: 'Bass Clarinet', category: 'bass',
    note: '같은 원통관을 한 옥타브 아래로 — 더 굵고 더 많이 잃는 보어',
    params: { body: 1, tone: 1.2, attack: 0.045 } },
  { id: 'bass-tight', name: 'Bass Clarinet Tight', category: 'bass',
    note: '아래쪽을 조여서 — 베이스 라인이 또렷하게 나옵니다',
    params: { body: 1, damp: 3.8, breath: 1.25, tone: 0.5, attack: 0.02 } },
  { id: 'bass-solo', name: 'Bass Clarinet Solo', category: 'lead',
    note: '무른 리드에 비브라토를 얹은 베이스 클라리넷 독주',
    params: { body: 1, stiff: 0.4, vibDepth: 0.22, vibRate: 4.2 } },
];

/**
 * The plucked family's patches.
 *
 * Built to the two rules this suite enforces, from the start rather than after
 * being told: every pair has to move at least two knobs and differ by more than
 * a quarter of the parameter space, AND sound more than 0.40 apart when
 * rendered.  The reed bank learned both the hard way — one patch per dominant
 * axis satisfied the ear and failed the parameter rule, and combinations of
 * opposing axes satisfied the parameter rule and cancelled in the ear.
 *
 * The five bodies are already 0.584 to 4.029 apart from each other, measured,
 * so most of the work is done by `kind`; the trims are what makes two patches
 * on the SAME body two patches.
 *
 * Which is also why no patch here is a bare `{ kind: n }`.  `kind` spans five
 * values, so stepping it one place is exactly 0.25 of the parameter space and
 * exactly one knob — both of which land on the wrong side of the rule, and
 * rightly: a preset whose whole content is "pick the other instrument" is the
 * picker, not a preset.  Each body's plain patch says how wide it sits and how
 * long it takes to let go, which are the two things a player chooses before
 * touching anything else.
 */
const PLUCKED: InstrumentPatch[] = [
  { id: 'init', name: 'Init Harp', category: 'init',
    note: '콘서트 하프 — 긴 현이 몇 초를 웁니다, 감쇠시킬 것이 손밖에 없습니다',
    params: {} },
  { id: 'harp-close', name: 'Harp Close', category: 'pluck',
    note: '브리지 가까이 뜯어 또렷하게, 링은 조금 짧게 — 아르페지오가 뭉치지 않습니다',
    params: { pickTrim: -0.7, ringTrim: -0.45, brightTrim: 0.35, width: 0.3 } },
  { id: 'harp-soft', name: 'Harp Soft', category: 'pad',
    note: '살로 무르게 뜯어 길게 — 받치는 층으로',
    params: { brightTrim: -0.65, ringTrim: 0.5, pickTrim: 0.5, release: 0.8,
      width: 0.85 } },
  { id: 'mandolin', name: 'Mandolin', category: 'guitar',
    note: '복현 — 두 현이 서로 비껴 울립니다. EQ로는 흉내낼 수 없는 것',
    params: { kind: 1, width: 0.72, release: 0.11 } },
  { id: 'mandolin-tremolo', name: 'Mandolin Bright', category: 'lead',
    note: '복현을 더 벌리고 단단한 플렉트럼으로 — 트레몰로가 앞에 섭니다',
    params: { kind: 1, doubleTrim: 0.6, brightTrim: 0.4, pickTrim: -0.5 } },
  { id: 'ukulele', name: 'Ukulele', category: 'guitar',
    note: '나일론에 작은 박스 — 고음이 적게 나고 빨리 사라집니다',
    params: { kind: 2, width: 0.34, release: 0.12 } },
  { id: 'ukulele-warm', name: 'Ukulele Warm', category: 'keys',
    note: '엄지로 살에 가깝게 — 둥글고 짧게',
    params: { kind: 2, brightTrim: -0.55, pickTrim: 0.55, ringTrim: 0.3 } },
  { id: 'banjo', name: 'Banjo', category: 'guitar',
    note: '드럼 헤드 — 기타의 음이 시작되기 전에 끝납니다',
    params: { kind: 3, width: 0.22, release: 0.07 } },
  { id: 'banjo-ring', name: 'Banjo Ring', category: 'pluck',
    note: '헤드를 덜 조여 조금 더 울리게, 뜯는 자리는 더 안쪽으로',
    params: { kind: 3, dampTrim: 0.55, ringTrim: 0.5, pickTrim: 0.45 } },
  { id: 'koto', name: 'Koto', category: 'keys',
    note: '실크에 긴 오동나무 상자 — 브리지에서 먼 곳을 뜯어 속이 빈 음색',
    params: { kind: 4, width: 0.62, release: 0.34 } },
  { id: 'koto-bright', name: 'Koto Bright', category: 'lead',
    note: '플렉트럼을 브리지 쪽으로 옮기고 단단하게 — 선율에 씁니다',
    params: { kind: 4, pickTrim: -0.65, brightTrim: 0.45, ringTrim: -0.3 } },
  { id: 'harp-wide', name: 'Harp Wide', category: 'pad',
    note: '복현처럼 겹치고 넓게 벌려 — 하프 두 대처럼 들립니다',
    params: { doubleTrim: 0.75, width: 1, ringTrim: 0.35, brightTrim: -0.3 } },
];

export const INSTRUMENT_PATCHES: Readonly<Record<string, readonly InstrumentPatch[]>> = {
  polysynth: POLY,
  wavesynth: WAVESYNTH,
  analog: ANALOG,
  fm: FM,
  epiano: EPIANO,
  agtr: AGTR,
  egtr: EGTR,
  piano: PIANO,
  upright: UPRIGHT,
  bass: BASS,
  mallet: MALLET,
  organ: ORGAN,
  bowed: BOWED,
  reed: REED,
  plucked: PLUCKED,
  drummachine: DRUMMACHINE,
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
