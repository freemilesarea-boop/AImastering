// Starting points.
//
// A preset is not a sound — it is a place to start arguing from.  Every one
// here says what it is FOR ("리드 보컬", "게이트 스네어"), because a list of
// names like "Hall 3" tells you nothing you could not have guessed by turning
// the decay knob yourself.
//
// Stored as partial parameter maps: only what the preset actually decides.
// Everything it does not mention keeps the device's default, so adding a
// parameter to a device later does not silently give every preset a zero for
// it.
//
// Grouped by the source they are for rather than by the algorithm, because
// that is how anyone chooses one — you have a snare, not a convolution.

export interface PluginPreset {
  id: string;
  pluginId: string;
  name: string;
  /** What kind of source this is for. */
  group: string;
  /** One line: what it does, or what to watch out for. */
  note: string;
  /** Only the parameters this preset decides. */
  params: Record<string, number>;
}

// Space indices are looked up by id so reordering the catalogue cannot
// silently repoint every preset at the wrong room.
import { spaceIndex } from './reverb-spaces.js';

const S = spaceIndex;

export const PLUGIN_PRESETS: readonly PluginPreset[] = [
  // ── Space Reverb · 보컬 ───────────────────────────────────────────────────
  {
    id: 'space-vox-lead', pluginId: 'spacereverb', name: '리드 보컬 홀', group: '보컬',
    note: '길지 않고 넓습니다. 프리딜레이가 가사를 앞으로 밀어냅니다',
    params: { space: S('hall-recital'), decayPct: 85, preDelayMs: 40, lowCutHz: 220, highCutHz: 9000, erDb: -4, widthPct: 115, mixPct: 24 },
  },
  {
    id: 'space-vox-plate', pluginId: 'spacereverb', name: '보컬 플레이트', group: '보컬',
    note: '초기 반사가 없어서 보컬 바로 뒤에 붙습니다. 발라드 기본값',
    params: { space: S('plate-vocal'), decayPct: 90, preDelayMs: 28, lowCutHz: 260, highCutHz: 10000, mixPct: 26 },
  },
  {
    id: 'space-vox-air', pluginId: 'spacereverb', name: '보컬 에어', group: '보컬',
    note: '리버브로 들리면 안 됩니다. 마른 보컬에 공기만 붙입니다',
    params: { space: S('amb-close'), decayPct: 110, preDelayMs: 12, erDb: 3, tailDb: -4, lowCutHz: 300, highCutHz: 14000, mixPct: 16 },
  },
  {
    id: 'space-vox-wide', pluginId: 'spacereverb', name: '백보컬 와이드', group: '보컬',
    note: '가운데를 비우고 옆으로만 벌립니다. 리드와 안 싸웁니다',
    params: { space: S('amb-wide'), decayPct: 120, preDelayMs: 18, widthPct: 145, lowCutHz: 320, highCutHz: 11000, mixPct: 32 },
  },
  {
    id: 'space-vox-cathedral', pluginId: 'spacereverb', name: '성가대 · 대성당', group: '보컬',
    note: '6초. 가사가 겹치는 걸 감수하고 쓰는 소리입니다',
    params: { space: S('hall-cathedral'), decayPct: 100, preDelayMs: 60, lowCutHz: 160, highCutHz: 8000, mixPct: 38 },
  },

  // ── Space Reverb · 드럼 ───────────────────────────────────────────────────
  {
    id: 'space-drum-room', pluginId: 'spacereverb', name: '스네어 룸', group: '드럼',
    note: '나무 방. 스네어가 커지고 킥은 안 건드립니다',
    params: { space: S('room-drum'), decayPct: 85, preDelayMs: 8, erDb: 3, lowCutHz: 200, highCutHz: 12000, mixPct: 26 },
  },
  {
    id: 'space-drum-gated', pluginId: 'spacereverb', name: '게이트 스네어', group: '드럼',
    note: '80년대. Hold 로 방이 사라지는 시점을 잡습니다',
    params: { space: S('spec-gated'), holdMs: 220, preDelayMs: 6, erDb: 0, lowCutHz: 180, highCutHz: 11000, mixPct: 40 },
  },
  {
    id: 'space-drum-oh', pluginId: 'spacereverb', name: '오버헤드 룸', group: '드럼',
    note: '킷 전체를 한 방에 놓습니다. 오버헤드 버스에',
    params: { space: S('room-wood'), decayPct: 70, preDelayMs: 4, erDb: 4, tailDb: -3, lowCutHz: 240, highCutHz: 13000, widthPct: 120, mixPct: 22 },
  },
  {
    id: 'space-drum-big', pluginId: 'spacereverb', name: '빅 드럼 홀', group: '드럼',
    note: '록 드럼. 프리딜레이를 주지 않아야 킷과 붙어 있습니다',
    params: { space: S('live-theatre'), decayPct: 110, preDelayMs: 0, erDb: 2, lowCutHz: 150, highCutHz: 10000, mixPct: 30 },
  },
  {
    id: 'space-drum-slap', pluginId: 'spacereverb', name: '슬랩백 킷', group: '드럼',
    note: '반사 몇 개만. 로큰롤 드럼',
    params: { space: S('amb-slap'), decayPct: 90, preDelayMs: 0, erDb: 5, tailDb: -8, mixPct: 24 },
  },

  // ── Space Reverb · 기타 · 건반 ────────────────────────────────────────────
  {
    id: 'space-gtr-amp', pluginId: 'spacereverb', name: '앰프 룸', group: '기타 · 건반',
    note: '캐비닛이 방 안에 있다는 것만 알려줍니다',
    params: { space: S('room-studio'), decayPct: 90, preDelayMs: 6, erDb: 4, lowCutHz: 200, highCutHz: 9000, mixPct: 20 },
  },
  {
    id: 'space-gtr-clean', pluginId: 'spacereverb', name: '클린 기타 홀', group: '기타 · 건반',
    note: '아르페지오가 번지지 않을 만큼만',
    params: { space: S('hall-recital'), decayPct: 75, preDelayMs: 24, lowCutHz: 260, highCutHz: 11000, mixPct: 28 },
  },
  {
    id: 'space-piano', pluginId: 'spacereverb', name: '피아노 홀', group: '기타 · 건반',
    note: '리사이틀 홀에 놓인 그랜드. 페달을 밟아도 안 뭉칩니다',
    params: { space: S('hall-scoring'), decayPct: 95, preDelayMs: 26, lowCutHz: 120, highCutHz: 12000, widthPct: 110, mixPct: 26 },
  },
  {
    id: 'space-organ', pluginId: 'spacereverb', name: '오르간 · 석조 교회', group: '기타 · 건반',
    note: '고역까지 남는 돌 공간. 오르간은 원래 이런 데 있습니다',
    params: { space: S('hall-church'), decayPct: 100, preDelayMs: 45, lowCutHz: 60, highCutHz: 14000, mixPct: 42 },
  },
  {
    id: 'space-pad', pluginId: 'spacereverb', name: '패드 · 무한 공간', group: '기타 · 건반',
    note: '11초. 신스 패드와 앰비언트용이고 그 외에는 재앙입니다',
    params: { space: S('spec-infinite'), decayPct: 100, preDelayMs: 0, tailDb: 2, lowCutHz: 200, highCutHz: 9000, widthPct: 140, mixPct: 45 },
  },

  // ── Space Reverb · 라이브 ─────────────────────────────────────────────────
  {
    id: 'space-live-house', pluginId: 'spacereverb', name: '라이브하우스 밴드', group: '라이브',
    note: '500석. 밴드 전체를 한 무대에 세웁니다 — 버스에',
    params: { space: S('live-house'), decayPct: 100, preDelayMs: 14, erDb: 2, lowCutHz: 180, highCutHz: 11000, mixPct: 22 },
  },
  {
    id: 'space-live-club', pluginId: 'spacereverb', name: '클럽 PA', group: '라이브',
    note: '벽이 가까워서 저역이 뭉칩니다. 그게 클럽 소리입니다',
    params: { space: S('live-club'), decayPct: 100, preDelayMs: 8, erDb: 3, lowCutHz: 120, highCutHz: 10000, mixPct: 26 },
  },
  {
    id: 'space-live-arena', pluginId: 'spacereverb', name: '아레나', group: '라이브',
    note: '반대편에서 돌아옵니다. 템포가 빠르면 안 됩니다',
    params: { space: S('live-arena'), decayPct: 100, preDelayMs: 55, lowCutHz: 140, highCutHz: 9000, widthPct: 130, mixPct: 32 },
  },
  {
    id: 'space-live-open', pluginId: 'spacereverb', name: '야외 페스티벌', group: '라이브',
    note: '천장이 없습니다. 반사 몇 개가 넓게 퍼집니다',
    params: { space: S('live-openair'), decayPct: 100, preDelayMs: 30, erDb: 4, tailDb: -6, widthPct: 140, mixPct: 24 },
  },
  {
    id: 'space-live-monitor', pluginId: 'spacereverb', name: '무대 모니터', group: '라이브',
    note: '무대 위에서 들리는 만큼만. 존재감용',
    params: { space: S('live-monitor'), decayPct: 100, preDelayMs: 0, erDb: 4, lowCutHz: 250, highCutHz: 12000, mixPct: 18 },
  },

  // ── Space Reverb · 오케스트라 ─────────────────────────────────────────────
  {
    id: 'space-strings', pluginId: 'spacereverb', name: '현악 홀', group: '오케스트라',
    note: '활 소리가 남을 만큼. 스트링 버스에',
    params: { space: S('hall-concert'), decayPct: 95, preDelayMs: 32, lowCutHz: 90, highCutHz: 13000, widthPct: 120, mixPct: 30 },
  },
  {
    id: 'space-symphony', pluginId: 'spacereverb', name: '심포니', group: '오케스트라',
    note: '전체 오케스트라. 솔로 악기에 걸면 묻힙니다',
    params: { space: S('hall-symphony'), decayPct: 100, preDelayMs: 24, erDb: -3, lowCutHz: 70, highCutHz: 12000, widthPct: 125, mixPct: 34 },
  },
  {
    id: 'space-scoring', pluginId: 'spacereverb', name: '스코어링 스테이지', group: '오케스트라',
    note: '영화 음악. 크지만 명료해서 대사와 안 싸웁니다',
    params: { space: S('hall-scoring'), decayPct: 90, preDelayMs: 20, lowCutHz: 100, highCutHz: 14000, mixPct: 28 },
  },

  // ── Space Reverb · 특수 ───────────────────────────────────────────────────
  {
    id: 'space-reverse', pluginId: 'spacereverb', name: '리버스 스웰', group: '특수',
    note: '소리 뒤에서 차오릅니다. Hold 가 차오르는 길이입니다',
    params: { space: S('spec-reverse'), holdMs: 700, preDelayMs: 0, tailDb: 4, lowCutHz: 200, mixPct: 55 },
  },
  {
    id: 'space-nonlin', pluginId: 'spacereverb', name: '논리니어 홀', group: '특수',
    note: '빨리 줄었다가 낮은 데서 버팁니다. 밀도가 안 죽습니다',
    params: { space: S('spec-nonlin'), decayPct: 100, preDelayMs: 12, lowCutHz: 180, highCutHz: 11000, mixPct: 35 },
  },
  {
    id: 'space-tile', pluginId: 'spacereverb', name: '타일 룸', group: '특수',
    note: '욕실. 작은데 고역이 하나도 안 죽습니다',
    params: { space: S('room-tile'), decayPct: 100, dampingPct: 40, preDelayMs: 4, highCutHz: 18000, mixPct: 30 },
  },
  {
    id: 'space-hallway', pluginId: 'spacereverb', name: '복도', group: '특수',
    note: '앞뒤로만 반사됩니다. 좁고 깁니다',
    params: { space: S('room-hallway'), decayPct: 100, preDelayMs: 10, erDb: 4, widthPct: 60, mixPct: 28 },
  },

  // ── Plate ────────────────────────────────────────────────────────────────
  {
    id: 'plate-vocal', pluginId: 'plate', name: '보컬 플레이트', group: '보컬',
    note: '저역을 미리 덜어냅니다. 보컬 뒤에서 안 뭉칩니다',
    params: { decaySec: 2.1, dampHz: 7000, lowCutHz: 280, highCutHz: 12000, preDelayMs: 24, mixPct: 26 },
  },
  {
    id: 'plate-snare', pluginId: 'plate', name: '스네어 플레이트', group: '드럼',
    note: '짧고 밝습니다. 스네어 뒤에서 반짝입니다',
    params: { decaySec: 1.4, dampHz: 12000, diffusion: 0.8, lowCutHz: 320, highCutHz: 16000, preDelayMs: 8, mixPct: 30 },
  },
  {
    id: 'plate-long', pluginId: 'plate', name: '롱 플레이트', group: '특수',
    note: '6초짜리 철판. 신스와 기타 스웰에',
    params: { decaySec: 6, dampHz: 6000, lowCutHz: 220, highCutHz: 11000, widthPct: 130, mixPct: 40 },
  },
  {
    id: 'plate-dark', pluginId: 'plate', name: '다크 플레이트', group: '보컬',
    note: '고역을 눌러서 뒤로 보냅니다. 앞이 붐빌 때',
    params: { decaySec: 2.6, dampHz: 3200, lowCutHz: 240, highCutHz: 7000, mixPct: 28 },
  },
  {
    id: 'plate-tight', pluginId: 'plate', name: '타이트 플레이트', group: '드럼',
    note: '거의 앰비언스. 킷 전체에 얇게',
    params: { decaySec: 0.8, dampHz: 9000, diffusion: 0.85, lowCutHz: 300, mixPct: 18 },
  },

  // ── Spring ───────────────────────────────────────────────────────────────
  {
    id: 'spring-amp', pluginId: 'spring', name: '기타 앰프 스프링', group: '기타 · 건반',
    note: '앰프에 달린 그 탱크. 흔들면 웁니다',
    params: { decaySec: 2.2, toneHz: 1400, dampHz: 4200, boing: 0.62, mixPct: 30 },
  },
  {
    id: 'spring-surf', pluginId: 'spring', name: '서프', group: '기타 · 건반',
    note: '길고 요란하게. 스타카토 코드에',
    params: { decaySec: 3.4, toneHz: 1800, dampHz: 5200, boing: 0.82, mixPct: 45 },
  },
  {
    id: 'spring-dub', pluginId: 'spring', name: '덥 스프링', group: '특수',
    note: '어둡고 저역이 두껍습니다. 스네어를 던져 넣으세요',
    params: { decaySec: 4, toneHz: 700, dampHz: 2200, boing: 0.7, mixPct: 38 },
  },
  {
    id: 'spring-subtle', pluginId: 'spring', name: '얇은 스프링', group: '보컬',
    note: '보컬에 스프링을 쓰고 싶을 때 쓸 수 있는 만큼',
    params: { decaySec: 1.2, toneHz: 1600, dampHz: 5000, boing: 0.35, mixPct: 14 },
  },

  // ── Shimmer ──────────────────────────────────────────────────────────────
  {
    id: 'shimmer-pad', pluginId: 'shimmer', name: '셔머 패드', group: '기타 · 건반',
    note: '한 음이 코드가 됩니다. 느린 곡에서만',
    params: { space: S('hall-cathedral'), decayPct: 100, shimmer: 0.45, loopMs: 200, mixPct: 40 },
  },
  {
    id: 'shimmer-vox', pluginId: 'shimmer', name: '셔머 보컬', group: '보컬',
    note: '옥타브가 가사를 덮지 않을 만큼. 프리딜레이를 넉넉히',
    params: { space: S('hall-symphony'), decayPct: 80, shimmer: 0.28, loopMs: 260, preDelayMs: 70, lowCutHz: 280, mixPct: 26 },
  },
  {
    id: 'shimmer-ambient', pluginId: 'shimmer', name: '앰비언트 무한', group: '특수',
    note: '거의 안 끝납니다. 앰비언트 트랙 전체를 이걸로',
    params: { space: S('spec-infinite'), decayPct: 100, shimmer: 0.7, loopMs: 380, widthPct: 140, mixPct: 55 },
  },
  {
    id: 'shimmer-glass', pluginId: 'shimmer', name: '글래스', group: '특수',
    note: '저역을 다 잘라내면 유리처럼 됩니다',
    params: { space: S('plate-bright'), decayPct: 120, shimmer: 0.55, loopMs: 120, lowCutHz: 600, highCutHz: 16000, mixPct: 45 },
  },

  // ── Reverb (classic) ─────────────────────────────────────────────────────
  {
    id: 'reverb-short', pluginId: 'reverb', name: '숏 룸', group: '룸',
    note: '보내기(센드)용 기본값',
    params: { decaySec: 0.8, preDelayMs: 8, mix: 1 },
  },
  {
    id: 'reverb-hall', pluginId: 'reverb', name: '미디엄 홀', group: '룸',
    note: '어디에 걸어도 크게 틀리지 않는 값',
    params: { decaySec: 2.2, preDelayMs: 24, mix: 1 },
  },
  {
    id: 'reverb-long', pluginId: 'reverb', name: '롱 테일', group: '룸',
    note: '5초. 센드로만 쓰세요',
    params: { decaySec: 5, preDelayMs: 40, mix: 1 },
  },

  // ── A few for the rest of the rack, so the mechanism is not reverb-only ──
  {
    id: 'comp-vocal', pluginId: 'comp', name: '보컬 레벨링', group: '보컬',
    note: '4:1, 느린 어택. 자음을 안 죽입니다',
    params: { thresholdDb: -18, ratio: 4, attackMs: 12, releaseMs: 140, makeupDb: 3 },
  },
  {
    id: 'comp-drum-bus', pluginId: 'comp', name: '드럼 버스 글루', group: '드럼',
    note: '2:1, 3 dB만. 붙이는 용도지 줄이는 용도가 아닙니다',
    params: { thresholdDb: -12, ratio: 2, attackMs: 20, releaseMs: 90, makeupDb: 2 },
  },
  {
    id: 'limiter-master', pluginId: 'limiter', name: '마스터 −1 dBTP', group: '마스터',
    note: '스트리밍 제출용 실링',
    params: { ceilingDb: -1, releaseMs: 120 },
  },
  {
    id: 'delay-slap', pluginId: 'delay', name: '슬랩백 120 ms', group: '보컬',
    note: '리버브 대신. 로커빌리와 록 보컬',
    params: { timeMs: 120, feedback: 0.12, mix: 0.22 },
  },
  {
    id: 'delay-eighth', pluginId: 'delay', name: '8분 딜레이 (120 BPM)', group: '기타 · 건반',
    note: '250 ms. 곡 템포에 맞춰 다시 잡으세요',
    params: { timeMs: 250, feedback: 0.32, mix: 0.28 },
  },
];

/** Presets for one device, in the order they are listed. */
export function presetsFor(pluginId: string): PluginPreset[] {
  return PLUGIN_PRESETS.filter((preset) => preset.pluginId === pluginId);
}

/** The same, grouped by what they are for. */
export function presetGroups(pluginId: string): Array<{ group: string; presets: PluginPreset[] }> {
  const out: Array<{ group: string; presets: PluginPreset[] }> = [];
  for (const preset of presetsFor(pluginId)) {
    const found = out.find((g) => g.group === preset.group);
    if (found) found.presets.push(preset);
    else out.push({ group: preset.group, presets: [preset] });
  }
  return out;
}

export function findPreset(id: string): PluginPreset | undefined {
  return PLUGIN_PRESETS.find((preset) => preset.id === id);
}

/**
 * A preset resolved against a device's defaults.
 *
 * A preset decides some parameters; the rest are the device's own defaults,
 * not zero and not whatever was there before.  Loading a preset has to land in
 * the same place every time, or "load it again" would not be a way back.
 */
export function resolvePreset(
  preset: PluginPreset, defaults: Record<string, number>,
): Record<string, number> {
  return { ...defaults, ...preset.params };
}
