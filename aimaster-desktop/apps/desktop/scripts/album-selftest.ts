/**
 * album-selftest.ts — a record, its PQ layout, its levels, its cue sheet.
 *
 * The three things worth testing hardest, because they are the three that are
 * silently wrong rather than loudly wrong:
 *
 *   • The FRAME GRID.  A CD is 75 frames a second and every position is a whole
 *     frame.  Off-by-one-frame errors do not throw; they produce a disc where
 *     track 7 starts 13 ms into the previous song's tail.
 *   • ALBUM vs TRACK levels.  Album mode must move every song by the SAME
 *     amount, so the spread between them is unchanged.  A mode that quietly
 *     flattened the record would look fine in every summary number.
 *   • The CUE SHEET.  Tested by parsing it back and comparing to the layout,
 *     not by string-matching what this repo happens to emit today.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:album
 */

import {
  CD_FRAMES_PER_SEC, MAX_CD_TRACKS, MIN_LEAD_IN_SEC, addAlbumTrack, albumLayout,
  createAlbum, describeAlbum, framesToMsf, hasErrors, isValidIsrc, isValidUpc,
  moveAlbumTrack, msfToFrames, normaliseIsrc, removeAlbumTrack, secToFrames,
  setAllGaps, updateAlbumTrack, validateAlbum,
  type Album, type AlbumTrack,
} from '../src/renderer/daw/album/album.js';
import {
  albumLoudness, describeLevels, loudnessSpread, planLevels,
  type TrackLoudness,
} from '../src/renderer/daw/album/album-levels.js';
import { cueSafe, toCueSheet, toPqLog } from '../src/renderer/daw/album/cue-sheet.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

function track(over: Partial<AlbumTrack> = {}): AlbumTrack {
  return {
    id: over.id ?? `t${Math.random().toString(36).slice(2, 8)}`,
    title: 'Song',
    sourcePath: '/tmp/song.wav',
    durationSec: 180,
    gapBeforeSec: 2,
    gainDb: 0,
    ...over,
  };
}

/** Three songs of 180, 240 and 200 seconds, two-second gaps. */
function record(): Album {
  let album = createAlbum('Blue Room', 'The Quiet');
  album = { ...album, upc: '012345678905' };
  const durations = [180, 240, 200];
  durations.forEach((d, i) => {
    album = addAlbumTrack(album, track({
      id: `t${i + 1}`, title: `Song ${i + 1}`, durationSec: d,
      isrc: `KRA0J24${String(i + 1).padStart(5, '0')}`,
    }));
  });
  return album;
}

// ── Frames ──────────────────────────────────────────────────────────────────

check('seconds convert to whole frames, rounded not floored', () => {
  assert(secToFrames(2) === 150, '2 s is 150 frames');
  assert(secToFrames(1 / 75) === 1, 'one frame');
  // The case floor() gets wrong: 2 s that arrives as 1.99999999 from a slider.
  assert(secToFrames(1.999999999) === 150, 'a hair under two seconds is still two seconds');
  assert(secToFrames(-5) === 0, 'never negative');
});

check('MSF round-trips, and rejects what is not MSF', () => {
  for (const frames of [0, 1, 74, 75, 150, 12_345, 74 * 60 * 75]) {
    const msf = framesToMsf(frames);
    assert(msfToFrames(msf) === frames, `${frames} → ${msf} → ${msfToFrames(msf)}`);
  }
  assert(framesToMsf(150) === '00:02:00', framesToMsf(150));
  assert(framesToMsf(74) === '00:00:74', framesToMsf(74));
  assert(msfToFrames('00:00:75') === null, 'frame 75 does not exist');
  assert(msfToFrames('00:60:00') === null, 'second 60 does not exist');
  assert(msfToFrames('nonsense') === null, 'nor does nonsense');
});

// ── Layout ──────────────────────────────────────────────────────────────────

check('the lead-in comes before track 1 and belongs to no track', () => {
  const layout = albumLayout(record());
  const first = layout.tracks[0]!;
  assert(first.index0Frames === undefined, 'track 1 has no pause of its own');
  assert(first.index1Frames === secToFrames(MIN_LEAD_IN_SEC), `starts at the lead-in, got ${first.index1Frames}`);
});

check("track 1's gap is not charged twice", () => {
  // Track 1 carries gapBeforeSec: 2 AND the album has a 2 s lead-in.  Adding
  // both would put four seconds of silence before the first note.
  const album = record();
  assert(album.tracks[0]!.gapBeforeSec === 2, 'the fixture does set a gap on track 1');
  const layout = albumLayout(album);
  assert(layout.tracks[0]!.index1Frames === 150, `150 frames, not 300 — got ${layout.tracks[0]!.index1Frames}`);
});

check('each track starts where the last one ended, plus its pause', () => {
  const layout = albumLayout(record());
  const [a, b, c] = layout.tracks as [typeof layout.tracks[0], typeof layout.tracks[0], typeof layout.tracks[0]];
  assert(b.index0Frames === a.endFrames, `the pause starts at the previous end: ${b.index0Frames} vs ${a.endFrames}`);
  assert(b.index1Frames === a.endFrames + 150, 'and the music two seconds after that');
  assert(c.index0Frames === b.endFrames, 'and so on down the record');
});

check('the total is the lead-in plus every gap plus every song', () => {
  const album = record();
  const layout = albumLayout(album);
  const expected = secToFrames(album.leadInSec)
    + album.tracks.slice(1).reduce((a, t) => a + secToFrames(t.gapBeforeSec), 0)
    + album.tracks.reduce((a, t) => a + secToFrames(t.durationSec), 0);
  assert(layout.totalFrames === expected, `${layout.totalFrames} vs ${expected}`);
  assert(layout.totalFrames === layout.tracks[2]!.endFrames, 'and it is where the last track ends');
});

check('a zero gap means no INDEX 00 at all', () => {
  const segued = setAllGaps(record(), 0);
  const layout = albumLayout(segued);
  assert(layout.tracks.every((t) => t.index0Frames === undefined), 'no pauses anywhere');
  assert(layout.tracks[1]!.index1Frames === layout.tracks[0]!.endFrames, 'the songs touch');
});

check('the layout survives a reorder, and the times follow', () => {
  const album = record();
  const moved = moveAlbumTrack(album, 't3', 0);
  assert(moved.tracks[0]!.id === 't3', 'the long one is first now');
  const layout = albumLayout(moved);
  assert(layout.tracks[0]!.durationFrames === secToFrames(200), 'and its length came with it');
  assert(layout.totalFrames === albumLayout(album).totalFrames, 'reordering changes no total');
});

// ── Red Book ────────────────────────────────────────────────────────────────

check('a clean album has no errors', () => {
  const problems = validateAlbum(record());
  assert(!hasErrors(problems), `errors: ${problems.filter((p) => p.level === 'error').map((p) => p.message).join('; ')}`);
});

check('a three-second track is refused', () => {
  const short = updateAlbumTrack(record(), 't2', (t) => ({ ...t, durationSec: 3 }));
  const problems = validateAlbum(short);
  assert(hasErrors(problems), 'that is an error');
  assert(problems.some((p) => p.track === 2 && p.message.includes('4초')), problems[0]?.message ?? '');
});

check('too little silence before track 1 is refused', () => {
  const tight = { ...record(), leadInSec: 1 };
  assert(hasErrors(validateAlbum(tight)), 'one second is not two');
  assert(!hasErrors(validateAlbum({ ...record(), leadInSec: 2 })), 'two seconds is');
});

check('a hundredth track is refused', () => {
  let album = createAlbum('Long');
  for (let i = 0; i < MAX_CD_TRACKS + 1; i++) {
    album = addAlbumTrack(album, track({ id: `t${i}`, durationSec: 5, gapBeforeSec: 0 }));
  }
  assert(hasErrors(validateAlbum(album)), `more than ${MAX_CD_TRACKS} tracks`);
});

check('a record too long for a disc is refused, and one merely over 74 minutes warns', () => {
  const long = (mins: number): Album => {
    let a = createAlbum('Long');
    a = addAlbumTrack(a, track({ id: 'x', durationSec: mins * 60, gapBeforeSec: 0 }));
    return a;
  };
  const over80 = validateAlbum(long(81));
  assert(hasErrors(over80), '81 minutes does not fit anything');
  const over74 = validateAlbum(long(77));
  assert(!hasErrors(over74), '77 minutes fits an 80-minute disc');
  assert(over74.some((p) => p.level === 'warning' && p.message.includes('74분')), 'but it says so');
});

check('ISRC and UPC are checked, and duplicates caught', () => {
  assert(isValidIsrc('KRA0J2400001'), 'a real one');
  assert(isValidIsrc('kr-a0j-24-00001'), 'hyphens and lower case are normalised first');
  assert(!isValidIsrc('KRA0J240001'), 'eleven characters is not twelve');
  assert(!isValidIsrc('12A0J2400001'), 'the country code is letters');
  assert(normaliseIsrc('kr-a0j-24-00001') === 'KRA0J2400001', normaliseIsrc('kr-a0j-24-00001'));

  assert(isValidUpc('012345678905') && isValidUpc('0123456789012'), '12 and 13 digits');
  assert(!isValidUpc('01234567890'), 'eleven is neither');

  const dup = updateAlbumTrack(record(), 't2', (t) => ({ ...t, isrc: 'KRA0J2400001' }));
  assert(validateAlbum(dup).some((p) => p.level === 'error' && p.message.includes('1번')),
    'the same recording code twice is an error that names the other track');
});

check('a missing ISRC warns but does not block', () => {
  const bare = updateAlbumTrack(record(), 't2', (t) => { const { isrc, ...rest } = t; void isrc; return rest; });
  const problems = validateAlbum(bare);
  assert(!hasErrors(problems), 'a disc can be pressed without one');
  assert(problems.some((p) => p.track === 2 && p.level === 'warning'), 'but it is worth saying');
});

// ── Levels ──────────────────────────────────────────────────────────────────

/** A loud single, a quiet interlude, and something in between. */
const LOUD: TrackLoudness[] = [
  { trackId: 't1', integratedLufs: -9,  truePeakDbtp: -0.3, durationSec: 180 },
  { trackId: 't2', integratedLufs: -17, truePeakDbtp: -6.0, durationSec: 60 },
  { trackId: 't3', integratedLufs: -12, truePeakDbtp: -1.0, durationSec: 240 },
];

check('album loudness is energy-weighted, not an average of dB', () => {
  const l = albumLoudness(LOUD);
  const meanOfDb = (-9 + -17 + -12) / 3;
  assert(Math.abs(l - meanOfDb) > 0.5, `energy-weighted ${l.toFixed(2)} vs the naive ${meanOfDb.toFixed(2)}`);
  // Louder and longer tracks dominate, so it must sit above the plain mean.
  assert(l > meanOfDb, 'the loud long ones pull it up');
  assert(l < -9 && l > -17, 'and it stays inside the range');
});

check('a one-track album is that track', () => {
  near(albumLoudness([LOUD[0] as TrackLoudness]), -9, 1e-9, 'nothing to weight against');
  assert(albumLoudness([]) === -Infinity, 'and nothing at all is silence');
});

check('album mode moves every song by the SAME amount', () => {
  const plan = planLevels(LOUD, { mode: 'album', targetLufs: -14, maxAdjustDb: 12 });
  const gains = plan.adjustments.map((a) => a.gainDb);
  for (const g of gains) near(g, gains[0] as number, 1e-9, 'one gain for the record');
  near(loudnessSpread(LOUD, plan), loudnessSpread(LOUD), 1e-9,
    'so the gap between the loudest and quietest song is untouched');
});

check('album mode hits the target', () => {
  const plan = planLevels(LOUD, { mode: 'album', targetLufs: -14, maxAdjustDb: 12, ceilingDbtp: 0 });
  near(plan.albumLufsAfter, -14, 0.01, 'the album lands where it was asked to');
});

check('track mode flattens the record — which is what it is for', () => {
  const plan = planLevels(LOUD, { mode: 'track', targetLufs: -14, maxAdjustDb: 12, ceilingDbtp: 0 });
  near(loudnessSpread(LOUD, plan), 0, 0.01, 'every song at the same loudness');
  assert(loudnessSpread(LOUD) > 7, 'and they were 8 dB apart before');
});

check('the ceiling wins over the target, and album mode pulls everything back together', () => {
  // Asking for −9 LUFS would push the loud track's −0.3 dBTP peak way over.
  const plan = planLevels(LOUD, { mode: 'album', targetLufs: -9, ceilingDbtp: -1, maxAdjustDb: 12 });
  assert(plan.peakAfterDbtp <= -1 + 1e-6, `no peak past the ceiling — ${plan.peakAfterDbtp.toFixed(3)}`);
  const gains = plan.adjustments.map((a) => a.gainDb);
  for (const g of gains) near(g, gains[0] as number, 1e-9, 'still one gain, just a smaller one');
  assert(plan.adjustments.some((a) => a.ceilingLimited), 'and the plan says the ceiling decided it');
});

check('track mode lets each song answer to the ceiling alone', () => {
  const plan = planLevels(LOUD, { mode: 'track', targetLufs: -9, ceilingDbtp: -1, maxAdjustDb: 12 });
  assert(plan.peakAfterDbtp <= -1 + 1e-6, 'nothing over the ceiling');
  const quiet = plan.adjustments.find((a) => a.trackId === 't2')!;
  const loud = plan.adjustments.find((a) => a.trackId === 't1')!;
  assert(quiet.gainDb > loud.gainDb, 'the quiet one comes up further than the loud one');
});

check('the adjustment cap holds, and is applied before the ceiling', () => {
  const plan = planLevels(LOUD, { mode: 'track', targetLufs: -5, ceilingDbtp: 0, maxAdjustDb: 3 });
  for (const a of plan.adjustments) {
    assert(a.gainDb <= 3 + 1e-6, `${a.trackId} moved ${a.gainDb.toFixed(2)} dB, cap is 3`);
  }
  assert(plan.adjustments.some((a) => a.clamped), 'and it says which ones it held back');
});

check("'off' changes nothing and says so", () => {
  const plan = planLevels(LOUD, { mode: 'off' });
  assert(plan.adjustments.every((a) => a.gainDb === 0), 'no gains');
  near(plan.albumLufsAfter, plan.albumLufsBefore, 1e-9, 'and no change to the album');
  assert(describeLevels(plan, LOUD).includes('건드리지'), describeLevels(plan, LOUD));
});

check('silence lowers the album; an unmeasured track does not', () => {
  // These two both fail `isFinite` and mean opposite things, so the test that
  // lumped them together was asserting one behaviour for both.
  const silent: TrackLoudness[] = [
    ...LOUD, { trackId: 't4', integratedLufs: -Infinity, truePeakDbtp: -99, durationSec: 30 },
  ];
  const unmeasured: TrackLoudness[] = [
    ...LOUD, { trackId: 't4', integratedLufs: NaN, truePeakDbtp: -99, durationSec: 30 },
  ];
  const base = albumLoudness(LOUD);
  assert(Number.isFinite(albumLoudness(silent)), 'still a number');
  assert(albumLoudness(silent) < base,
    `a silent half-minute really does pull the album down: ${albumLoudness(silent).toFixed(2)} vs ${base.toFixed(2)}`);
  near(albumLoudness(unmeasured), base, 1e-9,
    'but a track nobody measured must not move the number at all');
});

// ── Cue sheet ───────────────────────────────────────────────────────────────

/** Parse the sheet back, so the test compares meaning rather than text. */
function parseCue(text: string): {
  catalog?: string; title?: string; performer?: string; file?: string;
  tracks: Array<{ n: number; title?: string; isrc?: string; index0?: number; index1?: number }>;
} {
  const out: ReturnType<typeof parseCue> = { tracks: [] };
  let cur: (typeof out.tracks)[number] | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const q = (s: string): string | undefined => /^"(.*)"$/.exec(s)?.[1];
    if (line.startsWith('CATALOG ')) out.catalog = line.slice(8).trim();
    else if (line.startsWith('FILE ')) out.file = q(line.slice(5).replace(/\s+\w+$/, '').trim());
    else if (line.startsWith('TRACK ')) {
      cur = { n: Number(line.split(/\s+/)[1]) };
      out.tracks.push(cur);
    } else if (line.startsWith('TITLE ')) {
      if (cur) cur.title = q(line.slice(6).trim()); else out.title = q(line.slice(6).trim());
    } else if (line.startsWith('PERFORMER ')) {
      if (!cur) out.performer = q(line.slice(10).trim());
    } else if (line.startsWith('ISRC ') && cur) cur.isrc = line.slice(5).trim();
    else if (line.startsWith('INDEX 00 ') && cur) cur.index0 = msfToFrames(line.slice(9).trim()) ?? undefined;
    else if (line.startsWith('INDEX 01 ') && cur) cur.index1 = msfToFrames(line.slice(9).trim()) ?? undefined;
  }
  return out;
}

check('the cue sheet parses back to the layout it was made from', () => {
  const album = record();
  const layout = albumLayout(album);
  const cue = parseCue(toCueSheet(album, { imageFileName: 'album.wav' }));

  assert(cue.title === 'Blue Room', `album title: ${cue.title}`);
  assert(cue.performer === 'The Quiet', `album artist: ${cue.performer}`);
  assert(cue.catalog === '012345678905', `UPC: ${cue.catalog}`);
  assert(cue.file === 'album.wav', `image: ${cue.file}`);
  assert(cue.tracks.length === 3, `three tracks, got ${cue.tracks.length}`);

  layout.tracks.forEach((at, i) => {
    const parsed = cue.tracks[i]!;
    assert(parsed.n === at.number, `track number ${parsed.n} vs ${at.number}`);
    assert(parsed.index1 === at.index1Frames,
      `track ${at.number} INDEX 01: ${parsed.index1} vs ${at.index1Frames}`);
    assert(parsed.index0 === at.index0Frames,
      `track ${at.number} INDEX 00: ${parsed.index0} vs ${at.index0Frames}`);
    assert(parsed.isrc === normaliseIsrc(album.tracks[i]!.isrc ?? ''), `track ${at.number} ISRC`);
  });
});

check('a quote in a title cannot truncate the field', () => {
  const album = updateAlbumTrack(record(), 't2', (t) => ({ ...t, title: 'He Said "No"' }));
  const cue = toCueSheet(album, { imageFileName: 'a.wav' });
  const parsed = parseCue(cue);
  assert(parsed.tracks[1]!.title === 'He Said No', `got ${parsed.tracks[1]!.title}`);
  assert(cueSafe('a\nb') === 'ab', 'and a newline cannot end the line early');
});

check('an empty field is left out rather than written empty', () => {
  const bare = createAlbum('', '');
  const cue = toCueSheet(addAlbumTrack(bare, track({ id: 'x', title: '' })), { imageFileName: 'a.wav' });
  assert(!cue.includes('TITLE ""'), 'no empty TITLE line');
  assert(!cue.includes('CATALOG'), 'no CATALOG without a UPC');
  assert(!/\n\s*ISRC\s*\n/.test(cue), 'no bare ISRC line');
});

check('a segued album writes no INDEX 00 lines at all', () => {
  const cue = toCueSheet(setAllGaps(record(), 0), { imageFileName: 'a.wav' });
  assert(!cue.includes('INDEX 00'), 'nothing to pause for');
  assert((cue.match(/INDEX 01/g) ?? []).length === 3, 'but every track still starts somewhere');
});

check('the PQ log lists every track with its start and length', () => {
  const log = toPqLog(record(), { levels: '-14 LUFS' });
  const lines = log.split('\n');
  assert(log.includes('Blue Room') && log.includes('012345678905'), 'the header carries the album');
  assert(log.includes('-14 LUFS'), 'and the level decision when there is one');
  const rows = lines.filter((l) => /^\d\d /.test(l));
  assert(rows.length === 3, `one row per track, got ${rows.length}`);
  assert(rows[0]!.includes('00:02:00'), `track 1 starts at the lead-in: ${rows[0]}`);
  assert(rows[0]!.includes('KRA0J2400001'), 'with its ISRC');
});

// ── Editing ─────────────────────────────────────────────────────────────────

check('removing and moving tracks behaves, and no-ops are identity', () => {
  const album = record();
  assert(removeAlbumTrack(album, 'nope') === album, 'removing what is not there changes nothing');
  assert(removeAlbumTrack(album, 't2').tracks.length === 2, 'and removing what is there does');
  assert(moveAlbumTrack(album, 't1', 0) === album, 'moving a track to where it already is');
  assert(moveAlbumTrack(album, 't1', 99).tracks[2]!.id === 't1', 'past the end lands at the end');
  assert(updateAlbumTrack(album, 't1', (t) => t) === album, 'an update that changes nothing');
});

check('describeAlbum says how many and how long', () => {
  const d = describeAlbum(record());
  assert(d.includes('3곡'), d);
  // 2 s lead-in + 2 gaps + 180 + 240 + 200 = 626 s = 10:26:00
  assert(d.includes('10:26:00'), d);
});

check('the frame rate is the one the format has', () => {
  assert(CD_FRAMES_PER_SEC === 75, 'not negotiable');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Album: PQ layout, levels, cue sheet ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
