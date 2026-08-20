// Recording store — arm, input, and the state machine around the take.
//
// The states are worth naming rather than deriving from booleans:
//
//   idle       nothing armed, no input open
//   armed      input open, monitoring live, transport free
//   countIn    clicks playing, transport not yet moving
//   recording  transport rolling, tape running
//   committing writing the file and laying the takes down
//
// A take is only ever committed from `recording`, and the input is closed by
// exactly one path (`disarm`), so a half-open microphone is not reachable.

import { create } from 'zustand';
import {
  DEFAULT_RECORD_SETTINGS, armedTracks, canRecord, clearRecordArm, planRecording,
  recordKind, setRecordArm, type RecordKind, type RecordPlan, type RecordSettings,
} from '../daw/model/recording.js';
import { commitRecording } from '../daw/edit/record-actions.js';
import { commitMidiRecording } from '../daw/edit/midi-record-actions.js';
import {
  bendRangeFor, captureNotes, describeCapture, looksLikeMpeStream,
} from '../daw/model/midi-capture.js';
import { listInputDevices, requestInputPermission, type InputDevice } from '../daw/engine/recorder.js';
import { isMidiSupported, listMidiInputs, type MidiInputDevice } from '../daw/engine/midi-input.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { useDawStore } from './dawStore.js';
import type { TrackId } from '../daw/model/types.js';

export type RecordStatus = 'idle' | 'armed' | 'countIn' | 'recording' | 'committing';

interface RecordingState {
  status: RecordStatus;
  settings: RecordSettings;
  devices: InputDevice[];
  midiDevices: MidiInputDevice[];
  /** What the armed track wants — audio tape or a keyboard. */
  kind: RecordKind | null;
  /** True once a MIDI input is actually open. */
  midiOpen: boolean;
  /** Last key played, for the activity light.  Cleared when it comes up. */
  midiNote: { pitch: number; velocity: number } | null;
  /** Peak of the live input, 0…1. */
  level: number;
  /** Seconds of tape rolled on the current take. */
  elapsedSec: number;
  plan: RecordPlan | null;
  /** What the last committed take contained — notes, drops, ignored CCs. */
  lastTakeNote: string | null;
  error: string | null;

  setSettings: (patch: Partial<RecordSettings>) => void;
  refreshDevices: () => Promise<void>;
  refreshMidiDevices: () => Promise<void>;
  toggleArm: (trackId: TrackId) => Promise<void>;
  disarmAll: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

let levelUnsubscribe: (() => void) | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let midiNoteClear: ReturnType<typeof setTimeout> | null = null;

function stopElapsed(): void {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: 'idle',
  settings: DEFAULT_RECORD_SETTINGS,
  devices: [],
  midiDevices: [],
  kind: null,
  midiOpen: false,
  midiNote: null,
  level: 0,
  elapsedSec: 0,
  plan: null,
  lastTakeNote: null,
  error: null,

  /**
   * Settings that describe the NEXT take just get stored; settings that
   * describe the open input have to reach it now, or the toggle would only
   * take effect after a disarm.
   */
  setSettings: (patch) => {
    const before = get().settings;
    set({ settings: { ...before, ...patch } });
    if (!get().midiOpen) return;
    if (patch.monitoring !== undefined && patch.monitoring !== before.monitoring) {
      dawRuntime.setMidiMonitoring(patch.monitoring === 'on');
    }
    if (patch.midiInputId !== undefined && patch.midiInputId !== before.midiInputId) {
      const daw = useDawStore.getState();
      const armed = armedTracks(daw.session)[0];
      if (!armed) return;
      void dawRuntime.openMidiInput(daw.session, armed.id, {
        deviceId: patch.midiInputId,
        monitor: get().settings.monitoring === 'on',
      }).then(
        (handle) => set({ midiOpen: handle.deviceCount > 0, error: null }),
        (err: Error) => set({ midiOpen: false, error: err.message }),
      );
    }
  },

  refreshDevices: async () => {
    // Labels stay blank until permission has been granted once, so ask first.
    await requestInputPermission();
    set({ devices: await listInputDevices() });
  },

  refreshMidiDevices: async () => {
    if (!isMidiSupported()) { set({ midiDevices: [] }); return; }
    set({ midiDevices: await listMidiInputs() });
  },

  /**
   * Arming opens the input; disarming closes it.  Tying the two together is
   * what keeps the microphone from being left on after a session.
   */
  toggleArm: async (trackId) => {
    const daw = useDawStore.getState();
    const track = daw.session.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const arming = !track.recordArm;

    daw.apply((s) => (arming ? setRecordArm(clearRecordArm(s), trackId, true) : setRecordArm(s, trackId, false)));

    if (!arming) {
      get().disarmAll();
      return;
    }

    const { settings } = get();
    const kind: RecordKind = track.kind === 'instrument' ? 'midi' : 'audio';
    try {
      if (kind === 'midi') {
        // A keyboard track opens a keyboard, not a microphone.  Same rule
        // either way: arming opens the input and disarming closes it, so
        // nothing is left listening after a session.
        const handle = await dawRuntime.openMidiInput(useDawStore.getState().session, trackId, {
          deviceId: settings.midiInputId,
          monitor: settings.monitoring === 'on',
        });
        dawRuntime.onMidiActivity = (event) => {
          if (event.kind === 'noteOn') {
            if (midiNoteClear) clearTimeout(midiNoteClear);
            set({ midiNote: { pitch: event.pitch, velocity: event.velocity } });
            // The light stays lit briefly after the key comes up, otherwise a
            // staccato note is a flicker nobody sees.
            midiNoteClear = globalThis.setTimeout(() => set({ midiNote: null }), 320);
          }
        };
        set({ status: 'armed', kind, midiOpen: handle.deviceCount > 0, error: null, level: 0 });
        void get().refreshMidiDevices();
        return;
      }

      const capture = await dawRuntime.openInput(useDawStore.getState().session, trackId, {
        deviceId: settings.inputDeviceId,
        channels: settings.channels,
        monitor: settings.monitoring === 'on',
      });
      if (!capture) throw new Error('입력을 열 수 없습니다');
      levelUnsubscribe?.();
      levelUnsubscribe = capture.onLevel((peak) => set({ level: peak }));
      set({ status: 'armed', kind, midiOpen: false, error: null });
    } catch (err) {
      useDawStore.getState().apply((s) => setRecordArm(s, trackId, false));
      set({ status: 'idle', kind: null, midiOpen: false, error: (err as Error).message });
    }
  },

  disarmAll: () => {
    levelUnsubscribe?.();
    levelUnsubscribe = null;
    if (midiNoteClear) { clearTimeout(midiNoteClear); midiNoteClear = null; }
    stopElapsed();
    dawRuntime.onMidiActivity = null;
    dawRuntime.closeInput();
    dawRuntime.closeMidiInput();
    useDawStore.getState().apply((s) => clearRecordArm(s));
    set({
      status: 'idle', kind: null, midiOpen: false, midiNote: null,
      level: 0, elapsedSec: 0, plan: null,
    });
  },

  start: async () => {
    const daw = useDawStore.getState();
    const { settings } = get();
    const kind = recordKind(daw.session);
    const readiness = canRecord(daw.session, settings, kind === 'midi'
      ? { midiOpen: dawRuntime.isMidiOpen }
      : { audioOpen: dawRuntime.input !== null });
    if (!readiness.ok) { set({ error: readiness.reason ?? '녹음할 수 없습니다' }); return; }

    const loop = daw.loopEnabled ? { startSec: daw.loopStartSec, endSec: daw.loopEndSec } : null;
    const plan = planRecording(daw.session, settings, daw.playheadSec, loop);
    set({
      plan, kind, error: null, elapsedSec: 0, lastTakeNote: null,
      status: plan.countInSec > 0 ? 'countIn' : 'recording',
    });

    try {
      if (kind === 'midi') await dawRuntime.recordMidi(daw.session, plan);
      else await dawRuntime.record(daw.session, plan);
    } catch (err) {
      set({ status: 'armed', error: (err as Error).message, plan: null });
      return;
    }

    if (plan.countInSec > 0) {
      globalThis.setTimeout(() => {
        if (get().status === 'countIn') set({ status: 'recording' });
      }, plan.countInSec * 1000);
    }

    stopElapsed();
    const startedAt = Date.now();
    elapsedTimer = setInterval(() => {
      if (get().status !== 'recording' && get().status !== 'countIn') return;
      set({ elapsedSec: (Date.now() - startedAt) / 1000 });
    }, 100);
  },

  stop: async () => {
    const { status, plan, settings, kind } = get();
    if (status !== 'recording' && status !== 'countIn') return;
    stopElapsed();
    const daw = useDawStore.getState();
    const track = armedTracks(daw.session)[0];

    if (kind === 'midi') {
      const performance = dawRuntime.stopMidiRecording();
      if (!performance || !plan || !track) {
        set({
          status: 'armed', elapsedSec: 0, plan: null,
          error: performance ? null : '연주된 노트가 없습니다',
        });
        return;
      }
      set({ status: 'committing' });
      try {
        const mpe = looksLikeMpeStream(performance.events);
        const captured = captureNotes(performance.events, {
          endSec: performance.tapeSec,
          sustainPedal: settings.midiSustainPedal,
        });
        const result = commitMidiRecording(daw.session, track.id, {
          notes: captured.notes,
          tapeSec: performance.tapeSec,
          config: { bendRangeSemitones: bendRangeFor(mpe), mpe },
        }, plan, settings);
        useDawStore.getState().apply(() => result.session);
        set({
          status: 'armed', elapsedSec: 0, plan: null, error: null,
          lastTakeNote: describeCapture(captured),
        });
      } catch (err) {
        set({ status: 'armed', elapsedSec: 0, plan: null, error: (err as Error).message });
      }
      return;
    }

    const captured = dawRuntime.stopRecording();
    if (!captured || !plan || !track) {
      set({ status: 'armed', elapsedSec: 0, plan: null, error: captured ? null : '녹음된 오디오가 없습니다' });
      return;
    }

    set({ status: 'committing' });
    try {
      const result = await commitRecording(daw.session, track.id, captured, plan, settings);
      useDawStore.getState().apply(() => result.session);
      set({ status: 'armed', elapsedSec: 0, plan: null, error: null });
    } catch (err) {
      set({ status: 'armed', elapsedSec: 0, plan: null, error: (err as Error).message });
    }
  },

  /** Throw the take away — the transport stops and nothing is written. */
  cancel: () => {
    stopElapsed();
    if (get().kind === 'midi') dawRuntime.stopMidiRecording();
    else dawRuntime.stopRecording();
    set({ status: 'armed', elapsedSec: 0, plan: null });
  },
}));

/** Punch-out ends the take without anyone pressing stop. */
dawRuntime.onPunchOut = () => {
  const state = useRecordingStore.getState();
  if (state.status === 'recording' || state.status === 'countIn') void state.stop();
};
