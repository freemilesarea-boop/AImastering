// What is this track FOR?
//
// Every mixing decision downstream needs an answer: how loud a track should
// sit, who wins when two things fight for the same band, whether it should be
// centred or spread.  A mixer knows because they can hear it.  This layer has
// to infer it, and the only reliable signal available before any audio is
// analysed is the name the user typed.
//
// So this is a keyword matcher, and it says so.  It is deliberately NOT
// dressed up as more than that:
//
//   • It reports a confidence, and an unmatched name gets `other` with
//     confidence 0 rather than a guess.
//   • Everything that consumes a role treats `other` as "leave it alone".
//   • Korean and English are matched equally, because that is what the names
//     in this app's sessions actually look like.
//
// Audio-derived refinement (a track whose energy is all below 100 Hz is a
// bass, whatever it is called) is layered on top in `refineRole`, so the name
// is a prior and the measurement gets the last word.

export type TrackRole =
  | 'vocal' | 'backing' | 'kick' | 'snare' | 'hat' | 'drums' | 'bass'
  | 'guitar' | 'keys' | 'synth' | 'pad' | 'fx' | 'bus' | 'master' | 'other';

interface RoleRule {
  role: TrackRole;
  keywords: readonly string[];
}

// Order matters: the most specific names are tested first, so "vocal double"
// lands on `backing` and not on `vocal`.
const RULES: readonly RoleRule[] = [
  { role: 'backing', keywords: ['double', 'dbl', 'harmony', 'harm', 'adlib', 'ad-lib', 'backing', 'bgv', 'chorus vox', '더블', '하모니', '애드립', '코러스'] },
  { role: 'kick', keywords: ['kick', 'bd', 'bassdrum', 'bass drum', '킥'] },
  { role: 'snare', keywords: ['snare', 'sd', 'clap', 'rim', '스네어', '클랩', '림'] },
  { role: 'hat', keywords: ['hat', 'hh', 'cymbal', 'ride', 'crash', 'shaker', 'tamb', '하이햇', '햇', '심벌', '라이드'] },
  { role: 'vocal', keywords: ['vocal', 'vox', 'lead vox', 'voice', '보컬', '보이스', '노래'] },
  { role: 'bass', keywords: ['bass', '808', 'sub', '베이스', '서브'] },
  { role: 'drums', keywords: ['drum', 'perc', 'tom', 'loop', 'beat', '드럼', '퍼커션', '탐', '비트'] },
  { role: 'guitar', keywords: ['guitar', 'gtr', 'acoustic', 'ac gt', '기타', '어쿠스틱'] },
  { role: 'keys', keywords: ['piano', 'key', 'rhodes', 'wurli', 'organ', 'ep', '피아노', '건반', '오르간'] },
  { role: 'pad', keywords: ['pad', 'string', 'strings', 'choir', 'atmos', '패드', '스트링', '합창'] },
  { role: 'synth', keywords: ['synth', 'arp', 'pluck', 'saw', 'lead', '신스', '아르페지오', '리드'] },
  { role: 'fx', keywords: ['fx', 'riser', 'impact', 'sweep', 'noise', 'foley', 'sfx', '효과', '이펙트'] },
];

export interface RoleGuess {
  role: TrackRole;
  /** 0…1.  Zero means "no idea", and callers must respect that. */
  confidence: number;
  /** The keyword that matched, for the UI to show its work. */
  matched: string | null;
}

export function guessRole(name: string, kind?: string): RoleGuess {
  if (kind === 'master') return { role: 'master', confidence: 1, matched: null };
  if (kind === 'folder' || kind === 'aux' || kind === 'vca') {
    return { role: 'bus', confidence: 0.8, matched: null };
  }
  const text = name.toLowerCase();
  for (const rule of RULES) {
    for (const keyword of rule.keywords) {
      if (!text.includes(keyword)) continue;
      // A keyword that is the whole name is a stronger signal than one buried
      // in "Gtr Bus Reverb Return".
      const exact = text.trim() === keyword;
      return { role: rule.role, confidence: exact ? 0.95 : 0.75, matched: keyword };
    }
  }
  return { role: 'other', confidence: 0, matched: null };
}

export interface SpectralShape {
  /** Fraction of energy below 120 Hz. */
  lowShare: number;
  /** Fraction between 120 Hz and 2 kHz. */
  midShare: number;
  /** Fraction above 6 kHz. */
  highShare: number;
  /** Peak-to-loudness ratio — percussion is high, a pad is low. */
  crestDb: number;
}

/**
 * Let the audio correct the name.
 *
 * A track called "Audio 3" tells us nothing; its spectrum tells us a lot.  The
 * measurement only OVERRIDES a name when the name was a weak guess, because a
 * user who typed "Vocal" meant it even if the take is unusually dark.
 */
export function refineRole(guess: RoleGuess, shape: SpectralShape): RoleGuess {
  if (guess.confidence >= 0.75) return guess;

  if (shape.lowShare > 0.7 && shape.crestDb > 12) {
    return { role: 'kick', confidence: 0.5, matched: '측정: 저역 + 높은 크레스트' };
  }
  if (shape.lowShare > 0.7) {
    return { role: 'bass', confidence: 0.5, matched: '측정: 저역 집중' };
  }
  if (shape.highShare > 0.45 && shape.crestDb > 12) {
    return { role: 'hat', confidence: 0.45, matched: '측정: 고역 + 높은 크레스트' };
  }
  if (shape.midShare > 0.6 && shape.crestDb < 8) {
    return { role: 'pad', confidence: 0.4, matched: '측정: 중역 + 낮은 크레스트' };
  }
  return guess;
}

// ── What a role wants ─────────────────────────────────────────────────────────

export interface RoleProfile {
  /** Level relative to the loudest element, LU.  A starting point, not a law. */
  offsetLu: number;
  /** Who wins a frequency fight.  Higher survives. */
  priority: number;
  /** Where it usually sits.  0 = centre. */
  pan: number;
  /** Below this the track is probably too quiet to be intentional. */
  label: string;
}

/**
 * Starting levels, in LU below the loudest element.  These are the numbers a
 * mixer starts from and then ignores; the point is to get a rough balance in
 * one press so the real work begins somewhere sane.
 */
export const ROLE_PROFILES: Record<TrackRole, RoleProfile> = {
  vocal:   { offsetLu: 0,   priority: 100, pan: 0,     label: '리드 보컬' },
  backing: { offsetLu: -6,  priority: 40,  pan: 0.35,  label: '백킹 보컬' },
  kick:    { offsetLu: -1,  priority: 90,  pan: 0,     label: '킥' },
  snare:   { offsetLu: -2,  priority: 80,  pan: 0,     label: '스네어' },
  hat:     { offsetLu: -9,  priority: 30,  pan: 0.2,   label: '하이햇' },
  drums:   { offsetLu: -3,  priority: 70,  pan: 0,     label: '드럼' },
  bass:    { offsetLu: -2,  priority: 85,  pan: 0,     label: '베이스' },
  guitar:  { offsetLu: -6,  priority: 50,  pan: 0.5,   label: '기타' },
  keys:    { offsetLu: -7,  priority: 45,  pan: 0.25,  label: '건반' },
  synth:   { offsetLu: -7,  priority: 45,  pan: 0.3,   label: '신스' },
  pad:     { offsetLu: -11, priority: 20,  pan: 0.6,   label: '패드' },
  fx:      { offsetLu: -13, priority: 10,  pan: 0.4,   label: 'FX' },
  bus:     { offsetLu: 0,   priority: 60,  pan: 0,     label: '버스' },
  master:  { offsetLu: 0,   priority: 0,   pan: 0,     label: '마스터' },
  other:   { offsetLu: -6,  priority: 50,  pan: 0,     label: '기타' },
};

export function roleLabel(role: TrackRole): string {
  return ROLE_PROFILES[role].label;
}
