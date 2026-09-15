// preset-glossary — Korean names and plain explanations for every preset.
//
// Same contract as `parameter-glossary`: the English name stays because it
// is what the preset is called, the Korean name sits beside it, and one
// plain sentence says what picking it will do — in words that assume no
// audio training.
//
// A preset is where a beginner starts, so this is the layer that matters
// most for them. "AI Vocal Texture" tells someone who already knows the
// problem exactly what it does and tells everyone else nothing.

import { LOUI_PRESETS } from './loui-presets.js';

export interface PresetGlossaryEntry {
  ko: string;
  plain: string;
}

const P: Record<string, PresetGlossaryEntry> = {
  'ai-pop': {
    ko: 'AI 팝',
    plain: '밝고 선명한 팝 사운드. 귀에 쏘이기 쉬운 3 kHz는 눌러 두어 화사하되 따갑지 않습니다.',
  },
  'kpop-loud': {
    ko: 'K-POP 라우드',
    plain: '가장 크고 단단한 마스터. 음압을 최대로 올리되 소리가 찢어지지 않게 천장을 지킵니다.',
  },
  'streaming-pro': {
    ko: '스트리밍 표준',
    plain: '스포티파이·애플뮤직 기준(−14 LUFS)에 맞춘 무난한 마스터. 어디에 올려도 안전합니다.',
  },
  'youtube-safe': {
    ko: '유튜브 안전',
    plain: '유튜브가 음량을 다시 낮추지 않는 선에 맞춥니다. 업로드 후 소리가 작아지는 일을 막습니다.',
  },
  'lofi-warm': {
    ko: '로파이 따뜻하게',
    plain: '고음을 부드럽게 깎고 저음을 살려 옛날 카세트 같은 편안한 질감을 만듭니다.',
  },
  'edm-wide': {
    ko: 'EDM 와이드',
    plain: '좌우를 넓게 벌리고 저음을 단단하게. 클럽·페스티벌용 사운드입니다.',
  },
  'ballad-vocal': {
    ko: '발라드 보컬',
    plain: '목소리가 앞으로 나오도록 중음을 살리고, 반주는 뒤로 물립니다. 조용한 곡에 맞습니다.',
  },
  'piano-natural': {
    ko: '피아노 자연스럽게',
    plain: '건드리는 것을 최소로. 연주의 셈여림을 그대로 두고 음량만 정리합니다.',
  },
  'vintage-soft': {
    ko: '빈티지 부드럽게',
    plain: '아날로그 기기를 거친 것처럼 모서리를 둥글게 만듭니다. 디지털 특유의 날카로움이 줄어듭니다.',
  },
  'ai-vocal-cleaner': {
    ko: 'AI 보컬 정리',
    plain: 'AI 보컬이 2~5 kHz에서 따갑게 들리는 것을 눌러주고, 탁한 저중음을 걷어냅니다.',
  },
  'ai-vocal-texture': {
    ko: 'AI 보컬 질감 복구',
    plain: 'Suno 같은 AI 음원 보컬의 "물먹은 듯 번들거리는" 고음을 걷어내고, 멀쩡한 중음에서 새 고음을 만들어 채웁니다. 기성 음원에 가까운 질감이 됩니다.',
  },
  'cymbal-smooth': {
    ko: '심벌 부드럽게',
    plain: 'AI가 만든 심벌·하이햇이 금속처럼 쨍하게 튀는 것을 눌러 부드럽게 만듭니다.',
  },
  'stereo-repair': {
    ko: '스테레오 복구',
    plain: '좌우가 어색하게 벌어진 것을 정리합니다. 휴대폰 스피커처럼 모노로 들을 때 소리가 사라지는 것을 막습니다.',
  },
  'mono-safe-shorts': {
    ko: '숏폼 모노 안전',
    plain: '틱톡·릴스·쇼츠처럼 한쪽 스피커로 듣는 환경에 맞춥니다. 모노로 합쳐도 소리가 빠지지 않습니다.',
  },
};

export function presetGlossaryFor(id: string): PresetGlossaryEntry | undefined {
  return P[id];
}

/** Preset ids that have no Korean entry — used by the coverage test. */
export function presetsMissingKorean(): string[] {
  return LOUI_PRESETS.filter((p) => !P[p.id]).map((p) => p.id);
}

/** Entries that name no preset — a translation that has drifted. */
export function orphanedPresetGlossaryKeys(): string[] {
  const ids = new Set(LOUI_PRESETS.map((p) => p.id));
  return Object.keys(P).filter((k) => !ids.has(k));
}
