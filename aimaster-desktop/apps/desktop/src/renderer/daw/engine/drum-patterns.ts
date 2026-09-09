// Twenty beats, two per genre.
//
// The kits in `drum-presets.ts` say what the drums sound like.  This says what
// they PLAY, which is the other half of "give me 힙합 drums" and the half you
// cannot get to by turning knobs.
//
// ── Why they are written as charts ──────────────────────────────────────────
//
// Every pattern below is a row of characters per drum, one character per step,
// because that is how a drummer or a drum machine writes a beat and it means
// the table can be READ.  A pattern stored as an array of note objects is
// unreviewable: nobody can look at 34 objects and say "that snare is on the
// wrong beat", and a wrong beat is the only bug these can have.
//
//     kick   X--x--X---x-----
//     snare  ----X-------X---
//     hat    x-x-x-x-x-x-x-x-
//
//   -    nothing
//   x    a hit
//   X    an accent
//   o    a ghost note — audible, deliberately weak, and the thing that
//        separates a groove from a grid
//   2 3 4  a ratchet: the step retriggers that many times (trap hat rolls)
//
// ── Nothing here renders audio ──────────────────────────────────────────────
//
// A chart becomes a `StepPattern`, and the step sequencer's own
// `stepsToNotes` turns that into notes — swing, ratchets, gate and velocity
// included.  Writing a second converter here would mean two definitions of
// where a swung sixteenth falls, and they would disagree within a month.

import {
  DEFAULT_STEP, createChannel, createPattern, stepsToNotes,
  type StepPattern,
} from '../model/step-sequencer.js';
import { from7bit, type MidiNote } from '../model/midi.js';
import { GENRE_LABEL, type GenreId } from './plugin-presets-genre.js';

/** One drum's row in a chart. */
export interface PatternRow {
  /** General MIDI pitch — the same numbers the kit and the drum map use. */
  pitch: number;
  /** One character per step.  See the legend above. */
  steps: string;
}

export interface DrumPattern {
  id: string;
  genre: GenreId;
  name: string;
  /** Grid resolution: 4 = sixteenths, 3 = eighth-note triplets. */
  stepsPerBeat: number;
  /** 0 = straight.  Pushes odd steps late — see `stepTime`. */
  swing: number;
  /** What this beat IS, in one line.  Shown in the menu. */
  note: string;
  rows: readonly PatternRow[];
}

// The pitches, named so the charts read as music rather than as numbers.
const KICK = 36, SNARE = 38, RIM = 37, CLAP = 39;
const HAT = 42, HAT_PEDAL = 44, HAT_OPEN = 46;
const TOM_LO = 41, TOM_MID = 47, TOM_HI = 50;
const CRASH = 49, RIDE = 51, TAMB = 54;

const ACCENT = from7bit(118);
const HIT = from7bit(96);
const GHOST = from7bit(46);

/**
 * The beats.
 *
 * Two per genre: the one you would play first, and one that is a different
 * decision rather than the same beat with an extra hat.  Each carries the
 * claim it is making in its `note`, and the self-test checks the claims
 * against the notes that come out.
 */
export const DRUM_PATTERNS: readonly DrumPattern[] = [
  // ── 재즈 ─────────────────────────────────────────────────────────────────
  // The grid is TRIPLETS, not swung sixteenths.  Jazz time is a triplet feel
  // all the way down, and writing it as 16ths with a swing amount is an
  // approximation that never quite lands on the third triplet.
  {
    id: 'jazz-ride', genre: 'jazz', name: '스윙 라이드', stepsPerBeat: 3, swing: 0,
    note: '라이드가 박자를 잡고, 하이햇은 2·4, 킥은 깃털처럼',
    rows: [
      // ding — ding-da-ding — the pattern the whole style is built on.
      { pitch: RIDE,      steps: 'x--x-xx--x-x' },
      { pitch: HAT_PEDAL, steps: '---x-----x--' },
      // Feathered: on all four, so quiet you feel it as time rather than hear
      // it as a drum.
      { pitch: KICK,      steps: 'o--o--o--o--' },
      { pitch: SNARE,     steps: '----o-----o-' },
    ],
  },
  {
    id: 'jazz-brush', genre: 'jazz', name: '브러시 컴핑', stepsPerBeat: 3, swing: 0,
    note: '스네어가 대화하는 쪽 — 라이드는 물러나고 고스트가 앞으로',
    rows: [
      { pitch: RIDE,      steps: 'x--x-x---x--' },
      { pitch: HAT_PEDAL, steps: '---x-----x--' },
      { pitch: SNARE,     steps: 'o-oo-o-o-oo-' },
      { pitch: KICK,      steps: 'o-----o-----' },
    ],
  },

  // ── 로파이 ───────────────────────────────────────────────────────────────
  // Boom bap with the sixteenths dragged.  The swing is what makes it sleepy;
  // the same chart at swing 0 is a stiff hip-hop beat from 1988.
  {
    id: 'lofi-boombap', genre: 'lofi', name: '붐뱁', stepsPerBeat: 4, swing: 0.28,
    note: '느리게 끌리는 16분 — 킥과 스네어 사이가 넓습니다',
    rows: [
      { pitch: KICK,  steps: 'X-----x---X-----' },
      { pitch: SNARE, steps: '----X-------X---' },
      { pitch: HAT,   steps: 'x-o-x-o-x-o-x-o-' },
    ],
  },
  {
    id: 'lofi-halftime', genre: 'lofi', name: '하프타임', stepsPerBeat: 4, swing: 0.32,
    note: '스네어를 3박으로 — 같은 템포에서 절반 속도로 들립니다',
    rows: [
      { pitch: KICK,     steps: 'X-------x-x-----' },
      { pitch: SNARE,    steps: '--------X-------' },
      { pitch: HAT,      steps: 'x-o-x-o-x-o-x-o-' },
      { pitch: HAT_OPEN, steps: '--------------x-' },
    ],
  },

  // ── 앰비언트 ─────────────────────────────────────────────────────────────
  // Two bars, because one bar of this is not long enough to be a texture.
  {
    id: 'ambient-pulse', genre: 'ambient', name: '느린 펄스', stepsPerBeat: 4, swing: 0,
    note: '2마디에 킥 두 번 — 리듬이라기보다 호흡',
    rows: [
      { pitch: KICK,     steps: 'x---------------x---------------' },
      { pitch: HAT_OPEN, steps: '--------x---------------x-------' },
      { pitch: RIDE,     steps: '------------o---------------o---' },
      { pitch: CRASH,    steps: 'x-------------------------------' },
    ],
  },
  {
    id: 'ambient-scatter', genre: 'ambient', name: '흩어진 타점', stepsPerBeat: 4, swing: 0.18,
    note: '규칙이 잡히기 직전까지만 — 반복이 보이면 리듬이 됩니다',
    rows: [
      { pitch: KICK,     steps: 'x-----------x-------------------' },
      { pitch: RIM,      steps: '-----o---------o------o---------' },
      { pitch: HAT_OPEN, steps: '----------x-----------------x---' },
      { pitch: RIDE,     steps: '--o---------------o-------------' },
    ],
  },

  // ── 클래식 ───────────────────────────────────────────────────────────────
  // A GM kit is not an orchestra, and pretending otherwise would be the
  // dishonest option.  These are the two percussion figures a kit CAN play
  // that belong to this music: a march and a timpani roll into a hit.
  {
    id: 'classic-march', genre: 'classic', name: '행진곡', stepsPerBeat: 4, swing: 0,
    note: '군악대 행진 — 베이스드럼 1·3, 스네어가 채웁니다',
    rows: [
      { pitch: KICK,  steps: 'X-------X-------' },
      { pitch: SNARE, steps: '----x-x-o-x-x-x-' },
      { pitch: CRASH, steps: 'X---------------' },
    ],
  },
  {
    id: 'classic-timpani', genre: 'classic', name: '팀파니 롤', stepsPerBeat: 4, swing: 0,
    note: '롤로 부풀렸다가 한 방 — 라쳇이 롤을 만듭니다',
    rows: [
      // Ratchets, growing: this is the whole figure.
      { pitch: TOM_LO, steps: '2---3---4---4---' },
      { pitch: KICK,   steps: '---------------X' },
      { pitch: CRASH,  steps: '---------------X' },
    ],
  },

  // ── K-POP ────────────────────────────────────────────────────────────────
  {
    id: 'kpop-tight', genre: 'kpop', name: '타이트 4/4', stepsPerBeat: 4, swing: 0,
    note: '클랩이 2·4, 16분 하이햇, 킥은 짧게 세 번',
    rows: [
      { pitch: KICK, steps: 'X-----x-X-------' },
      { pitch: CLAP, steps: '----X-------X---' },
      { pitch: SNARE, steps: '----x-------x---' },
      { pitch: HAT,  steps: 'X-x-x-x-X-x-x-x-' },
    ],
  },
  {
    id: 'kpop-drop', genre: 'kpop', name: '드롭', stepsPerBeat: 4, swing: 0,
    note: '킥이 네 박 전부 — 후렴이 열리는 자리',
    rows: [
      { pitch: KICK,     steps: 'X---X---X---X---' },
      { pitch: CLAP,     steps: '----X-------X---' },
      { pitch: HAT,      steps: 'x-x-x-x-x-x-x-x-' },
      { pitch: HAT_OPEN, steps: '--x---x---x---x-' },
      { pitch: CRASH,    steps: 'X---------------' },
    ],
  },

  // ── 팝 ───────────────────────────────────────────────────────────────────
  {
    id: 'pop-backbeat', genre: 'pop', name: '백비트', stepsPerBeat: 4, swing: 0,
    note: '기준이 되는 비트 — 킥 1·3, 스네어 2·4, 8분 하이햇',
    rows: [
      { pitch: KICK,  steps: 'X-------X---x---' },
      { pitch: SNARE, steps: '----X-------X---' },
      { pitch: HAT,   steps: 'x-x-x-x-x-x-x-x-' },
    ],
  },
  {
    id: 'pop-driving', genre: 'pop', name: '드라이빙', stepsPerBeat: 4, swing: 0,
    note: '16분 하이햇에 고스트 스네어 — 같은 뼈대에 밀도만 올립니다',
    rows: [
      { pitch: KICK,  steps: 'X---x---X-x-----' },
      { pitch: SNARE, steps: '--o-X--o----X-o-' },
      { pitch: HAT,   steps: 'X-x-x-x-X-x-x-x-' },
      { pitch: CRASH, steps: 'X---------------' },
    ],
  },

  // ── EDM ──────────────────────────────────────────────────────────────────
  {
    id: 'edm-four', genre: 'edm', name: '4온더플로어', stepsPerBeat: 4, swing: 0,
    note: '킥이 네 박, 오픈햇이 엇박 — 사이드체인이 사는 자리',
    rows: [
      { pitch: KICK,     steps: 'X---X---X---X---' },
      { pitch: CLAP,     steps: '----X-------X---' },
      { pitch: HAT_OPEN, steps: '--x---x---x---x-' },
      { pitch: HAT,      steps: 'x-x-x-x-x-x-x-x-' },
    ],
  },
  {
    id: 'edm-break', genre: 'edm', name: '브레이크', stepsPerBeat: 4, swing: 0,
    note: '킥을 빼고 쌓아 올리는 마디 — 드롭 직전',
    rows: [
      { pitch: SNARE, steps: '--x-x-x-x-x-x-x-' },
      { pitch: CLAP,  steps: '----X-------X---' },
      { pitch: HAT,   steps: 'x-x-x-x-x-x-x-x-' },
      { pitch: KICK,  steps: '---------------X' },
      { pitch: CRASH, steps: '---------------X' },
    ],
  },

  // ── 힙합 ─────────────────────────────────────────────────────────────────
  {
    id: 'hiphop-trap', genre: 'hiphop', name: '트랩', stepsPerBeat: 4, swing: 0,
    note: '하이햇 롤이 전부 — 스네어는 3박에 하나',
    rows: [
      { pitch: KICK,  steps: 'X-----x----X----' },
      { pitch: SNARE, steps: '--------X-------' },
      // The rolls.  A trap beat without ratchets is a slow 16th pattern.
      { pitch: HAT,   steps: 'x-x-x3x-x-x-x2x4' },
    ],
  },
  {
    id: 'hiphop-boom', genre: 'hiphop', name: '붐뱁 90s', stepsPerBeat: 4, swing: 0.16,
    note: '살짝 스윙된 16분, 고스트 스네어가 사이를 메웁니다',
    rows: [
      { pitch: KICK,  steps: 'X---x-X---X-x---' },
      { pitch: SNARE, steps: '----X-o-----X-o-' },
      { pitch: HAT,   steps: 'x-x-x-x-x-x-x-x-' },
      { pitch: RIM,   steps: '----------o-----' },
    ],
  },

  // ── R&B ──────────────────────────────────────────────────────────────────
  {
    id: 'rnb-laidback', genre: 'rnb', name: '레이드백', stepsPerBeat: 4, swing: 0.24,
    note: '고스트 노트가 그루브를 잡습니다 — 스네어가 제일 바쁩니다',
    rows: [
      { pitch: KICK,  steps: 'X-----x---X-----' },
      { pitch: SNARE, steps: '--o-X-o-o-o-X-o-' },
      { pitch: HAT,   steps: 'x-x-x-x-x-x-x-x-' },
    ],
  },
  {
    id: 'rnb-neo', genre: 'rnb', name: '네오소울', stepsPerBeat: 4, swing: 0.3,
    note: '더 끌리게, 하이햇을 열어서 — 격자에서 멀어질수록 맞습니다',
    rows: [
      { pitch: KICK,     steps: 'X-------x-X-----' },
      { pitch: SNARE,    steps: '--o-X--o--o-X---' },
      { pitch: HAT,      steps: 'x-o-x-o-x-o-x-o-' },
      { pitch: HAT_OPEN, steps: '------x-------x-' },
      { pitch: TAMB,     steps: '----x-------x---' },
    ],
  },

  // ── J-POP ────────────────────────────────────────────────────────────────
  {
    id: 'jpop-drive', genre: 'jpop', name: '드라이브', stepsPerBeat: 4, swing: 0,
    note: '록 킷을 밝게 — 킥이 바쁘고 크래시가 마디를 엽니다',
    rows: [
      { pitch: KICK,  steps: 'X-x-----X-x-x---' },
      { pitch: SNARE, steps: '----X-------X---' },
      { pitch: HAT,   steps: 'X-x-x-x-X-x-x-x-' },
      { pitch: CRASH, steps: 'X---------------' },
    ],
  },
  {
    id: 'jpop-fill', genre: 'jpop', name: '톰 필', stepsPerBeat: 4, swing: 0,
    note: '한 마디짜리 필 — 톰을 내려가면서 크래시로 착지',
    rows: [
      { pitch: SNARE,  steps: 'X-x-X-x---------' },
      { pitch: TOM_HI, steps: '--------X-x-----' },
      { pitch: TOM_MID, steps: '------------X---' },
      { pitch: TOM_LO, steps: '--------------X-' },
      { pitch: CRASH,  steps: '---------------X' },
      { pitch: KICK,   steps: 'X--------------X' },
    ],
  },
];

// ── Reading a chart ─────────────────────────────────────────────────────────

/** What one character means.  `null` is an empty step. */
function readCell(ch: string): { velocity: number; ratchet: number } | null {
  if (ch === '-' || ch === ' ') return null;
  if (ch === 'X') return { velocity: ACCENT, ratchet: 1 };
  if (ch === 'x') return { velocity: HIT, ratchet: 1 };
  if (ch === 'o') return { velocity: GHOST, ratchet: 1 };
  const n = Number(ch);
  // A ratchet is played at full weight: a roll that ghosts is a mistake.
  if (Number.isFinite(n) && n >= 2 && n <= 8) return { velocity: HIT, ratchet: n };
  return null;
}

/** The longest row decides the grid — a short row is padded with silence. */
export function patternSteps(pattern: DrumPattern): number {
  return pattern.rows.reduce((m, r) => Math.max(m, r.steps.length), 0);
}

/** Length in beats, which is what a part's duration has to match. */
export function patternBeatLength(pattern: DrumPattern): number {
  return patternSteps(pattern) / Math.max(1, pattern.stepsPerBeat);
}

/**
 * A chart becomes the step sequencer's own pattern type.
 *
 * Going through `StepPattern` rather than straight to notes means these beats
 * open in the step sequencer as grids you can edit, and it means swing,
 * ratchets and gate have exactly one definition in this program.
 */
export function toStepPattern(pattern: DrumPattern): StepPattern {
  const stepCount = patternSteps(pattern);
  const base = createPattern(pattern.name, stepCount, pattern.stepsPerBeat);
  return {
    ...base,
    swing: pattern.swing,
    channels: pattern.rows.map((row) => {
      const channel = createChannel(String(row.pitch), row.pitch, stepCount);
      return {
        ...channel,
        steps: channel.steps.map((step, i) => {
          const cell = readCell(row.steps[i] ?? '-');
          if (!cell) return { ...DEFAULT_STEP };
          return { ...DEFAULT_STEP, on: true, velocity: cell.velocity, ratchet: cell.ratchet };
        }),
      };
    }),
  };
}

/** The notes, through the step sequencer's converter and no other. */
export function patternNotes(pattern: DrumPattern, repeats = 1): MidiNote[] {
  return stepsToNotes(toStepPattern(pattern), { repeats, ignoreProbability: true });
}

/**
 * How many times to repeat a chart so it is worth dropping on a track.
 *
 * One bar of a beat is not a part, it is a demonstration.  The rack's other
 * button makes four bars, so a pattern fills the same space — two repeats of
 * the two-bar 앰비언트 chart, four of a one-bar 팝 one.
 */
export function patternFill(
  pattern: DrumPattern, beatsPerBar: number, minBars = 4,
): { repeats: number; beats: number } {
  const one = patternBeatLength(pattern);
  const want = Math.max(1, beatsPerBar) * Math.max(1, minBars);
  const repeats = one > 0 ? Math.max(1, Math.ceil(want / one)) : 1;
  return { repeats, beats: one * repeats };
}

export function patternsForGenre(genre: GenreId): DrumPattern[] {
  return DRUM_PATTERNS.filter((p) => p.genre === genre);
}

export function findPattern(id: string): DrumPattern | undefined {
  return DRUM_PATTERNS.find((p) => p.id === id);
}

/** `힙합 · 트랩 — 하이햇 롤이 전부 …`, for the menu and the toast. */
export function describePattern(pattern: DrumPattern): string {
  return `${GENRE_LABEL[pattern.genre]} · ${pattern.name} — ${pattern.note}`;
}
