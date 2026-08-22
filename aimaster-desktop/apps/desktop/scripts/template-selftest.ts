/**
 * template-selftest — starting from where you always start.
 *
 * A template is a session setup with the MUSIC TAKEN OUT, and every
 * interesting failure is on that line.  Carry too much and "new from
 * template" drags a previous song's fader moves into a blank project; carry
 * too little and the thing that made it worth saving — the vocal goes to the
 * Reverb bus, the drum bus is pre-fader — is quietly gone and nobody notices
 * until the mix is wrong.
 *
 * So the properties tested here are mostly about IDENTITY ACROSS SESSIONS:
 *
 *   • A bus is remembered by NAME.  An id from the session it was saved in
 *     names nothing anywhere else, and a send carrying one would either break
 *     or — much worse — land on whatever bus happened to take that id.
 *   • Applying twice reuses the bus, it does not make a second "Reverb".
 *   • Clips, automation and freeze do not travel, and saying so is part of
 *     saving: a template that silently drops six automation lanes has told
 *     the user nothing.
 *   • A device this build does not have is named, not dropped in silence.
 *
 * Run: pnpm --filter @aimaster/desktop test:templates
 */

import {
  addFile, addGroup, addTrack, createBus, createClip, createGroup, createSend,
  createSession, createTrack, findTrack, setSend, trackClips, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { createInsert, setInsert } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { createLane } from '../src/renderer/daw/model/automation.js';
import {
  applyTrackTemplate, captureSessionTemplate, captureTrackTemplate,
  describeSessionTemplate, describeTrackTemplate, missingDevices, requiredBuses,
  sessionFromTemplate,
} from '../src/renderer/daw/model/track-template.js';
import type { TrackTemplate } from '../src/renderer/daw/model/track-template.js';
import {
  deleteTrackTemplate, exportTemplates, importTemplates, listSessionTemplates,
  listTrackTemplates, resetTemplateIds, saveSessionTemplate, saveTrackTemplate,
  setTemplateStore,
} from '../src/renderer/daw/engine/template-store.js';
import { setTrackDelay } from '../src/renderer/daw/edit/track-delay-ops.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

/** An in-memory store, so nothing here touches a real localStorage. */
function memoryStore(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

/**
 * A vocal channel worth saving: a compressor and an EQ in their slots, a send
 * to a Reverb bus, output to a Drum-free "Vox Bus", a track delay and a
 * colour someone chose.
 */
function vocalSession(): { session: DawSession; trackId: string; reverbId: string } {
  resetIds();
  let s = createSession('Record', 48_000);
  const reverb = createBus('Reverb');
  const voxBus = createBus('Vox Bus');
  s = { ...s, buses: [reverb, voxBus] };

  const track = createTrack('Vox', 'audio', { color: '#c05f6f', height: 120 });
  s = addTrack(s, track);
  s = updateTrack(s, track.id, (t) => ({
    ...t, volumeDb: -3.5, pan: -0.2, soloSafe: true,
    output: { kind: 'bus', busId: voxBus.id },
  }));
  s = setInsert(s, track.id, createInsert(0, 'comp', 'Comp'));
  s = setInsert(s, track.id, createInsert(2, 'eq8', 'EQ'));
  s = setSend(s, track.id, createSend(1, reverb.id, { levelDb: -8, preFader: true }));
  s = setTrackDelay(s, track.id, -9).session;
  return { session: s, trackId: track.id, reverbId: reverb.id };
}

const capture = (session: DawSession, trackId: string, name = 'Lead Vocal') => {
  const r = captureTrackTemplate(session, trackId, name);
  assert(r, 'the track was found');
  return r!;
};

// ── What a template carries ───────────────────────────────────────────────────

check('the channel travels — routing, level, colour, delay, devices', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  eq(template.name, 'Lead Vocal', 'the template has its own name');
  eq(template.trackName, 'Vox', 'and the track keeps its');
  eq(template.color, '#c05f6f', 'colour');
  eq(template.height, 120, 'height');
  close(template.volumeDb, -3.5, 'fader');
  close(template.pan, -0.2, 'pan');
  eq(template.soloSafe, true, 'solo-safe');
  eq(template.delayMs, -9, 'track delay');
  eq(template.inserts.length, 2, 'both devices');
  eq(template.inserts[0]!.slot, 0, 'in their slots');
  eq(template.inserts[1]!.slot, 2, 'including the gap — where a device sits is part of the chain');
});

check('buses are remembered by name, never by id', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  eq(template.output.kind, 'bus', 'the output is a bus');
  if (template.output.kind === 'bus') eq(template.output.busName, 'Vox Bus', 'named');
  eq(template.sends[0]!.busName, 'Reverb', 'and so is the send');
  eq(template.sends[0]!.preFader, true, 'with how it was set');
  close(template.sends[0]!.levelDb, -8, 'and at what level');
  // Nothing in the saved template may be an id from the session it came from.
  const json = JSON.stringify(template);
  for (const bus of session.buses) {
    assert(!json.includes(bus.id), `the template still carries the id ${bus.id}`);
  }
  eq(requiredBuses(template).sort().join(','), 'Reverb,Vox Bus', 'and both are declared');
});

check('the performance stays behind, and saving says so', () => {
  const { session, trackId } = vocalSession();
  let s = addFile(session, {
    id: 'f1', path: '/v/a.wav', name: 'a', durationSec: 4, sampleRate: 48_000, channels: 2,
  });
  s = updateClips(s, trackId, () => [createClip('f1', 'take', { startSec: 0, durationSec: 4 })]);
  s = updateTrack(s, trackId, (t) => ({
    ...t, automation: [createLane({ kind: 'volume' }, 0)],
    frozen: { fileId: 'f1', renderedInsertIds: [], frozenAt: 1 },
  }));

  const { template, problems } = capture(s, trackId);
  const json = JSON.stringify(template);
  assert(!json.includes('take'), 'no clip came along');
  assert(!json.includes('f1'), 'and no file reference');
  assert(problems.some((p) => p.includes('오토메이션')), `automation is reported: ${problems}`);
  assert(problems.some((p) => p.includes('얼린')), `so is the freeze: ${problems}`);
});

// ── Applying ──────────────────────────────────────────────────────────────────

check('a template applied to an empty session builds its buses', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);

  resetIds();
  const blank = createSession('New', 48_000);
  const applied = applyTrackTemplate(blank, template);
  eq(applied.problems.length, 0, `no problems: ${applied.problems}`);
  eq(applied.createdBuses.sort().join(','), 'Reverb,Vox Bus', 'both buses made');

  const track = findTrack(applied.session, applied.trackIds[0]!)!;
  eq(track.name, 'Vox', 'the track is named from the template');
  eq(track.inserts.length, 2, 'the chain came across');
  eq(track.inserts.find((i) => i.slot === 2)?.pluginId, 'eq8', 'in the right slot');
  eq(track.sends.length, 1, 'and the send');
  const reverb = applied.session.buses.find((b) => b.name === 'Reverb')!;
  eq(track.sends[0]!.target, reverb.id, 'pointing at THIS session’s Reverb bus');
  assert(track.output.kind === 'bus', 'output is a bus');
});

check('applying twice reuses the bus rather than making a second one', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  resetIds();
  let s = createSession('New', 48_000);
  s = applyTrackTemplate(s, template).session;
  const second = applyTrackTemplate(s, template);
  eq(second.createdBuses.length, 0, 'nothing new was needed');
  eq(s.buses.filter((b) => b.name === 'Reverb').length, 1, 'one Reverb');
  eq(second.session.buses.filter((b) => b.name === 'Reverb').length, 1, 'still one Reverb');
  // And the second track points at the same bus as the first.
  const [a, b] = second.session.tracks.filter((t) => t.kind === 'audio');
  eq(a!.sends[0]!.target, b!.sends[0]!.target, 'both sends land on the same bus');
});

check('a count makes numbered tracks, not four tracks called Vox', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  resetIds();
  const applied = applyTrackTemplate(createSession('New', 48_000), template, { count: 4 });
  const names = applied.trackIds.map((id) => findTrack(applied.session, id)!.name);
  eq(names.join(','), 'Vox,Vox 2,Vox 3,Vox 4', 'numbered');
  eq(new Set(names).size, 4, 'and all different');
});

check('a device this build does not have is named, and the rest still lands', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  const broken: TrackTemplate = {
    ...template,
    inserts: [...template.inserts, { slot: 5, pluginId: 'no-such-device', label: 'Fairy Dust', bypass: false, params: {} }],
  };
  eq(missingDevices(broken).join(','), 'Fairy Dust', 'named before applying');
  resetIds();
  const applied = applyTrackTemplate(createSession('New', 48_000), broken);
  assert(applied.problems.some((p) => p.includes('Fairy Dust')), `and named again: ${applied.problems}`);
  const track = findTrack(applied.session, applied.trackIds[0]!)!;
  eq(track.inserts.length, 2, 'the other two still arrived');
});

check('an out-of-range send slot is refused rather than silently moved', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  const broken: TrackTemplate = {
    ...template,
    sends: [{ slot: 99, busName: 'Reverb', levelDb: 0, pan: 0, preFader: false, mute: false }],
  };
  resetIds();
  const applied = applyTrackTemplate(createSession('New', 48_000), broken);
  assert(applied.problems.some((p) => p.includes('99')), `named: ${applied.problems}`);
  eq(findTrack(applied.session, applied.trackIds[0]!)!.sends.length, 0, 'and not placed anywhere');
});

// ── Session templates ─────────────────────────────────────────────────────────

function bandSession(): DawSession {
  const { session, trackId } = vocalSession();
  let s = session;
  const gtr = createTrack('Gtr', 'audio');
  const keys = createTrack('Keys', 'instrument');
  s = addTrack(addTrack(s, gtr), keys);
  s = addGroup(s, createGroup('Band', 'b', [trackId, gtr.id]));
  s = { ...s, tempoBpm: 96, timeSignature: [3, 4], markers: [
    { id: 'm1', name: 'Verse', timeSec: 0 },
    { id: 'm2', name: 'Chorus', timeSec: 32 },
  ] };
  return s;
}

check('a session template carries the skeleton and nothing that was played', () => {
  const s = bandSession();
  const { template, problems } = captureSessionTemplate(s, 'Band Session');
  eq(template.tracks.length, 3, 'three tracks — the master is not one of them');
  assert(!template.tracks.some((t) => t.kind === 'master'), 'no master template');
  eq(template.tempoBpm, 96, 'tempo');
  eq(template.timeSignature.join('/'), '3/4', 'signature');
  eq(template.buses.join(','), 'Reverb,Vox Bus', 'buses by name');
  eq(template.groups[0]!.memberTrackNames.join(','), 'Vox,Gtr', 'group members by name');
  eq(template.markers.map((m) => m.name).join(','), 'Verse,Chorus', 'and the song map');
  eq(problems.length, 0, `nothing was dropped: ${problems}`);
});

check('new-from-template builds a session, not a half-edit of this one', () => {
  const source = bandSession();
  const { template } = captureSessionTemplate(source, 'Band Session');
  resetIds();
  const made = sessionFromTemplate(template, 'Tuesday');

  eq(made.session.name, 'Tuesday', 'named as asked');
  eq(made.session.tempoBpm, 96, 'tempo came across');
  eq(made.session.tracks.filter((t) => t.kind === 'master').length, 1, 'exactly one master');
  eq(made.session.tracks.length, 4, 'three tracks plus the master');
  eq(made.session.buses.length, 2, 'both buses');
  eq(made.session.markers.length, 2, 'the markers');
  eq(made.session.groups.length, 1, 'the group');
  eq(made.session.groups[0]!.memberIds.length, 2, 'with both members found by name');
  // The members are THIS session's tracks, not ids from the old one.
  for (const id of made.session.groups[0]!.memberIds) {
    assert(made.session.tracks.some((t) => t.id === id), `${id} is a track in the new session`);
  }
  // And there is no music in it.
  const clips = made.session.tracks.reduce((n, t) => n + trackClips(t).length, 0);
  eq(clips, 0, 'no clips');
  eq(made.session.files.length, 0, 'no files');
});

check('a group naming a track the template does not have says so', () => {
  const source = bandSession();
  const { template } = captureSessionTemplate(source, 'Band');
  const broken = {
    ...template,
    groups: [{ name: 'Band', symbol: 'b', memberTrackNames: ['Vox', 'Ghost'] }],
  };
  resetIds();
  const made = sessionFromTemplate(broken);
  assert(made.problems.some((p) => p.includes('Ghost')), `named: ${made.problems}`);
  eq(made.session.groups[0]!.memberIds.length, 1, 'and the group has the member it could find');
});

check('the descriptions say what is in the box', () => {
  const { session, trackId } = vocalSession();
  const { template } = capture(session, trackId);
  const line = describeTrackTemplate(template);
  assert(line.includes('인서트 2') && line.includes('센드 1') && line.includes('Vox Bus'), line);
  const s = describeSessionTemplate(captureSessionTemplate(bandSession(), 'Band').template);
  assert(s.includes('트랙 3') && s.includes('96 BPM') && s.includes('3/4'), s);
});

// ── The store ─────────────────────────────────────────────────────────────────

check('saving the same name twice is a correction, not a duplicate', () => {
  setTemplateStore(memoryStore()); resetTemplateIds();
  const { session, trackId } = vocalSession();
  const first = saveTrackTemplate(capture(session, trackId, 'Vox Chain').template);
  assert(first.saved, `saved: ${first.problem}`);
  eq(listTrackTemplates().length, 1, 'one');

  const changed = { ...capture(session, trackId, 'Vox Chain').template, trackName: 'Lead' };
  const second = saveTrackTemplate(changed);
  assert(second.saved, 'saved again');
  eq(listTrackTemplates().length, 1, 'still one');
  eq(listTrackTemplates()[0]!.trackName, 'Lead', 'and it is the new one');
  eq(second.saved!.id, first.saved!.id, 'under the same id');
  eq(second.saved!.createdAt, first.saved!.createdAt, 'keeping when it was first made');
  setTemplateStore(null);
});

check('a store that cannot be written says so instead of pretending', () => {
  setTemplateStore({
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  });
  const { session, trackId } = vocalSession();
  const r = saveTrackTemplate(capture(session, trackId, 'Vox').template);
  eq(r.saved, null, 'not saved');
  assert(r.problem?.includes('저장'), `and says why: ${r.problem}`);
  setTemplateStore(null);
});

check('a corrupted store reads as empty rather than throwing on every render', () => {
  setTemplateStore({ getItem: () => '{{{not json', setItem: () => {} });
  eq(listTrackTemplates().length, 0, 'tracks');
  eq(listSessionTemplates().length, 0, 'sessions');
  setTemplateStore(null);
});

check('one unreadable entry does not take the whole list with it', () => {
  const store = memoryStore();
  setTemplateStore(store); resetTemplateIds();
  const { session, trackId } = vocalSession();
  saveTrackTemplate(capture(session, trackId, 'Good').template);
  const raw = JSON.parse(store.getItem('loui.daw.templates.track')!) as { items: unknown[] };
  raw.items.push({ id: 'x', name: 'Broken' });   // no kind, no inserts
  store.setItem('loui.daw.templates.track', JSON.stringify(raw));
  eq(listTrackTemplates().length, 1, 'the good one survives');
  eq(listTrackTemplates()[0]!.name, 'Good', 'and it is the good one');
  setTemplateStore(null);
});

check('templates move between machines, and importing twice does not double them', () => {
  setTemplateStore(memoryStore()); resetTemplateIds();
  const { session, trackId } = vocalSession();
  saveTrackTemplate(capture(session, trackId, 'Vox Chain').template);
  saveSessionTemplate(captureSessionTemplate(bandSession(), 'Band Session').template);
  const file = exportTemplates();

  setTemplateStore(memoryStore());
  const first = importTemplates(file);
  eq(first.tracks, 1, 'one track template');
  eq(first.sessions, 1, 'one session template');
  eq(first.problems.length, 0, `clean: ${first.problems}`);
  importTemplates(file);
  eq(listTrackTemplates().length, 1, 'importing twice leaves one');
  eq(listSessionTemplates().length, 1, 'of each');
  setTemplateStore(null);
});

check('an import that is not a template file says so', () => {
  setTemplateStore(memoryStore());
  assert(importTemplates('nonsense').problems[0]?.includes('JSON'), 'bad json');
  assert(importTemplates('{"version":1}').problems[0]?.includes('템플릿이 없습니다'), 'empty file');
  const r = importTemplates('{"version":1,"tracks":[{"id":"x","name":"Broken"}],"sessions":[]}');
  eq(r.tracks, 0, 'nothing imported');
  assert(r.problems[0]?.includes('건너뛰었습니다'), `and it is counted: ${r.problems}`);
  setTemplateStore(null);
});

check('deleting removes exactly one', () => {
  setTemplateStore(memoryStore()); resetTemplateIds();
  const { session, trackId } = vocalSession();
  const a = saveTrackTemplate(capture(session, trackId, 'A').template).saved!;
  saveTrackTemplate(capture(session, trackId, 'B').template);
  eq(listTrackTemplates().length, 2, 'two');
  eq(deleteTrackTemplate(a.id), true, 'deleted');
  eq(listTrackTemplates().length, 1, 'one left');
  eq(listTrackTemplates()[0]!.name, 'B', 'the other one');
  eq(deleteTrackTemplate('nope'), false, 'and deleting nothing reports nothing');
  setTemplateStore(null);
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
