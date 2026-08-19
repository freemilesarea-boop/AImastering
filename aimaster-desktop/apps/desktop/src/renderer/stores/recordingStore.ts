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
  setRecordArm, type RecordPlan, type RecordSettings,
} from '../daw/model/recording.js';
import { commitRecording } from '../daw/edit/record-actions.js';
import { listInputDevices, requestInputPermission, type InputDevice } from '../daw/engine/recorder.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { useDawStore } from './dawStore.js';
import type { TrackId } from '../daw/model/types.js';

export type RecordStatus = 'idle' | 'armed' | 'countIn' | 'recording' | 'committing';

interface RecordingState {
  status: RecordStatus;
  settings: RecordSettings;
  devices: InputDevice[];
  /** Peak of the live input, 0…1. */
  level: number;
  /** Seconds of tape rolled on the current take. */
  elapsedSec: number;
  plan: RecordPlan | null;
  error: string | null;

  setSettings: (patch: Partial<RecordSettings>) => void;
  refreshDevices: () => Promise<void>;
  toggleArm: (trackId: TrackId) => Promise<void>;
  disarmAll: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

let levelUnsubscribe: (() => void) | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function stopElapsed(): void {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: 'idle',
  settings: DEFAULT_RECORD_SETTINGS,
  devices: [],
  level: 0,
  elapsedSec: 0,
  plan: null,
  error: null,

  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  refreshDevices: async () => {
    // Labels stay blank until permission has been granted once, so ask first.
    await requestInputPermission();
    set({ devices: await listInputDevices() });
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
    try {
      const capture = await dawRuntime.openInput(useDawStore.getState().session, trackId, {
        deviceId: settings.inputDeviceId,
        channels: settings.channels,
        monitor: settings.monitoring === 'on',
      });
      if (!capture) throw new Error('입력을 열 수 없습니다');
      levelUnsubscribe?.();
      levelUnsubscribe = capture.onLevel((peak) => set({ level: peak }));
      set({ status: 'armed', error: null });
    } catch (err) {
      useDawStore.getState().apply((s) => setRecordArm(s, trackId, false));
      set({ status: 'idle', error: (err as Error).message });
    }
  },

  disarmAll: () => {
    levelUnsubscribe?.();
    levelUnsubscribe = null;
    stopElapsed();
    dawRuntime.closeInput();
    useDawStore.getState().apply((s) => clearRecordArm(s));
    set({ status: 'idle', level: 0, elapsedSec: 0, plan: null });
  },

  start: async () => {
    const daw = useDawStore.getState();
    const { settings } = get();
    const readiness = canRecord(daw.session, settings);
    if (!readiness.ok) { set({ error: readiness.reason ?? '녹음할 수 없습니다' }); return; }

    const loop = daw.loopEnabled ? { startSec: daw.loopStartSec, endSec: daw.loopEndSec } : null;
    const plan = planRecording(daw.session, settings, daw.playheadSec, loop);
    set({ plan, error: null, elapsedSec: 0, status: plan.countInSec > 0 ? 'countIn' : 'recording' });

    try {
      await dawRuntime.record(daw.session, plan);
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
    const { status, plan, settings } = get();
    if (status !== 'recording' && status !== 'countIn') return;
    stopElapsed();
    const captured = dawRuntime.stopRecording();
    const daw = useDawStore.getState();
    const track = armedTracks(daw.session)[0];

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
    dawRuntime.stopRecording();
    set({ status: 'armed', elapsedSec: 0, plan: null });
  },
}));

/** Punch-out ends the take without anyone pressing stop. */
dawRuntime.onPunchOut = () => {
  const state = useRecordingStore.getState();
  if (state.status === 'recording' || state.status === 'countIn') void state.stop();
};
