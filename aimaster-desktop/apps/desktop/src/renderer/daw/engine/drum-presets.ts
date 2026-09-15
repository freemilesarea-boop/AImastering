// Ten kits, one per genre.
//
// The genre presets in `plugin-presets-genre.ts` set up DEVICES — a compressor
// for 힙합 is not a compressor for 재즈.  This is the same idea one step
// earlier: the drums themselves are different instruments before anything is
// done to them.  A jazz kick is not a pop kick turned down; it is an 18"
// drum, tuned higher, damped less, played so it is felt rather than heard.
// A trap kick is an 808 — long enough to be a bass note, and the reason a
// trap track often has no bass part at all.
//
// ── Why per-piece and not just five knobs ───────────────────────────────────
//
// Five global knobs can make the whole kit darker or longer.  They cannot say
// "the ride is the timekeeper and the kick stays out of the way", which is
// most of what makes a jazz kit a jazz kit.  So a preset is a set of global
// params AND a table of per-piece overrides, and it is the second half that
// does the work.
//
// ── How it survives ─────────────────────────────────────────────────────────
//
// The chosen kit is stored as a NUMBER in `track.instrumentParams`, like every
// other instrument parameter, so it goes through save, load, undo, templates,
// freeze and the offline bounce without any of them knowing what it is.  An
// enum on the track would have needed all six of those taught about it.
//
// 0 means the built-in kit; 1..10 are `GENRE_ORDER`.  That ordering is load
// bearing and the self-test asserts it: shifting it by one would silently
// swap every saved session's kit for its neighbour.

import { DRUM_KIT, drumSpecFor, type DrumSpec } from './drum-model.js';
import { GENRE_LABEL, GENRE_ORDER, type GenreId } from './plugin-presets-genre.js';

/** A per-piece patch: everything a genre wants to say about one drum. */
export type PiecePatch = Partial<Pick<DrumSpec, 'hz' | 'decay' | 'level' | 'pan' | 'sweep' | 'tone' | 'air'>>;

export interface DrumKitPreset {
  id: GenreId;
  /** The five globals, written whole so a preset is not a diff of a diff. */
  params: { level: number; tune: number; decay: number; tone: number; snap: number };
  /** Overrides by General MIDI pitch. */
  pieces: Readonly<Record<number, PiecePatch>>;
  /** One line, shown in the rack — the claim this preset is making. */
  note: string;
}

// The GM pitches these tables talk about, named so the tables read as music.
const KICK = 36, KICK2 = 35;
const SNARE = 38, RIM = 37, CLAP = 39, SNARE_RIM = 40;
const TOM_LO = 41, TOM_HIFLOOR = 43, TOM_LOW = 45, TOM_LOMID = 47, TOM_HIMID = 48, TOM_HI = 50;
const HAT_CLOSED = 42, HAT_PEDAL = 44, HAT_OPEN = 46;
const CRASH = 49, CRASH2 = 57, RIDE = 51, RIDE_BELL = 53, RIDE2 = 59;
const CHINA = 52, SPLASH = 55, TAMB = 54, COWBELL = 56;

/**
 * The kits.
 *
 * Every number below is an argument.  If you think a jazz kick sits at 55 Hz
 * rather than 68, that is a claim about a row in this table, not about taste.
 */
export const DRUM_GENRE_PRESETS: Readonly<Record<GenreId, DrumKitPreset>> = {
  // A small bebop kit in a room.  The kick is an 18" drum played with the
  // heel down: high, short, quiet — you feel it, you do not hear it.  The
  // RIDE is the timekeeper, so it is the loudest thing in the kit and it
  // rings; the snare is tuned high with the wires loose for brushes and
  // ghost notes.  Nothing is gated and nothing is tight.
  jazz: {
    id: 'jazz',
    params: { level: 0.72, tune: 2, decay: 1.25, tone: 1.15, snap: 0.35 },
    note: '작은 비밥 킷 — 라이드가 시계, 킥은 들리지 않고 느껴집니다',
    pieces: {
      [KICK]:       { hz: 68, decay: 0.22, level: 0.62, sweep: 3.0 },
      [KICK2]:      { hz: 62, decay: 0.26, level: 0.62, sweep: 2.8 },
      [SNARE]:      { hz: 230, decay: 0.16, level: 0.78, tone: 7.0 },
      [SNARE_RIM]:  { hz: 280, decay: 0.13, level: 0.72 },
      [RIM]:        { level: 0.62 },
      [CLAP]:       { level: 0.30 },
      [HAT_CLOSED]: { decay: 0.055, level: 0.48 },
      [HAT_OPEN]:   { decay: 1.10, level: 0.50 },
      [RIDE]:       { decay: 2.60, level: 0.82 },
      [RIDE2]:      { decay: 2.80, level: 0.80 },
      [RIDE_BELL]:  { decay: 1.80, level: 0.78 },
      [CRASH]:      { decay: 3.40, level: 0.58 },
      [CRASH2]:     { decay: 3.60, level: 0.58 },
      [TOM_LO]:     { hz: 78, decay: 0.72, level: 0.78 },
      [TOM_HI]:     { hz: 205, decay: 0.44, level: 0.78 },
    },
  },

  // Degraded on purpose.  No air at all above ~9 kHz, so cymbals are barely
  // there; the 200–500 Hz box is KEPT rather than carved, so the kick is
  // small and boxy and the snare has body instead of crack.  Everything a
  // mix engineer removes, this genre puts back.
  lofi: {
    id: 'lofi',
    params: { level: 0.66, tune: -1, decay: 0.85, tone: 0.55, snap: 0.25 },
    note: '먼지 낀 킷 — 에어 없음, 200–500 Hz 박스는 그대로 둡니다',
    pieces: {
      // `air` is the ceiling, and 로파이 is the reason it exists: every noise
      // voice is HIGHPASSED, so `tone` can only open the kit up.  Measured
      // before this field existed, this kit had 2.3x K-POP's high end while
      // its own comment claimed it had none.
      [KICK]:       { hz: 58, decay: 0.28, level: 0.86, sweep: 2.6, air: 6000 },
      [KICK2]:      { hz: 52, decay: 0.32, level: 0.86, sweep: 2.4, air: 6000 },
      [SNARE]:      { hz: 175, decay: 0.17, level: 0.76, tone: 5.0, air: 7000 },
      [SNARE_RIM]:  { hz: 210, decay: 0.14, level: 0.72, tone: 6.0, air: 7000 },
      [HAT_CLOSED]: { hz: 5200, decay: 0.04, level: 0.36, air: 8000 },
      [HAT_PEDAL]:  { hz: 4600, decay: 0.07, level: 0.34, air: 8000 },
      [HAT_OPEN]:   { hz: 4800, decay: 0.42, level: 0.36, air: 8000 },
      [CRASH]:      { hz: 3400, decay: 1.60, level: 0.38, air: 7500 },
      [CRASH2]:     { hz: 3200, decay: 1.70, level: 0.38, air: 7500 },
      [RIDE]:       { hz: 3600, decay: 1.10, level: 0.34, air: 7500 },
      [RIDE2]:      { hz: 3400, decay: 1.20, level: 0.32, air: 7500 },
      [RIDE_BELL]:  { hz: 3800, decay: 0.90, level: 0.36, air: 7500 },
      [CHINA]:      { decay: 1.40, level: 0.36, air: 7000 },
      [SPLASH]:     { hz: 4200, decay: 0.70, level: 0.34, air: 7500 },
      [TAMB]:       { hz: 5600, level: 0.30, air: 8000 },
    },
  },

  // Percussion as texture, not as time.  Nothing has a front edge: the snap
  // is nearly off, every tail is long, and the cymbals are the point.  A
  // transient here is the enemy.
  ambient: {
    id: 'ambient',
    params: { level: 0.60, tune: -3, decay: 1.9, tone: 0.95, snap: 0.08 },
    note: '리듬이 아니라 질감 — 어택은 지우고 테일만 남깁니다',
    pieces: {
      [KICK]:       { hz: 46, decay: 0.85, level: 0.70, sweep: 2.0 },
      [KICK2]:      { hz: 42, decay: 1.00, level: 0.70, sweep: 1.8 },
      [SNARE]:      { hz: 160, decay: 0.55, level: 0.52, tone: 6.0 },
      [SNARE_RIM]:  { decay: 0.45, level: 0.50 },
      [HAT_CLOSED]: { decay: 0.20, level: 0.34, air: 12000 },
      [HAT_OPEN]:   { decay: 2.20, level: 0.40, air: 12000 },
      [CRASH]:      { decay: 6.00, level: 0.60, air: 12000 },
      [CRASH2]:     { decay: 6.50, level: 0.60, air: 12000 },
      [CHINA]:      { decay: 5.00, level: 0.55, air: 11000 },
      [RIDE]:       { decay: 4.00, level: 0.48, air: 12000 },
      [TOM_LO]:     { decay: 1.60, level: 0.70 },
      [TOM_HI]:     { decay: 1.10, level: 0.70 },
    },
  },

  // Orchestral percussion, which a General MIDI kit is not.  This is the
  // closest honest reading of it: a concert bass drum (very low, very long,
  // no beater click), timpani-ish toms, and cymbals that are crashed rather
  // than played.  There is no hi-hat in an orchestra, so the hats are pulled
  // down rather than pretending.
  classic: {
    id: 'classic',
    params: { level: 0.70, tune: -5, decay: 1.7, tone: 0.9, snap: 0.12 },
    note: '오케스트라 타악기 — 콘서트 베이스드럼과 팀파니 쪽으로',
    pieces: {
      [KICK]:       { hz: 40, decay: 1.30, level: 0.90, sweep: 1.8 },
      [KICK2]:      { hz: 36, decay: 1.50, level: 0.90, sweep: 1.6 },
      [SNARE]:      { hz: 205, decay: 0.22, level: 0.70, tone: 9.0 },
      [SNARE_RIM]:  { hz: 250, decay: 0.18, level: 0.66 },
      [HAT_CLOSED]: { level: 0.18 },
      [HAT_PEDAL]:  { level: 0.16 },
      [HAT_OPEN]:   { level: 0.18 },
      [CRASH]:      { decay: 5.00, level: 0.72 },
      [CRASH2]:     { decay: 5.40, level: 0.72 },
      [RIDE]:       { level: 0.36 },
      [TOM_LO]:     { hz: 58, decay: 1.60, level: 0.88, sweep: 1.3 },
      [TOM_HIFLOOR]: { hz: 70, decay: 1.45, level: 0.88, sweep: 1.3 },
      [TOM_LOW]:    { hz: 86, decay: 1.30, level: 0.88, sweep: 1.3 },
      [TOM_LOMID]:  { hz: 104, decay: 1.15, level: 0.88, sweep: 1.3 },
      [TOM_HIMID]:  { hz: 126, decay: 1.00, level: 0.88, sweep: 1.3 },
      [TOM_HI]:     { hz: 152, decay: 0.90, level: 0.88, sweep: 1.3 },
      [COWBELL]:    { level: 0.30 },
    },
  },

  // Hard, bright and tight.  The kick is short with a lot of beater; the
  // snare cracks at 3–5 kHz; a clap sits on top of the snare rather than
  // replacing it; hats are crisp and closed.  Nothing rings, because
  // everything has to fit under a vocal stack.
  kpop: {
    id: 'kpop',
    params: { level: 0.86, tune: 0, decay: 0.72, tone: 1.5, snap: 0.9 },
    note: '단단하고 밝고 짧게 — 보컬 스택 밑에 들어가야 합니다',
    pieces: {
      [KICK]:       { hz: 54, decay: 0.26, level: 1.00, sweep: 4.6 },
      [KICK2]:      { hz: 50, decay: 0.30, level: 1.00, sweep: 4.4 },
      [SNARE]:      { hz: 205, decay: 0.15, level: 0.96, tone: 11.0 },
      [SNARE_RIM]:  { hz: 250, decay: 0.12, level: 0.92, tone: 13.0 },
      [CLAP]:       { decay: 0.20, level: 0.88, tone: 1.9 },
      [HAT_CLOSED]: { hz: 8400, decay: 0.032, level: 0.60 },
      [HAT_OPEN]:   { hz: 8000, decay: 0.34, level: 0.58 },
      [CRASH]:      { decay: 2.20, level: 0.66 },
      [CRASH2]:     { decay: 2.40, level: 0.66 },
      [RIDE]:       { decay: 1.30, level: 0.50 },
      [TOM_LO]:     { decay: 0.42, level: 0.82 },
      [TOM_HI]:     { decay: 0.26, level: 0.82 },
    },
  },

  // The middle of the road, on purpose — the kit everything else here is a
  // departure from.  Slightly bright, controlled tails, a kick you can hear
  // on a phone and a snare that is neither fat nor thin.
  pop: {
    id: 'pop',
    params: { level: 0.82, tune: 0, decay: 0.9, tone: 1.15, snap: 0.65 },
    note: '기준점 — 나머지 아홉 개가 여기서 떨어져 나갑니다',
    pieces: {
      [KICK]:       { hz: 55, decay: 0.30, level: 0.98, sweep: 4.2 },
      [SNARE]:      { hz: 195, decay: 0.18, level: 0.90, tone: 9.0 },
      [CLAP]:       { level: 0.62 },
      [HAT_CLOSED]: { decay: 0.042, level: 0.56 },
      [HAT_OPEN]:   { decay: 0.60, level: 0.54 },
      [CRASH]:      { decay: 2.80, level: 0.68 },
      [RIDE]:       { decay: 1.70, level: 0.54 },
    },
  },

  // The kick is a note.  Long, tuned, barely swept — that is what a
  // four-on-the-floor track is built on, and it is why the sidechain exists.
  // Claps stand in for the snare, hats are short and bright, crashes are
  // enormous because they mark the drop.  Toms are pulled down: an EDM track
  // that fills with toms is a rock track.
  edm: {
    id: 'edm',
    params: { level: 0.9, tune: -1, decay: 1.0, tone: 1.35, snap: 0.8 },
    note: '킥이 음정입니다 — 클랩이 스네어 자리, 크래시는 드롭을 표시',
    pieces: {
      [KICK]:       { hz: 48, decay: 0.62, level: 1.00, sweep: 2.4 },
      [KICK2]:      { hz: 44, decay: 0.70, level: 1.00, sweep: 2.2 },
      [SNARE]:      { hz: 215, decay: 0.16, level: 0.74, tone: 12.0 },
      [SNARE_RIM]:  { hz: 260, decay: 0.13, level: 0.70 },
      [CLAP]:       { decay: 0.30, level: 0.94, tone: 1.8 },
      [HAT_CLOSED]: { hz: 9000, decay: 0.030, level: 0.58 },
      [HAT_OPEN]:   { hz: 8600, decay: 0.40, level: 0.60 },
      [CRASH]:      { decay: 5.20, level: 0.78 },
      [CRASH2]:     { decay: 5.60, level: 0.78 },
      [SPLASH]:     { decay: 1.60, level: 0.60 },
      [TOM_LO]:     { level: 0.55 },
      [TOM_HI]:     { level: 0.55 },
      [RIDE]:       { level: 0.36 },
    },
  },

  // An 808.  The kick is long enough to BE the bass line, which is why a
  // trap track often has no bass part; the snare is short and mid-heavy and
  // often replaced by a rim; the hats are the fastest thing in the record so
  // they have to be very short or the rolls turn to mush.
  hiphop: {
    id: 'hiphop',
    params: { level: 0.88, tune: -2, decay: 1.0, tone: 1.25, snap: 0.7 },
    note: '808 — 킥이 베이스 라인이고, 하이햇은 롤을 견딜 만큼 짧습니다',
    pieces: {
      [KICK]:       { hz: 42, decay: 1.40, level: 1.00, sweep: 2.0 },
      [KICK2]:      { hz: 38, decay: 1.70, level: 1.00, sweep: 1.9 },
      [SNARE]:      { hz: 210, decay: 0.13, level: 0.88, tone: 9.5 },
      [SNARE_RIM]:  { hz: 260, decay: 0.11, level: 0.84, tone: 12.0 },
      [RIM]:        { decay: 0.05, level: 0.80 },
      [CLAP]:       { decay: 0.18, level: 0.82 },
      [HAT_CLOSED]: { hz: 9400, decay: 0.022, level: 0.52 },
      [HAT_PEDAL]:  { hz: 8200, decay: 0.045, level: 0.48 },
      [HAT_OPEN]:   { hz: 8800, decay: 0.26, level: 0.52 },
      [CRASH]:      { decay: 2.40, level: 0.56 },
      [RIDE]:       { level: 0.38 },
      [TOM_LO]:     { level: 0.60 },
      [TOM_HI]:     { level: 0.60 },
    },
  },

  // Round rather than hard.  The snare is fat with the crack pulled back
  // because ghost notes carry the groove, and a ghost note that cracks is a
  // hit.  Hats are soft, the kick is present but not a transient, and
  // nothing is bright for its own sake.
  rnb: {
    id: 'rnb',
    params: { level: 0.78, tune: -1, decay: 1.05, tone: 0.88, snap: 0.4 },
    note: '단단함보다 둥글게 — 고스트 노트가 그루브를 잡습니다',
    pieces: {
      [KICK]:       { hz: 50, decay: 0.40, level: 0.92, sweep: 3.4 },
      [KICK2]:      { hz: 46, decay: 0.46, level: 0.92, sweep: 3.2 },
      [SNARE]:      { hz: 178, decay: 0.22, level: 0.84, tone: 6.5 },
      [SNARE_RIM]:  { hz: 215, decay: 0.18, level: 0.80, tone: 8.0 },
      [RIM]:        { level: 0.66 },
      [CLAP]:       { decay: 0.28, level: 0.66 },
      [HAT_CLOSED]: { hz: 6600, decay: 0.055, level: 0.46 },
      [HAT_OPEN]:   { hz: 6200, decay: 0.70, level: 0.48 },
      [CRASH]:      { decay: 3.00, level: 0.58 },
      [RIDE]:       { decay: 2.20, level: 0.56 },
      [TOM_LO]:     { decay: 0.78, level: 0.80 },
      [TOM_HI]:     { decay: 0.46, level: 0.80 },
    },
  },

  // K-POP's brightness with a rock kit under it.  Toms and crashes are
  // present and played — the fills are part of the arrangement rather than
  // an interruption of it — and the snare is fatter than K-POP's.
  jpop: {
    id: 'jpop',
    params: { level: 0.84, tune: 0, decay: 0.95, tone: 1.35, snap: 0.75 },
    note: 'K-POP 의 밝기에 록 킷 — 톰과 크래시가 편곡의 일부입니다',
    pieces: {
      [KICK]:       { hz: 56, decay: 0.30, level: 0.98, sweep: 4.4 },
      [SNARE]:      { hz: 188, decay: 0.19, level: 0.94, tone: 9.5 },
      [SNARE_RIM]:  { hz: 232, decay: 0.15, level: 0.90 },
      [CLAP]:       { level: 0.52 },
      [HAT_CLOSED]: { hz: 8000, decay: 0.038, level: 0.58 },
      [HAT_OPEN]:   { hz: 7600, decay: 0.50, level: 0.58 },
      [CRASH]:      { decay: 3.20, level: 0.76 },
      [CRASH2]:     { decay: 3.40, level: 0.76 },
      [CHINA]:      { decay: 2.80, level: 0.70 },
      [SPLASH]:     { decay: 1.30, level: 0.62 },
      [RIDE]:       { decay: 1.90, level: 0.58 },
      [TOM_LO]:     { hz: 76, decay: 0.60, level: 0.90 },
      [TOM_HIFLOOR]: { hz: 92, decay: 0.55, level: 0.90 },
      [TOM_LOW]:    { hz: 110, decay: 0.50, level: 0.90 },
      [TOM_LOMID]:  { hz: 134, decay: 0.45, level: 0.90 },
      [TOM_HIMID]:  { hz: 162, decay: 0.40, level: 0.90 },
      [TOM_HI]:     { hz: 196, decay: 0.36, level: 0.90 },
    },
  },
};

// ── Storing the choice as a number ──────────────────────────────────────────
//
// `instrumentParams` is `Record<string, number>`, and everything that carries
// a track — save, load, undo, template, freeze, bounce — carries it without
// knowing what any of it means.  An enum on the Track would have to be taught
// to all six.  So the kit is an index, and the mapping is asserted by a test.

/** The value of the `kit` parameter that means "the built-in kit". */
export const KIT_DEFAULT = 0;

/** Parameter value → genre, or null for the built-in kit. */
export function kitGenreOf(param: number | undefined): GenreId | null {
  const i = Math.round(param ?? KIT_DEFAULT);
  if (i <= 0 || i > GENRE_ORDER.length) return null;
  return GENRE_ORDER[i - 1] ?? null;
}

/** Genre → parameter value.  `null` is the built-in kit. */
export function kitParamOf(genre: GenreId | null): number {
  if (!genre) return KIT_DEFAULT;
  const i = GENRE_ORDER.indexOf(genre);
  return i < 0 ? KIT_DEFAULT : i + 1;
}

/**
 * The piece a note plays, in the kit that is loaded.
 *
 * The base table is the floor: a genre says what it wants to say and inherits
 * the rest.  Writing every genre out in full would be 250 rows of mostly
 * identical numbers, and the ones that mattered would be invisible.
 */
export function drumSpecIn(genre: GenreId | null, pitch: number): DrumSpec {
  const base = drumSpecFor(pitch);
  if (!genre) return base;
  const preset = DRUM_GENRE_PRESETS[genre];
  // Keyed by the pitch the BASE resolved to, so an unmapped pitch that fell
  // back to its neighbour picks up that neighbour's genre patch too.  Keying
  // on the written pitch would give a bongo the built-in tom in a jazz kit.
  const key = Object.keys(DRUM_KIT).map(Number).find((p) => DRUM_KIT[p] === base);
  const patch = key === undefined ? undefined : preset.pieces[key];
  return patch ? { ...base, ...patch } : base;
}

/** The whole parameter set a preset writes onto a track. */
export function kitPresetParams(genre: GenreId | null): Record<string, number> {
  if (!genre) {
    return { kit: KIT_DEFAULT, level: 0.8, tune: 0, decay: 1, tone: 1, snap: 0.5 };
  }
  const p = DRUM_GENRE_PRESETS[genre].params;
  return { kit: kitParamOf(genre), ...p };
}

/** `힙합 — 808 …`, for the rack row. */
export function describeKitPreset(genre: GenreId | null): string {
  if (!genre) return '기본 킷';
  return `${GENRE_LABEL[genre]} — ${DRUM_GENRE_PRESETS[genre].note}`;
}
