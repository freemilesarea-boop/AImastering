/**
 * recording-store-selftest — the orchestration between the arm and the take.
 *
 * `recordingStore.ts` is 714 lines and ten of its twelve imports come from
 * `daw/`, which is the tested side.  What it adds on top is the part nothing
 * tested: a five-state machine, and two claims written at the top of the file.
 *
 *   · "A take is only ever committed from `recording`."
 *   · "the input is closed by exactly one path (`disarm`), so a half-open
 *      microphone is not reachable."
 *
 * Both are about ORDER, and order is what a store is for.  The 2026-11-05
 * feature check named this file as the largest piece of the app reached only
 * by the app smoke's one happy path through it.
 *
 * The engine and the IPC boundary are stood in for; the store is not.  Every
 * method of `dawRuntime` the store calls is shadowed on the singleton (they
 * all live on its prototype, so an own property hides them and the original
 * comes back on delete), and `window.electronAPI` is answered so the commit
 * path runs to its end instead of dying at the file write.  What runs for
 * real is the store, `recording.ts`, `record-pass.ts` and the session model.
 */
export {};

import { useRecordingStore } from '../src/renderer/stores/recordingStore.js';
import { useDawStore } from '../src/renderer/stores/dawStore.js';
import { dawRuntime } from '../src/renderer/daw/engine/daw-runtime.js';
import {
  addTrack, createSession, createTrack, findTrack, trackClips,
} from '../src/renderer/daw/model/session-ops.js';
import { setRecordArm } from '../src/renderer/daw/model/recording.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string | (() => string)): void {
  let text: string;
  if (typeof detail === 'string') text = detail;
  else {
    try { text = detail(); } catch (e) { text = `(detail threw: ${(e as Error).message})`; }
  }
  if (ok) { passed++; console.log(`[PASS] ${name} — ${text}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${text}`); }
}

// ── The engine, stood in for ──────────────────────────────────────────────
type Runtime = Record<string, unknown>;
interface Fake {
  calls: string[];
  openTracks: TrackId[];
  midiOpen: boolean;
  recordError: string | null;
  pass: {
    audio: Map<TrackId, { channels: Float32Array[]; sampleRate: number }>;
    midi: { events: unknown[]; trackIds: TrackId[] } | null;
    tapeSec: number;
  };
}
const shadowed: string[] = [];
function fakeRuntime(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    calls: [], openTracks: [], midiOpen: false, recordError: null,
    pass: { audio: new Map(), midi: null, tapeSec: 0 },
    ...over,
  };
  const rt = dawRuntime as unknown as Runtime;
  const put = (k: string, v: unknown): void => {
    Object.defineProperty(rt, k, { value: v, configurable: true, writable: true });
    if (!shadowed.includes(k)) shadowed.push(k);
  };
  const getter = (k: string, g: () => unknown): void => {
    Object.defineProperty(rt, k, { get: g, configurable: true });
    if (!shadowed.includes(k)) shadowed.push(k);
  };
  put('record', async (_s: unknown, _p: unknown) => {
    f.calls.push('record');
    if (f.recordError) throw new Error(f.recordError);
  });
  put('stopRecording', () => { f.calls.push('stopRecording'); return f.pass; });
  put('closeInput', (id?: TrackId) => { f.calls.push(`closeInput(${id ?? 'all'})`); });
  put('closeMidiInput', () => { f.calls.push('closeMidiInput'); });
  put('openMidiInput', async () => { f.calls.push('openMidiInput'); return { deviceCount: 0 }; });
  put('holdMidiOpen', async () => { f.calls.push('holdMidiOpen'); });
  put('releaseMidiHold', (who: string) => { f.calls.push(`releaseMidiHold(${who})`); });
  put('setMidiTracks', () => { f.calls.push('setMidiTracks'); });
  put('setMidiMonitoring', () => { f.calls.push('setMidiMonitoring'); });
  put('midiDeviceNames', () => []);
  getter('openInputTracks', () => f.openTracks);
  getter('isMidiOpen', () => f.midiOpen);
  return f;
}
function restoreRuntime(): void {
  const rt = dawRuntime as unknown as Runtime;
  for (const k of shadowed) delete rt[k];
  shadowed.length = 0;
}

// The file write the commit ends at, answered rather than reached.
const writes: string[] = [];
(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    invoke: async (channel: string, arg: { name?: string }) => {
      writes.push(channel);
      if (channel === 'daw:write-temp-audio') return `/tmp/${arg.name ?? 'take'}.wav`;
      return null;
    },
  },
};

/** Two audio tracks and a master, with `armed` armed for recording. */
function armedSession(): { session: DawSession; armed: TrackId; other: TrackId } {
  let s = createSession('rec');
  const a = createTrack('Vox', 'audio');
  const b = createTrack('Gtr', 'audio');
  s = addTrack(s, a);
  s = addTrack(s, b);
  s = setRecordArm(s, a.id, true);
  return { session: s, armed: a.id, other: b.id };
}
function load(s: DawSession): void { useDawStore.getState().loadSession(s); }
const rec = (): ReturnType<typeof useRecordingStore.getState> => useRecordingStore.getState();
const clipsOn = (id: TrackId): number => {
  const t = findTrack(useDawStore.getState().session, id);
  return t ? trackClips(t).length : -1;
};
console.log('\n=== 녹음 스토어 — 무장과 테이크 사이 ===\n');

async function main(): Promise<void> {

  // ── "A take is only ever committed from `recording`" ──────────────────────
  {
    const { session } = armedSession();
    load(session);
    const f = fakeRuntime();
    for (const from of ['idle', 'armed', 'committing'] as const) {
      useRecordingStore.setState({ status: from, plan: null });
      await rec().stop();
      check(
        `stop() from '${from}' does not end a take there is none of`,
        !f.calls.includes('stopRecording') && rec().status === from,
        `calls: ${f.calls.length === 0 ? 'none' : f.calls.join(', ')} · status still '${rec().status}'`,
      );
    }
    restoreRuntime();
  }

  // ── start() refuses rather than half-starting ─────────────────────────────
  {
    let s = createSession('bare');
    s = addTrack(s, createTrack('Vox', 'audio'));   // armed: nothing
    load(s);
    const f = fakeRuntime();
    useRecordingStore.setState({ status: 'idle', error: null });
    await rec().start();
    check(
      'start() with nothing armed says why and does not roll the transport',
      !f.calls.includes('record') && rec().status === 'idle' && rec().error !== null,
      `status '${rec().status}' · error ${JSON.stringify(rec().error)}`,
    );
    restoreRuntime();
  }
  {
    const { session, armed } = armedSession();
    load(session);
    const f = fakeRuntime({ openTracks: [armed] });
    useRecordingStore.setState({
      status: 'armed', error: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    check(
      'start() with no count-in goes straight to recording',
      rec().status === 'recording' && f.calls.includes('record') && rec().plan !== null,
      `status '${rec().status}' · plan ${rec().plan ? 'set' : 'null'}`,
    );
    rec().cancel();
    restoreRuntime();
  }
  {
    const { session, armed } = armedSession();
    load(session);
    fakeRuntime({ openTracks: [armed] });
    useRecordingStore.setState({
      status: 'armed', error: null,
      settings: { ...rec().settings, countInBars: 2 },
    });
    await rec().start();
    check(
      'and with a count-in it waits in countIn, which is not yet tape',
      rec().status === 'countIn' && (rec().plan?.countInSec ?? 0) > 0,
      `status '${rec().status}' · countInSec ${rec().plan?.countInSec ?? 0}`,
    );
    rec().cancel();
    restoreRuntime();
  }
  {
    const { session, armed } = armedSession();
    load(session);
    const f = fakeRuntime({ openTracks: [armed], recordError: '입력을 열 수 없습니다' });
    useRecordingStore.setState({
      status: 'armed', error: null, plan: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    check(
      'and when the engine refuses, it falls back to armed with no plan left over',
      rec().status === 'armed' && rec().plan === null && rec().error === '입력을 열 수 없습니다',
      `status '${rec().status}' · plan ${rec().plan ? 'STILL SET' : 'null'} · error ${JSON.stringify(rec().error)}`,
    );
    void f;
    restoreRuntime();
  }

  // ── An empty pass writes nothing ──────────────────────────────────────────
  {
    const { session, armed } = armedSession();
    load(session);
    const before = clipsOn(armed);
    const f = fakeRuntime({ openTracks: [armed] });
    useRecordingStore.setState({
      status: 'armed', error: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    await rec().stop();
    check(
      'a pass that captured nothing is reported, and no clip appears',
      rec().status === 'armed' && clipsOn(armed) === before
        && (rec().error ?? '').includes('녹음된 것이 없습니다'),
      `status '${rec().status}' · clips ${before} → ${clipsOn(armed)} · ${JSON.stringify(rec().error)}`,
    );
    check(
      'and it does not pass through committing on the way',
      f.calls.filter((c) => c === 'stopRecording').length === 1,
      `stopRecording ×${f.calls.filter((c) => c === 'stopRecording').length}`,
    );
    restoreRuntime();
  }

  // ── A real pass lands as ONE edit ─────────────────────────────────────────
  {
    const { session, armed } = armedSession();
    load(session);
    const before = clipsOn(armed);
    const audio = new Map<TrackId, { channels: Float32Array[]; sampleRate: number }>([
      [armed, { channels: [new Float32Array(48_000).fill(0.25)], sampleRate: 48_000 }],
    ]);
    fakeRuntime({
      openTracks: [armed],
      pass: { audio, midi: null, tapeSec: 1 },
    });
    useRecordingStore.setState({
      status: 'armed', error: null, lastTakeNote: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    await rec().stop();
    const after = clipsOn(armed);
    check(
      'a captured take is committed to the armed track',
      rec().status === 'armed' && after === before + 1,
      `clips ${before} → ${after} · status '${rec().status}' · note ${JSON.stringify(rec().lastTakeNote)}`,
    );
    check(
      'and the write went through the app’s own channel, not around it',
      writes.includes('daw:write-temp-audio'),
      `channels used: ${[...new Set(writes)].join(', ') || 'none'}`,
    );
    // The claim in the store: "Every track lands in ONE edit, so one Cmd+Z
    // takes the whole pass back."
    useDawStore.getState().undo();
    check(
      'and one undo takes the whole pass back, because it was one edit',
      clipsOn(armed) === before,
      `after one undo: ${clipsOn(armed)} clip(s), wanted ${before}`,
    );
    restoreRuntime();
  }

  // ── The commit failing is not a state to be stuck in ──────────────────────
  {
    const { session, armed } = armedSession();
    load(session);
    const audio = new Map<TrackId, { channels: Float32Array[]; sampleRate: number }>([
      [armed, { channels: [new Float32Array(4_800)], sampleRate: 48_000 }],
    ]);
    fakeRuntime({ openTracks: [armed], pass: { audio, midi: null, tapeSec: 0.1 } });
    const api = (globalThis as unknown as { window: { electronAPI: { invoke: unknown } } }).window;
    const good = api.electronAPI.invoke;
    api.electronAPI.invoke = async () => { throw new Error('디스크가 꽉 찼습니다'); };
    useRecordingStore.setState({
      status: 'armed', error: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    await rec().stop();
    api.electronAPI.invoke = good;
    check(
      'a commit that throws lands in armed, not in committing for ever',
      rec().status === 'armed' && rec().plan === null
        && (rec().error ?? '').includes('디스크가 꽉 찼습니다'),
      `status '${rec().status}' · error ${JSON.stringify(rec().error)}`,
    );
    restoreRuntime();
  }

  // ── cancel() throws the take away ─────────────────────────────────────────
  {
    const { session, armed } = armedSession();
    load(session);
    const before = clipsOn(armed);
    const audio = new Map<TrackId, { channels: Float32Array[]; sampleRate: number }>([
      [armed, { channels: [new Float32Array(48_000).fill(0.5)], sampleRate: 48_000 }],
    ]);
    const f = fakeRuntime({ openTracks: [armed], pass: { audio, midi: null, tapeSec: 1 } });
    useRecordingStore.setState({
      status: 'armed', error: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    rec().cancel();
    check(
      'cancel() stops the transport and writes nothing, with a capture waiting',
      rec().status === 'armed' && rec().plan === null && clipsOn(armed) === before
        && f.calls.includes('stopRecording'),
      `clips ${before} → ${clipsOn(armed)} · elapsed ${rec().elapsedSec}`,
    );
    restoreRuntime();
  }

  // ── "closed by exactly one path" ──────────────────────────────────────────
  {
    const { session, armed, other } = armedSession();
    load(session);
    const f = fakeRuntime({ openTracks: [armed] });
    useRecordingStore.setState({ status: 'armed' });
    rec().disarmTrack(other);
    check(
      'disarming a track closes that track’s input and no other',
      f.calls.includes(`closeInput(${other})`) && !f.calls.includes('closeInput(all)'),
      f.calls.filter((c) => c.startsWith('closeInput')).join(', ') || 'no close',
    );
    restoreRuntime();
  }
  {
    const { session, armed } = armedSession();
    load(session);
    const f = fakeRuntime({ openTracks: [armed] });
    useRecordingStore.setState({ status: 'armed' });
    // The last armed track goes: the session says nothing is armed any more.
    useDawStore.getState().apply((s) => setRecordArm(s, armed, false));
    rec().disarmTrack(armed);
    check(
      'and when the last one goes, the store is idle rather than armed at nothing',
      rec().status === 'idle' && rec().plan === null && rec().elapsedSec === 0,
      `status '${rec().status}'`,
    );
    void f;
    restoreRuntime();
  }
  {
    const { session, armed } = armedSession();
    load(session);
    const f = fakeRuntime({ openTracks: [armed], midiOpen: true });
    useRecordingStore.setState({ status: 'armed', midiOpen: true });
    rec().disarmAll();
    const s = useDawStore.getState().session;
    const stillArmed = s.tracks.filter((t) => t.recordArm).map((t) => t.name);
    check(
      'disarmAll() closes every input and the keyboard, and the session agrees',
      f.calls.includes('closeInput(all)') && f.calls.includes('closeMidiInput')
        && stillArmed.length === 0 && rec().status === 'idle' && !rec().midiOpen,
      `${f.calls.filter((c) => c.includes('close')).join(', ')} · still armed: `
        + `${stillArmed.length === 0 ? 'none' : stillArmed.join(', ')}`,
    );
    restoreRuntime();
  }

  // ── Punch-out is the transport pressing stop ──────────────────────────────
  {
    const { session, armed } = armedSession();
    load(session);
    const f = fakeRuntime({ openTracks: [armed] });
    useRecordingStore.setState({
      status: 'armed', error: null,
      settings: { ...rec().settings, countInBars: 0 },
    });
    await rec().start();
    const punch = (dawRuntime as unknown as { onPunchOut: (() => void) | null }).onPunchOut;
    check(
      'the store answers the engine’s punch-out',
      typeof punch === 'function',
      typeof punch === 'function' ? 'onPunchOut is attached' : 'nothing is listening',
    );
    if (typeof punch === 'function') {
      punch();
      await new Promise((r) => setTimeout(r, 30));
      check(
        'and a punch-out while recording ends the take',
        f.calls.includes('stopRecording') && rec().status === 'armed',
        `status '${rec().status}' after the punch`,
      );
      const callsBefore = f.calls.length;
      punch();
      await new Promise((r) => setTimeout(r, 30));
      check(
        'while a punch-out with no take running does nothing at all',
        f.calls.length === callsBefore,
        `${f.calls.length - callsBefore} extra call(s)`,
      );
    }
    restoreRuntime();
  }

}

main().then(() => {
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}, (err: unknown) => {
  console.error(`\nthe run itself threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
