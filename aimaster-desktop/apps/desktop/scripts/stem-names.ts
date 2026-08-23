// Which stem a file called "4 Guitar.wav" belongs in.
//
// Matched loosely against the Moises / Music.AI naming, which is what the
// commercial separators and most session exports produce.  Loosely on purpose:
// people rename these, and a benchmark that only accepts one spelling is a
// benchmark nobody runs twice.
//
// The important decision is the SECOND column.  This app cannot make a guitar
// stem — a guitar and an electric piano differ in timbre, and every cue here is
// about position, duration or register — so a guitar file is not "unmatched",
// it is ground truth for 그 외, which is the stem that is supposed to hold it.
// Scoring 그 외 against the guitar file is scoring the separator against what
// it is actually trying to do.

import path from 'node:path';
import type { StemKind } from '../src/renderer/daw/audio/separate/separate.js';

export interface StemFileRule {
  match: RegExp;
  into: StemKind;
  /** Said once, when a file lands somewhere a reader might not expect. */
  note?: string;
}

/** Order matters: "Backing Vocals" has to be tried before "Vocals". */
export const STEM_FILE_RULES: readonly StemFileRule[] = [
  { match: /lead\s*vocal|main\s*vocal|^\d*\s*vox\b|리드/i, into: 'lead' },
  { match: /back(ing)?\s*vocal|harmon(y|ies)|chorus|코러스/i, into: 'backing' },
  { match: /\bkick\b|bass\s*drum|킥/i, into: 'kick' },
  { match: /percussion|shaker|tambour|conga|bongo|퍼커션/i, into: 'kit',
    note: '퍼커션은 드럼 킷과 같은 스템으로 칩니다 — 둘 다 타격이라 이 앱은 나누지 않습니다' },
  { match: /drum|\bkit\b|드럼/i, into: 'kit' },
  { match: /\bbass\b|베이스/i, into: 'bass' },
  { match: /vocal|보컬/i, into: 'lead' },              // one undivided vocal file
  // Everything below is timbre, which is exactly what 그 외 is.
  { match: /guitar|기타/i, into: 'other' },
  { match: /key(s|board)?\b|piano|rhodes|organ|wurli|건반/i, into: 'other' },
  { match: /synth|\bpad\b|신스/i, into: 'other' },
  { match: /string|violin|cello|스트링/i, into: 'other' },
  { match: /brass|horn|\bsax\b|trumpet|trombone|브라스/i, into: 'other' },
  { match: /wind|flute|clarinet|oboe|목관/i, into: 'other' },
  { match: /other|misc|\bfx\b|그\s*외/i, into: 'other' },
];

/** Null when nothing matched — the caller lists those rather than guessing. */
export function classifyStemFile(name: string): { into: StemKind; note?: string } | null {
  const stem = path.basename(name).replace(/\.[^.]+$/, '');
  for (const rule of STEM_FILE_RULES) {
    if (rule.match.test(stem)) {
      return rule.note === undefined ? { into: rule.into } : { into: rule.into, note: rule.note };
    }
  }
  return null;
}
