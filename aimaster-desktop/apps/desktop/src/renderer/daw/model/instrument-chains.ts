// 악기별 기본 체인 — what to put on a track, in what order, before you know why.
//
// The insert picker is organised the way a plugin folder is: EQ, Dynamics,
// Saturation, Delay, Reverb.  That is the right shelf for somebody who
// already knows what they are reaching for, and no help at all to somebody
// who has just recorded a vocal and does not know that a de-esser exists.
// This is the other door into the same devices: pick what the track IS, get
// the chain that track almost always wants, in the order it wants it.
//
// ── Where the order comes from ────────────────────────────────────────────
//
// Every guide consulted agrees on the shape, and they disagree only at the
// edges (where the gate goes, whether the de-esser sits before or after the
// compressor):
//
//   clean up  →  corrective EQ  →  dynamics  →  tone / character  →
//   modulation  →  stereo  →  delay  →  reverb
//
//   · ampedstudio.com/blog/vocal-chain — the core vocal sequence, and why a
//     compressor placed after the reverb exaggerates the reverb instead of
//     controlling the voice.
//   · musiciangoods.com/blogs/mixing-mastering/vocal-chain — gate first,
//     then subtractive EQ.
//   · vocalpresets.com/blog/vocal-chain-order — move the gate AFTER the EQ
//     when it will not catch the noise cleanly.
//   · waves.com/what-plugin-go-first-in-a-mix-chain-explained — corrective
//     before creative; each device reacts to what the one before it made.
//   · musicradar.com/news/5-mixing-chains — drums: transient shaper, EQ,
//     compressor, saturation.
//   · asherlaub.com — orchestral: light ratios on strings (≈1.5–2.5:1),
//     restrained compression on brass, ~3 kHz cut with a 10 kHz lift.
//   · masterthescore.com/article/how-to-mix-orchestral-music — strings to a
//     bigger hall, woodwinds to a smaller room.
//   · abletonic.eu — electronic: corrective EQ, compression, saturation,
//     creative EQ, time-based last.
//
// Two places where this file deliberately differs from the guides:
//
//   REVERB AND DELAY ARE INSERTS HERE, NOT SENDS.  Every guide says to put
//   them on an aux.  That is correct and it is also the step a beginner gets
//   wrong, so the chain puts them in the channel at a low mix percentage
//   where they do something audible and nothing dangerous.  The send route
//   stays where it was for anyone who wants it.
//
//   NO GATE ON THE VOCAL CHAIN.  A gate set wrong eats the ends of words,
//   and the one that is set wrong is the one nobody adjusted.  The chains
//   that gate (drums) gate something percussive, where a wrong setting is
//   audible immediately.
//
// ── Why the numbers are here at all ───────────────────────────────────────
//
// A chain of devices at their defaults is not a starting point: `saturation`
// defaults to `mix: 0` and `deesser` to `amount: 0`, so a beginner who loads
// a chain and hears nothing concludes the chain does nothing.  Every device
// below is given settings that are audible, conservative, and defensible for
// the instrument — the point is that the track is usable before a single
// knob is touched.
//
// The values are held to the plugins' own ranges by a selftest, which also
// loads every chain through `loadRack` — the same path a saved rack takes —
// and refuses if any device is dropped or any value is changed on the way in.

import {
  INSTRUMENT_LABEL, INSTRUMENT_PRESETS, type InstrumentId,
} from '../engine/plugin-presets-instrument.js';
import type { RackPreset } from './rack-preset.js';

export type InstrumentChainId =
  | 'vocal' | 'backing' | 'drums' | 'percussion' | 'bass' | 'guitar'
  | 'keyboard' | 'strings' | 'brass' | 'woodwinds' | 'synth' | 'fx';

export interface ChainDevice {
  pluginId: string;
  /** One line, for the person who has not met this device before. */
  why: string;
  /**
   * Settings for this device — ONLY where the app has no instrument preset
   * for it.
   *
   * `plugin-presets-instrument.ts` already answers "what does a bass
   * compressor want", with a paragraph of reasoning per instrument and 301
   * presets over 43 devices.  A chain that typed its own numbers for the
   * same pair would be a second answer to the same question, one click away
   * from the first: load the bass chain, open the compressor, pick 베이스
   * from its own menu, and every number would change.  So where a preset
   * exists the chain takes it and carries nothing of its own, and a selftest
   * refuses a device that carries both.
   */
  params?: Record<string, number>;
}

export interface InstrumentChain {
  id: InstrumentChainId;
  /**
   * The instrument profile this chain's devices take their settings from.
   *
   * All twelve have one now.  Seven did not when this file was written: the
   * instrument menu on every device offered seven sources, and a VOCAL was
   * not one of them in an app whose first mixing category is the vocal.
   * 보컬 came first, then 백킹 보컬 · 퍼커션 · 브라스 · 목관 · FX — thirteen
   * columns over 43 devices, each with its reason — so every chain now takes
   * its settings from the same place a device's own 악기 menu does.
   *
   * `null` remains possible, and a chain that uses it carries its own
   * numbers; nothing does today.
   */
  profile: InstrumentId | null;
  /** What the track is, in the app's language. */
  label: string;
  /** The English name, because that is what the plugin folders say. */
  english: string;
  hint: string;
  devices: ChainDevice[];
}

/**
 * The chains, in the order the picker shows them — voices, then the rhythm
 * section, then everything that is held or played, then the things that are
 * made rather than recorded.
 */
export const INSTRUMENT_CHAINS: readonly InstrumentChain[] = [
  {
    id: 'vocal',
    profile: 'vocal',
    label: '보컬',
    english: 'Vocals',
    hint: '리드 보컬 — 가장 앞에 서는 소리',
    devices: [
      { pluginId: 'eq8', why: '울림과 저역 잡음을 먼저 덜어냅니다' },
      { pluginId: 'comp', why: '큰 곳과 작은 곳의 차이를 좁혀 가사가 묻히지 않게 합니다' },
      { pluginId: 'deesser', why: '치찰음(ㅅ, ㅊ)만 골라 눌러줍니다' },
      { pluginId: 'tube', why: '아주 옅은 배음으로 목소리를 앞으로 당깁니다' },
      { pluginId: 'delay', why: '문장 끝을 살짝 밀어 공간을 만듭니다' },
      { pluginId: 'plate', why: '보컬에 가장 많이 쓰는 판 리버브' },
    ],
  },
  {
    id: 'backing',
    profile: 'backing',
    label: '백킹 보컬',
    english: 'Backing Vocal',
    hint: '코러스 · 더블 — 리드 뒤에 넓게 까는 소리',
    devices: [
      { pluginId: 'eq8', why: '리드가 설 자리를 비우려고 저역을 더 많이 덜어냅니다' },
      { pluginId: 'comp', why: '리드보다 더 눌러 뒤에 고르게 붙여 둡니다' },
      { pluginId: 'deesser', why: '여러 겹이 겹치면 치찰음도 겹칩니다' },
      { pluginId: 'widener', why: '좌우로 벌려 리드의 가운데를 비웁니다' },
      { pluginId: 'plate', why: '리드보다 조금 더 젖게' },
    ],
  },
  {
    id: 'drums',
    profile: 'drumloop',
    label: '드럼',
    english: 'Drums',
    hint: '킷 전체 · 드럼 버스',
    devices: [
      { pluginId: 'transient', why: '때리는 순간을 먼저 세웁니다 — 압축보다 앞' },
      { pluginId: 'eq8', why: '초저역을 자르고 둔한 중저역을 덜어냅니다' },
      { pluginId: 'comp', why: '킷을 하나로 묶습니다 — 어택을 늦게 둬야 때림이 남습니다' },
      { pluginId: 'saturation', why: '배음을 더해 작은 스피커에서도 들리게 합니다' },
      { pluginId: 'reverb', why: '짧은 방 하나로 킷을 같은 공간에 놓습니다' },
    ],
  },
  {
    id: 'percussion',
    profile: 'perc',
    label: '퍼커션',
    english: 'Percussion',
    hint: '셰이커 · 탬버린 · 콩가',
    devices: [
      { pluginId: 'eq8', why: '퍼커션에 저역은 필요 없습니다' },
      { pluginId: 'transient', why: '손이 닿는 순간을 또렷하게' },
      { pluginId: 'comp', why: '한 번씩 튀는 타격만 눌러줍니다' },
      { pluginId: 'reverb', why: '드럼과 같은 방에 놓습니다' },
    ],
  },
  {
    id: 'bass',
    profile: 'bass',
    label: '베이스',
    english: 'Bass',
    hint: '일렉 베이스 · 신스 베이스',
    devices: [
      { pluginId: 'eq8', why: '킥이 설 자리를 비우고 탁한 중저역을 덜어냅니다' },
      { pluginId: 'comp', why: '음마다 다른 크기를 고르게 — 베이스에서 가장 중요한 한 가지' },
      { pluginId: 'tube', why: '배음을 만들어 작은 스피커에서도 음정이 들리게 합니다' },
      { pluginId: 'monomaker', why: '저역은 가운데에 — 넓은 저역은 재생 장치마다 다르게 들립니다' },
    ],
  },
  {
    id: 'guitar',
    profile: 'egtr',
    label: '기타',
    english: 'Guitar',
    hint: '일렉 · DI — 앰프가 맨 앞',
    devices: [
      { pluginId: 'amp', why: 'DI 를 먼저 앰프에 통과시킵니다 — 모든 처리는 그다음' },
      { pluginId: 'eq8', why: '보컬 자리를 비우고 저역 울림을 덜어냅니다' },
      { pluginId: 'comp', why: '코드와 단음의 크기 차이를 좁힙니다' },
      { pluginId: 'delay', why: '한 번만 반복시켜 폭을 만듭니다' },
      { pluginId: 'reverb', why: '앰프가 놓인 방' },
    ],
  },
  {
    id: 'keyboard',
    profile: 'piano',
    label: '키보드',
    english: 'Keyboard',
    hint: '피아노 · 일렉피아노 · 오르간',
    devices: [
      { pluginId: 'eq8', why: '연주 소음과 저역 울림을 덜어냅니다' },
      { pluginId: 'comp', why: '세게 친 음만 살짝 눌러 터치를 남깁니다' },
      { pluginId: 'chorus', why: '일렉피아노와 오르간이 늘 쓰는 흔들림' },
      { pluginId: 'plate', why: '건반에 가장 잘 맞는 판 리버브' },
    ],
  },
  {
    id: 'strings',
    profile: 'strings',
    label: '스트링',
    english: 'Strings',
    hint: '현악 — 세게 누르지 않는 것이 규칙',
    devices: [
      { pluginId: 'eq8', why: '2–5 kHz 의 거친 부분을 살짝 덜고 목관이 설 자리를 만듭니다' },
      { pluginId: 'comp', why: '현악은 1.5–2.5:1 — 더 누르면 활이 사라집니다' },
      { pluginId: 'reverb', why: '현악은 큰 홀로 — 목관보다 깊게' },
    ],
  },
  {
    id: 'brass',
    profile: 'brass',
    label: '브라스',
    english: 'Brass',
    hint: '금관 — 세게 누르면 기계처럼 들립니다',
    devices: [
      { pluginId: 'eq8', why: '3 kHz 를 살짝 덜고 10 kHz 를 올려 날카로움만 뺍니다' },
      { pluginId: 'comp', why: '피크만 잡는 정도로 — 금관은 눌릴수록 납작해집니다' },
      { pluginId: 'tube', why: '놋쇠의 배음을 조금 더' },
      { pluginId: 'reverb', why: '현악과 같은 홀, 조금 더 가깝게' },
    ],
  },
  {
    id: 'woodwinds',
    profile: 'winds',
    label: '목관',
    english: 'Woodwinds',
    hint: '플루트 · 클라리넷 · 오보에',
    devices: [
      { pluginId: 'eq8', why: '숨소리와 저역 울림을 덜어냅니다' },
      { pluginId: 'comp', why: '여리게 부는 구간을 들리게 하는 정도' },
      { pluginId: 'reverb', why: '목관은 작은 방 — 현악보다 가깝게' },
    ],
  },
  {
    id: 'synth',
    profile: 'synth',
    label: '신스',
    english: 'Synth',
    hint: '패드 · 리드 · 플럭',
    devices: [
      { pluginId: 'eq8', why: '베이스와 겹치는 저역을 먼저 비웁니다' },
      { pluginId: 'comp', why: '길게 끌리는 소리를 고르게' },
      { pluginId: 'saturation', why: '디지털 음색에 배음을 더합니다' },
      { pluginId: 'widener', why: '좌우로 벌립니다 — 저역은 가운데에 둔 채로' },
      { pluginId: 'pingpong', why: '좌우로 튕기는 반복' },
      { pluginId: 'reverb', why: '마지막에 공간' },
    ],
  },
  {
    id: 'fx',
    profile: 'fx',
    label: 'FX',
    english: 'FX',
    hint: '효과음 · 라이저 · 임팩트',
    devices: [
      { pluginId: 'eq8', why: '저역을 비워 리듬 파트와 부딪히지 않게 합니다' },
      { pluginId: 'widener', why: '효과음은 넓을수록 효과음답습니다' },
      { pluginId: 'tapedelay', why: '테이프 반복 — 꼬리를 길게' },
      { pluginId: 'reverb', why: '가장 깊은 공간' },
    ],
  },
];

/**
 * The settings a device in a chain actually loads with.
 *
 * The instrument preset wins wherever there is one — it is the app's
 * existing, argued answer for that (instrument, device) pair, and having the
 * chain hold a second copy is how the two come to disagree.  What the chain
 * carries is only what no preset covers.
 */
export function chainDeviceParams(
  chain: InstrumentChain, device: ChainDevice,
): Record<string, number> {
  if (chain.profile !== null) {
    const preset = INSTRUMENT_PRESETS.find(
      (p) => p.pluginId === device.pluginId && p.id === `inst-${device.pluginId}-${chain.profile}`);
    if (preset) return { ...preset.params };
  }
  return { ...(device.params ?? {}) };
}

/** What the chain's settings come from, for a line of UI. */
export function chainSource(chain: InstrumentChain): string {
  return chain.profile === null
    ? '이 체인의 설정'
    : `${INSTRUMENT_LABEL[chain.profile]} 악기 프리셋`;
}

export function findInstrumentChain(id: string): InstrumentChain | undefined {
  return INSTRUMENT_CHAINS.find((c) => c.id === id);
}

/**
 * The chain as a rack, so it loads through the path a saved rack loads
 * through — including its sanitising, its slot rules and its report of
 * anything this build cannot provide.
 *
 * Slots are packed from A in chain order: unlike a user's saved rack, where
 * "the compressor is in C" is part of how it is remembered, a starter chain
 * has no history to preserve and a gap in it would only be a question.
 */
export function rackFromChain(chain: InstrumentChain): RackPreset {
  return {
    id: `builtin:${chain.id}`,
    name: `${chain.label} 기본 체인`,
    note: chain.hint,
    createdAt: 0,
    updatedAt: 0,
    devices: chain.devices.map((device, slot) => ({
      slot,
      pluginId: device.pluginId,
      label: '',
      bypass: false,
      params: chainDeviceParams(chain, device),
    })),
  };
}
