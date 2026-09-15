/**
 * device-setup-selftest — who hears the keyboard, and why nothing does.
 *
 * Two pieces, both pulled out of React on purpose:
 *
 *   midiTargets        which tracks the keyboard plays into.  Armed wins;
 *                      otherwise audition points at the focused instrument.
 *   deviceSetupReport  the diagnosis the panel draws.  The states worth
 *                      naming are the ones where every cable is right and no
 *                      sound comes out.
 *
 * The panel's pickers are not tested here — a <select> bound to a store is not
 * a thing that can be wrong in an interesting way.  The rule about which of
 * five different "everything is connected" states you are in is.
 *
 * Run: pnpm --filter @aimaster/desktop test:device-setup
 */

import {
  midiTargets, setRecordArm, trackRecordKind,
} from '../src/renderer/daw/model/recording.js';
import {
  connectedPorts, deviceSetupReport, deviceSetupStatus, midiSelectionResolves,
  type DeviceSetupInput, type DeviceLine,
} from '../src/renderer/daw/model/device-setup.js';
import { addTrack, createSession, createTrack } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { MidiHolds } from '../src/renderer/daw/model/midi-hold.js';
import { SHORTCUTS } from '../src/renderer/shortcuts/definitions.js';
import {
  PANEL_SLOTS, panelsSharingSlot, useWorkspaceStore,
} from '../src/renderer/stores/workspaceStore.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Two instruments and an audio track, which is the shape that tells them apart. */
function rig(): { session: DawSession; piano: TrackId; synth: TrackId; mic: TrackId } {
  resetIds();
  let session = createSession();
  const piano = createTrack('피아노', 'instrument');
  const synth = createTrack('신스', 'instrument');
  const mic = createTrack('보컬', 'audio');
  session = addTrack(session, piano);
  session = addTrack(session, synth);
  session = addTrack(session, mic);
  return { session, piano: piano.id, synth: synth.id, mic: mic.id };
}

const base: DeviceSetupInput = {
  midiSupported: true,
  midiFailure: null,
  midiInputs: [{ id: 'kb', name: 'MPK mini', connected: true }],
  midiOutputs: [],
  audioInputs: [{ id: 'default', label: 'Scarlett 2i2' }],
  selectedMidiInputId: null,
  armedMidiCount: 0,
  instrumentTrackCount: 1,
  audition: false,
  midiOpen: false,
};
const withInput = (over: Partial<DeviceSetupInput>): DeviceSetupInput => ({ ...base, ...over });
const keys = (lines: DeviceLine[]): string => lines.map((l) => l.key).join(',');
const has = (lines: DeviceLine[], key: string): boolean => lines.some((l) => l.key === key);

// ── midiTargets ──────────────────────────────────────────────────────────────

check('nothing armed, audition off — the keyboard plays into nothing', () => {
  const { session } = rig();
  eq(midiTargets(session).length, 0, 'no targets');
  eq(midiTargets(session, { audition: false }).length, 0, 'audition off is the same as unasked');
});

check('audition points at the focused instrument', () => {
  const { session, synth } = rig();
  const targets = midiTargets(session, { focusedTrackId: synth, audition: true });
  eq(targets.length, 1, 'one target');
  eq(targets[0], synth, 'the focused one, not the first');
});

check('audition with nothing focused falls back to the first instrument', () => {
  const { session, piano } = rig();
  eq(midiTargets(session, { audition: true })[0], piano, 'first instrument');
  eq(midiTargets(session, { focusedTrackId: null, audition: true })[0], piano, 'explicit null too');
});

check('a focused AUDIO track does not steal the notes', () => {
  const { session, piano, mic } = rig();
  const targets = midiTargets(session, { focusedTrackId: mic, audition: true });
  // Focusing a microphone must not silence the keyboard, and must not send
  // notes to something with no instrument in it either.
  eq(targets.length, 1, 'still one target');
  eq(targets[0], piano, 'falls back to an instrument');
});

check('armed tracks always win over audition', () => {
  const r = rig();
  const session = setRecordArm(r.session, r.synth, true);
  const targets = midiTargets(session, { focusedTrackId: r.piano, audition: true });
  eq(targets.length, 1, 'one armed target');
  eq(targets[0], r.synth, 'the armed track, not the focused one');
});

check('every armed instrument hears it, not just one', () => {
  const r = rig();
  let session = setRecordArm(r.session, r.piano, true);
  session = setRecordArm(session, r.synth, true);
  eq(midiTargets(session).length, 2, 'both armed');
  eq(midiTargets(session, { audition: true }).length, 2, 'audition does not narrow it');
});

check('an armed AUDIO track is not a MIDI target', () => {
  const r = rig();
  const session = setRecordArm(r.session, r.mic, true);
  eq(trackRecordKind(session.tracks.find((t) => t.id === r.mic)!), 'audio', 'the mic is audio');
  // Arming a microphone must not open the keyboard onto it — and must not
  // suppress audition either, since nothing MIDI is armed.
  eq(midiTargets(session).length, 0, 'no midi targets from an armed mic');
  eq(midiTargets(session, { audition: true })[0], r.piano, 'audition still works');
});

check('a session with no instruments has nowhere to send notes', () => {
  resetIds();
  let session = createSession();
  session = addTrack(session, createTrack('보컬', 'audio'));
  eq(midiTargets(session, { audition: true }).length, 0, 'no targets');
});

// ── the diagnosis ────────────────────────────────────────────────────────────

check('Web MIDI missing is blocked, and says why', () => {
  const lines = deviceSetupReport(withInput({
    midiSupported: false, midiFailure: 'SecurityError: permission denied',
  }));
  assert(has(lines, 'midi.unsupported'), `want midi.unsupported, got ${keys(lines)}`);
  eq(deviceSetupStatus(lines), 'blocked', 'blocked');
  assert(lines[0]!.detail.includes('SecurityError'),
    'the real failure reason is shown, not a generic line');
});

check('no failure reason still produces a sentence', () => {
  const lines = deviceSetupReport(withInput({ midiSupported: false, midiFailure: '  ' }));
  assert(lines[0]!.detail.trim().length > 0, 'whitespace is not a reason');
});

check('an API that exists and then fails is not "no device connected"', () => {
  // Electron in a container: `requestMIDIAccess` is a function, the call
  // rejects, and the port list is empty.  "Plug in a USB keyboard and
  // refresh" would send someone to re-seat a cable that was never the
  // problem, forever.
  const lines = deviceSetupReport(withInput({
    midiSupported: true,
    midiFailure: 'MIDI 장치를 열 수 없습니다 (Platform dependent initialization failed.)',
    midiInputs: [],
  }));
  assert(has(lines, 'midi.failed'), keys(lines));
  assert(!has(lines, 'midi.none'), 'not reported as an empty list');
  eq(deviceSetupStatus(lines), 'blocked', 'blocked');
  assert(lines[0]!.detail.includes('Platform dependent'), 'the platform’s own words');
});

check('a live failure outranks ports that are still listed', () => {
  const lines = deviceSetupReport(withInput({
    midiFailure: 'MIDI 접근이 거부되었습니다', armedMidiCount: 1,
  }));
  // Stale port names from before the failure must not read as a working rig.
  assert(has(lines, 'midi.failed'), keys(lines));
  assert(!has(lines, 'midi.armed'), 'not reported as working');
});

check('no failure reason means the port list is the truth', () => {
  const lines = deviceSetupReport(withInput({ midiFailure: null, armedMidiCount: 1 }));
  assert(!has(lines, 'midi.failed'), keys(lines));
  const blank = deviceSetupReport(withInput({ midiFailure: '   ', armedMidiCount: 1 }));
  assert(!has(blank, 'midi.failed'), 'whitespace is not a failure');
});

check('no ports at all asks for a cable', () => {
  const lines = deviceSetupReport(withInput({ midiInputs: [] }));
  assert(has(lines, 'midi.none'), keys(lines));
  eq(deviceSetupStatus(lines), 'warn', 'warn');
});

check('ports that are all disconnected are not the same as no ports', () => {
  const lines = deviceSetupReport(withInput({
    midiInputs: [{ id: 'kb', name: 'MPK mini', connected: false }],
  }));
  // The driver remembers gear that has left.  "No MIDI device" would send the
  // user hunting for a driver; "it stopped answering" sends them to the cable.
  assert(has(lines, 'midi.disconnected'), keys(lines));
  assert(!has(lines, 'midi.none'), 'not reported as absent');
});

check('connected, nothing armed, audition off — the silent case', () => {
  const lines = deviceSetupReport(base);
  assert(has(lines, 'midi.silent'), keys(lines));
  eq(deviceSetupStatus(lines), 'warn', 'warn');
  const line = lines.find((l) => l.key === 'midi.silent')!;
  assert((line.fix ?? '').includes('오디션'), 'the fix names the switch that fixes it');
});

check('turning audition on clears the silent warning', () => {
  const off = deviceSetupReport(base);
  const on = deviceSetupReport(withInput({ audition: true, midiOpen: true }));
  assert(has(off, 'midi.silent'), 'silent before');
  assert(!has(on, 'midi.silent'), `not silent after — ${keys(on)}`);
  assert(has(on, 'midi.audition'), keys(on));
  eq(deviceSetupStatus(on), 'ok', 'ok');
});

check('arming clears it too, without audition', () => {
  const lines = deviceSetupReport(withInput({ armedMidiCount: 2 }));
  assert(has(lines, 'midi.armed'), keys(lines));
  assert(lines.find((l) => l.key === 'midi.armed')!.detail.includes('2'),
    'says how many tracks are listening');
  eq(deviceSetupStatus(lines), 'ok', 'ok');
});

check('audition with no instrument track is its own problem', () => {
  const lines = deviceSetupReport(withInput({ audition: true, instrumentTrackCount: 0 }));
  // "Turn audition on" would be useless advice here — it already is on.
  assert(has(lines, 'midi.no-instrument'), keys(lines));
  assert(!has(lines, 'midi.silent'), 'not blamed on the audition switch');
});

check('audition that has not opened the port yet says so', () => {
  const open = deviceSetupReport(withInput({ audition: true, midiOpen: true }));
  const opening = deviceSetupReport(withInput({ audition: true, midiOpen: false }));
  const a = open.find((l) => l.key === 'midi.audition')!.detail;
  const b = opening.find((l) => l.key === 'midi.audition')!.detail;
  assert(a !== b, 'an open port and a port being opened do not read the same');
  eq(deviceSetupStatus(opening), 'ok', 'still ok — it is a transient, not a fault');
});

check('a chosen port that has gone is reported, because the fallback is silent', () => {
  const lines = deviceSetupReport(withInput({ selectedMidiInputId: 'gone', armedMidiCount: 1 }));
  assert(has(lines, 'midi.selection-gone'), keys(lines));
  // It still works — every port is listened to — so the status is a warning
  // and the armed line is still there.
  assert(has(lines, 'midi.armed'), 'the keyboard still works');
  eq(deviceSetupStatus(lines), 'warn', 'warn, not blocked');
});

check('a chosen port that is present is not reported', () => {
  const lines = deviceSetupReport(withInput({ selectedMidiInputId: 'kb', armedMidiCount: 1 }));
  assert(!has(lines, 'midi.selection-gone'), keys(lines));
  eq(deviceSetupStatus(lines), 'ok', 'ok');
});

check('midiSelectionResolves: null means every port and always resolves', () => {
  const ports = [{ id: 'kb', name: 'MPK mini', connected: true }];
  eq(midiSelectionResolves(null, ports), true, 'null');
  eq(midiSelectionResolves('', ports), true, 'empty string is the same as null');
  eq(midiSelectionResolves('kb', ports), true, 'present');
  eq(midiSelectionResolves('kb', []), false, 'absent');
});

check('connectedPorts drops the ones that left', () => {
  const ports = [
    { id: 'a', name: 'A', connected: true },
    { id: 'b', name: 'B', connected: false },
  ];
  eq(connectedPorts(ports).length, 1, 'one live');
  eq(connectedPorts(ports)[0]!.id, 'a', 'the live one');
});

// ── audio half ───────────────────────────────────────────────────────────────

check('no audio inputs is a warning of its own', () => {
  const lines = deviceSetupReport(withInput({ audioInputs: [], armedMidiCount: 1 }));
  assert(has(lines, 'audio.none'), keys(lines));
  // The MIDI half is fine, so the report has to be able to say both things.
  assert(has(lines, 'midi.armed'), 'midi is still reported as fine');
});

check('unnamed inputs mean permission, not missing hardware', () => {
  const lines = deviceSetupReport(withInput({
    audioInputs: [{ id: 'a', label: '' }, { id: 'b', label: '   ' }], armedMidiCount: 1,
  }));
  assert(has(lines, 'audio.unnamed'), keys(lines));
  assert((lines.find((l) => l.key === 'audio.unnamed')!.fix ?? '').includes('권한'),
    'the fix names permission');
});

check('one named input is enough to stop the permission warning', () => {
  const lines = deviceSetupReport(withInput({
    audioInputs: [{ id: 'a', label: '' }, { id: 'b', label: 'Scarlett' }], armedMidiCount: 1,
  }));
  assert(has(lines, 'audio.ok'), keys(lines));
});

check('deviceSetupStatus takes the worst, in both orders', () => {
  const ok: DeviceLine = { key: 'a', status: 'ok', title: '', detail: '' };
  const warn: DeviceLine = { key: 'b', status: 'warn', title: '', detail: '' };
  const blocked: DeviceLine = { key: 'c', status: 'blocked', title: '', detail: '' };
  eq(deviceSetupStatus([]), 'ok', 'empty');
  eq(deviceSetupStatus([ok, warn]), 'warn', 'warn beats ok');
  eq(deviceSetupStatus([blocked, warn, ok]), 'blocked', 'blocked first');
  eq(deviceSetupStatus([ok, warn, blocked]), 'blocked', 'blocked last');
});

check('every report says something — no silent empty panel', () => {
  const cases: DeviceSetupInput[] = [
    base,
    withInput({ midiSupported: false }),
    withInput({ midiInputs: [] }),
    withInput({ audition: true, midiOpen: true }),
    withInput({ armedMidiCount: 1 }),
    withInput({ audition: true, instrumentTrackCount: 0 }),
  ];
  for (const input of cases) {
    const lines = deviceSetupReport(input);
    assert(lines.length > 0, 'a report with no lines is a blank panel');
    for (const line of lines) {
      assert(line.title.trim().length > 0, `${line.key} has a title`);
      assert(line.detail.trim().length > 0, `${line.key} has a detail`);
      if (line.status !== 'ok') {
        assert((line.fix ?? '').trim().length > 0, `${line.key} tells the user what to do`);
      }
    }
  }
});

// ── who keeps the port open ──────────────────────────────────────────────────
//
// The port has three reasons to stay open — an armed track, a mapped control
// surface, audition — and exactly one of them closing it is the bug this
// class exists to prevent.

check('nothing holding it and no track — the port closes', () => {
  const holds = new MidiHolds();
  eq(holds.shouldClose(0), true, 'close');
  eq(holds.size, 0, 'empty');
});

check('a track wanting the port keeps it open with no holder at all', () => {
  const holds = new MidiHolds();
  eq(holds.shouldClose(1), false, 'a track is reason enough');
});

check('audition letting go does not close a mapped control surface', () => {
  // This is the regression.  With one shared flag, switching audition off
  // closed the port out from under the surface and the desk went dead.
  const holds = new MidiHolds();
  holds.hold('surface');
  holds.hold('audition');
  holds.release('audition');
  eq(holds.has('surface'), true, 'the surface keeps its claim');
  eq(holds.shouldClose(0), false, 'and the port stays open');
});

check('and the same the other way round', () => {
  const holds = new MidiHolds();
  holds.hold('surface');
  holds.hold('audition');
  holds.release('surface');
  eq(holds.has('audition'), true, 'audition keeps its claim');
  eq(holds.shouldClose(0), false, 'port stays open');
});

check('the last holder letting go does close it', () => {
  const holds = new MidiHolds();
  holds.hold('surface');
  holds.hold('audition');
  holds.release('surface');
  holds.release('audition');
  eq(holds.shouldClose(0), true, 'nobody left');
  eq(holds.shouldClose(2), false, 'unless a track still wants it');
});

check('claiming twice is one claim, and releasing once frees it', () => {
  const holds = new MidiHolds();
  holds.hold('audition');
  holds.hold('audition');
  eq(holds.size, 1, 'one holder');
  holds.release('audition');
  eq(holds.shouldClose(0), true, 'a doubled claim is not a reference count');
});

check('releasing something that never held it changes nothing', () => {
  const holds = new MidiHolds();
  holds.hold('surface');
  holds.release('audition');
  eq(holds.has('surface'), true, 'surface untouched');
  eq(holds.shouldClose(0), false, 'still open');
});

check('clear drops everything — shutdown frees the port', () => {
  const holds = new MidiHolds();
  holds.hold('surface');
  holds.hold('audition');
  holds.clear();
  eq(holds.size, 0, 'empty');
  eq(holds.shouldClose(0), true, 'closable');
});

check('list names who is holding it', () => {
  const holds = new MidiHolds();
  holds.hold('audition');
  eq(holds.list().join(','), 'audition', 'one');
  holds.hold('surface');
  eq(holds.list().sort().join(','), 'audition,surface', 'both');
});

// ── the window it lives in ───────────────────────────────────────────────────

check('device setup and the control surface share one slot', () => {
  const slot = PANEL_SLOTS.find((g) => g.includes('deviceSetup'));
  assert(slot !== undefined, 'deviceSetup is in a slot group');
  assert(slot!.includes('surface'), 'with the control surface — they draw at the same place');
  eq(panelsSharingSlot('deviceSetup').join(','), 'surface', 'its mate');
  eq(panelsSharingSlot('surface').join(','), 'deviceSetup', 'and back');
});

check('a panel in no group closes nothing', () => {
  eq(panelsSharingSlot('mediaBay').length, 0, 'MediaBay has its own place');
});

check('opening device setup closes the control surface, and back', () => {
  // Both are `fixed right-3 top-14 … z-40`.  Two of them open is one visible
  // panel with a fully clickable invisible one behind it.
  const ws = useWorkspaceStore.getState();
  ws.setPanel('surface', true);
  ws.setPanel('deviceSetup', true);
  eq(useWorkspaceStore.getState().panels.surface, false, 'the surface stepped aside');
  eq(useWorkspaceStore.getState().panels.deviceSetup, true, 'device setup is up');

  ws.togglePanel('surface');
  eq(useWorkspaceStore.getState().panels.deviceSetup, false, 'and device setup steps aside');
  eq(useWorkspaceStore.getState().panels.surface, true, 'surface is up');
  ws.setPanel('surface', false);
});

check('CLOSING one does not close its mate', () => {
  const ws = useWorkspaceStore.getState();
  ws.setPanel('deviceSetup', true);
  ws.setPanel('surface', false);
  eq(useWorkspaceStore.getState().panels.deviceSetup, true,
    'closing the surface must not take device setup with it');
  ws.setPanel('deviceSetup', false);
});

// ── the key that opens it ────────────────────────────────────────────────────

check('F4 is bound to device setup, and to nothing else', () => {
  const def = SHORTCUTS.find((s) => s.id === 'window.deviceSetup');
  assert(def !== undefined, 'window.deviceSetup is in the table');
  eq(def!.chords.join(','), 'F4', 'F4');
  eq(def!.available, true, 'available');
  const others = SHORTCUTS.filter((s) => s.id !== 'window.deviceSetup' && s.chords.includes('F4'));
  eq(others.length, 0, `F4 is not shared — ${others.map((s) => s.id).join(',')}`);
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Device setup: targets · diagnosis · the key ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
