/**
 * instrument-rack-selftest.ts — F11, and the round trip out to a .mid.
 *
 * The rack exists because a feature with no control is indistinguishable from
 * one that is missing.  Four instruments were implemented, tested and
 * unreachable: the only picker lived inside the Key Editor, which needs a
 * part, which needs a track, which the one button that made tracks always
 * made as a `polysynth`.  So the checks here are mostly about REACHABILITY —
 * the door exists, it is the same door in both places, and it opens onto
 * something that is not empty.
 *
 * The one piece of real arithmetic is `trackNotesInBeats`.  A note's
 * `startBeat` is measured from ITS PART, so writing four parts out without
 * re-anchoring them stacks all four on bar 1 — an export that looks fine in
 * the file size and is nonsense in the file.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:instrument-rack
 */

import { readFileSync } from 'node:fs';
import {
  describeSlot, midiFileName, newPartPlacement, nextInstrumentName, rackSlots,
  trackNotesInBeats,
} from '../src/renderer/daw/model/instrument-rack.js';
import {
  addTrack, createMidiPart, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { createNote } from '../src/renderer/daw/model/midi.js';
import { exportMidiFile, importMidiFile } from '../src/renderer/daw/io/midi-file.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];

function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message }); }
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

/** Read code, not prose: a claim must not be satisfied by a comment. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}
function source(rel: string): string {
  return stripComments(readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8'));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A session with three instrument tracks and one audio track between them. */
function fixture(): DawSession {
  let s = createSession('Rack', 48_000);
  s = { ...s, tempoBpm: 120, timeSignature: [4, 4] };
  const piano = createTrack('Rhodes 1', 'instrument', { instrumentId: 'epiano' });
  const audio = createTrack('Drums', 'audio');
  const gtr = createTrack('Acoustic Guitar 1', 'instrument', { instrumentId: 'agtr' });
  // Deliberately left with no instrumentId — an older session, or one saved
  // before the field existed.  It still PLAYS the default.
  const legacy = createTrack('Legacy', 'instrument', { instrumentId: null });
  s = addTrack(addTrack(addTrack(addTrack(s, piano), audio), gtr), legacy);
  s = updateClips(s, piano.id, () => [
    createMidiPart('Rhodes 1 1', {
      startSec: 0, durationSec: 8,
      notes: [createNote({ pitch: 60, startBeat: 0, durationBeat: 1 })],
    }),
    createMidiPart('Rhodes 1 2', {
      startSec: 8, durationSec: 8,
      notes: [
        createNote({ pitch: 64, startBeat: 0, durationBeat: 1 }),
        createNote({ pitch: 67, startBeat: 2, durationBeat: 1 }),
      ],
    }),
  ]);
  return s;
}

// ── The rack itself ──────────────────────────────────────────────────────────

check('the rack lists instrument tracks and nothing else', () => {
  const slots = rackSlots(fixture());
  assert(slots.length === 3, `${slots.length} slots — the audio track leaked in`);
  assert(slots.map((x) => x.trackName).join(',') === 'Rhodes 1,Acoustic Guitar 1,Legacy',
    slots.map((x) => x.trackName).join(','));
  // Numbered 1..n by position in the rack, not by position in the session:
  // the guitar is the session's third track and the rack's second slot.
  assert(slots.map((x) => x.index).join(',') === '1,2,3', slots.map((x) => x.index).join(','));
});

check('a slot with no instrument shows the one it actually plays', () => {
  // `instrumentId: null` renders as `polysynth` everywhere in the engine
  // (`findInstrument(track.instrumentId ?? 'polysynth')`).  A rack that showed
  // it as blank would be describing a track that does not exist.
  const legacy = rackSlots(fixture()).find((s) => s.trackName === 'Legacy');
  assert(legacy?.instrumentId === 'polysynth', String(legacy?.instrumentId));
});

check('a slot counts its parts and its notes', () => {
  const slots = rackSlots(fixture());
  const rhodes = slots[0]!;
  assert(rhodes.parts === 2, `parts ${rhodes.parts}`);
  assert(rhodes.notes === 3, `notes ${rhodes.notes}`);
  assert(rhodes.firstPartId !== null, 'no part for the edit button to open');
  const empty = slots[2]!;
  assert(empty.parts === 0 && empty.firstPartId === null, 'an empty slot claimed a part');
  assert(describeSlot(empty) === '파트 없음', describeSlot(empty));
  assert(describeSlot(rhodes).includes('2파트') && describeSlot(rhodes).includes('3노트'),
    describeSlot(rhodes));
});

check('a new slot is named after the instrument, and the numbers do not collide', () => {
  let s = fixture();
  // The parenthetical is a build detail, not a track name: "Rhodes (FM)"
  // makes a track called "Rhodes", so the name reads the same if the
  // synthesis method is ever renamed.
  assert(nextInstrumentName(s, 'Rhodes (FM)') === 'Rhodes 2', nextInstrumentName(s, 'Rhodes (FM)'));
  assert(nextInstrumentName(s, 'Poly Synth') === 'Poly Synth 1', nextInstrumentName(s, 'Poly Synth'));
  // A counter over ALL instrument tracks would call this one "Acoustic Guitar 4".
  assert(nextInstrumentName(s, 'Acoustic Guitar') === 'Acoustic Guitar 2',
    nextInstrumentName(s, 'Acoustic Guitar'));
  s = addTrack(s, createTrack('Rhodes 2', 'instrument'));
  assert(nextInstrumentName(s, 'Rhodes (FM)') === 'Rhodes 3', nextInstrumentName(s, 'Rhodes (FM)'));
});

check('a new part lands after what is there, not on top of it', () => {
  const s = fixture();
  const rhodes = s.tracks[0]!;
  // 120 bpm, 4/4 → a bar is 2 s, four bars is 8 s.  The track already holds
  // two 8 s parts, so the third starts at 16.
  const place = newPartPlacement(s, rhodes);
  assert(place.durationSec === 8, `duration ${place.durationSec}`);
  assert(place.startSec === 16, `start ${place.startSec} — a new part would overlap`);
  // A brand new track has nothing to sit after.
  assert(newPartPlacement(s, undefined).startSec === 0, 'a first part did not start at 0');
});

check('tempo and metre decide the bar, not a hardcoded number', () => {
  const s = { ...createSession('x'), tempoBpm: 90, timeSignature: [3, 4] as [number, number] };
  // A bar of 3/4 at 90 bpm is 3 × (60/90) = 2 s; four bars is 8 s.
  const place = newPartPlacement(s, undefined);
  assert(Math.abs(place.durationSec - 8) < 1e-9, `duration ${place.durationSec}`);
});

// ── The export ───────────────────────────────────────────────────────────────

check('every part lands where it plays, not all on bar one', () => {
  const s = fixture();
  const notes = trackNotesInBeats(s, s.tracks[0]!);
  assert(notes.length === 3, `${notes.length} notes`);
  // 120 bpm → 2 beats per second.  The second part starts at 8 s = beat 16,
  // so its notes are at beats 16 and 18.  Without the re-anchor they would
  // read 0, 0 and 2 — three notes in bar one instead of two bars apart.
  const beats = notes.map((n) => n.startBeat);
  assert(beats.join(',') === '0,16,18', beats.join(','));
});

check('a .mid written from a track reads back as the same notes', () => {
  const s = fixture();
  const notes = trackNotesInBeats(s, s.tracks[0]!);
  const bytes = exportMidiFile(notes, s.tempoBpm);
  const back = importMidiFile(bytes);
  const flat = back.parts.flatMap((p) => p.notes);
  assert(flat.length === 3, `${flat.length} notes came back`);
  const got = flat.map((n) => `${n.pitch}@${n.startBeat.toFixed(2)}`).sort().join(' ');
  const want = '60@0.00 64@16.00 67@18.00';
  assert(got === want, `${got} — wanted ${want}`);
});

check('a filename is a filename on every platform', () => {
  assert(midiFileName('Rhodes 1') === 'Rhodes 1.mid', midiFileName('Rhodes 1'));
  // Windows refuses these outright; a slash would make a path out of a name.
  assert(midiFileName('lead/rhythm: "take 2"?') === 'lead rhythm take 2.mid',
    midiFileName('lead/rhythm: "take 2"?'));
  assert(midiFileName('a\u0000b') === 'a b.mid', JSON.stringify(midiFileName('a\u0000b')));
  // A name that is nothing but punctuation must still make a file rather than
  // a bare extension — `.mid` alone is a hidden file on macOS and Linux.
  assert(midiFileName('***') === 'part.mid', midiFileName('***'));
  assert(midiFileName('   ') === 'part.mid', midiFileName('   '));
  assert(midiFileName('trailing.') === 'trailing.mid', midiFileName('trailing.'));
});

// ── Reachability — the whole reason this exists ─────────────────────────────

check('F11 opens the rack in the DAW', () => {
  const cmds = source('renderer/shortcuts/daw-commands.ts');
  const at = cmds.indexOf("'window.vstEditor'");
  assert(at > 0, 'the DAW does not override F11 at all');
  assert(/togglePanel\('vstEditor'\)/.test(cmds.slice(at, at + 400)),
    'the F11 override does not toggle the rack panel');
  const page = source('renderer/pages/DawPage.tsx');
  assert(/<InstrumentRack/.test(page), 'nothing renders the rack');
  assert(/panels\.vstEditor/.test(page), 'the page does not read the panel flag the key sets');
});

check('the shortcut list says what the key does', () => {
  // The old label already promised "VST 에디터 / 인스트루먼트 창" while the key
  // opened the mastering advanced-parameter panel.  A help screen that lies is
  // worse than one that omits.
  // `indexOf` here finds the CommandId UNION at the top of the file, not the
  // definition — the same trap that let a break slip past the sampler test.
  // Anchor on the field name, which only the definition has.
  const defs = source('renderer/shortcuts/definitions.ts');
  const at = defs.indexOf("id: 'window.vstEditor'");
  assert(at > 0, 'no definition row for window.vstEditor');
  const row = defs.slice(at, at + 400);
  assert(/F11/.test(row), 'F11 is no longer the chord');
  assert(/인스트루먼트/.test(row), 'the label no longer mentions instruments');
});

check('the toolbar button and the key open the same thing', () => {
  // Two doors that behave differently is how the polysynth-only path survived
  // as long as it did.
  const page = source('renderer/pages/DawPage.tsx');
  const at = page.indexOf('handleAddInstrument = useCallback');
  assert(at > 0, 'the add-instrument button is gone');
  const body = page.slice(at, at + 300);
  assert(/setPanel\('vstEditor', true\)/.test(body),
    'the toolbar button still creates a track without asking which instrument');
});

check('the rack offers every instrument the engine has', () => {
  const rack = source('renderer/components/daw/InstrumentRack.tsx');
  assert(/INSTRUMENTS\.map/.test(rack), 'the picker does not enumerate INSTRUMENTS');
  // Hardcoding a list here is how the Key Editor's picker would have gone
  // stale the first time an instrument was added.
  assert(!/'polysynth'\s*,\s*'epiano'/.test(rack), 'the rack hardcodes an instrument list');
  const engine = source('renderer/daw/engine/instruments.ts');
  const ids = [...engine.matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map((m) => m[1]);
  assert(ids.length >= 5, `only ${ids.length} instruments found in the engine`);
});

check('MIDI export is reachable from the app, not just from a test', () => {
  // `exportMidiFile` was written, tested and called by nothing for as long as
  // the importer has existed — a DAW that reads .mid and cannot write one.
  const rack = source('renderer/components/daw/InstrumentRack.tsx');
  assert(/exportMidiFile\(/.test(rack), 'nothing in the UI calls exportMidiFile');
  assert(/daw:midi-save/.test(rack), 'the export never reaches the main process');
  const preload = source('preload/index.ts');
  assert(/'daw:midi-save'/.test(preload), 'daw:midi-save is not on the preload allowlist');
  const main = source('main/ipc/fileHandlers.ts');
  assert(/ipc\.handle\('daw:midi-save'/.test(main), 'no main-process handler for daw:midi-save');
});

console.log('\n=== Instrument rack — F11, and the way out to a .mid ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
