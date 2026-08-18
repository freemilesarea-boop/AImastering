// TrackColors — a colour per instrument, so a session reads at a glance.
//
// A DAW's arrange window is scanned, not read: an engineer looking for the
// bass looks for the blue block, not for the word "bass". The colours are
// therefore assigned by ROLE rather than by track order — the same
// instrument is the same colour in every session, which is what makes the
// habit worth having. Cubase's own defaults work the same way, and these
// follow the same broad grouping: drums warm, bass blue, voices gold,
// harmony green, effects violet.

import type { StemRole } from '../../audio/presets/stem-defaults.js';

export const ROLE_COLOR: Record<StemRole, string> = {
  kick:         '#ef4444',
  snare:        '#f97316',
  drums:        '#fb923c',
  bass:         '#3b82f6',
  vocal:        '#eab308',
  'vocal-back': '#facc15',
  guitar:       '#22c55e',
  keys:         '#14b8a6',
  fx:           '#a855f7',
  mid:          '#64748b',
  other:        '#52525b',
};

export const ROLE_LABEL: Record<StemRole, string> = {
  kick: '킥', snare: '스네어', drums: '드럼/퍼커션', bass: '베이스',
  vocal: '리드 보컬', 'vocal-back': '백 보컬', guitar: '기타',
  keys: '건반/신스', fx: '효과음', mid: '중역 악기', other: '미분류',
};

export function trackColor(role: StemRole): string {
  return ROLE_COLOR[role] ?? ROLE_COLOR.other;
}

export function roleLabel(role: StemRole): string {
  return ROLE_LABEL[role] ?? ROLE_LABEL.other;
}
