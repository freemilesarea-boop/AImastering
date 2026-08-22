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
  DEFAULT_RECORD_SETTINGS, DEFAULT_TRACK_INPUT, armedSplit, armedTracks, canRecord,
  clearRecordArm, planRecording, setRecordArm, trackRecordKind,
  type RecordPlan, type RecordSettings, type TrackInput,
} from '../daw/model/recording.js';
import { commitPass, describePass, passIsEmpty } from '../daw/edit/record-pass.js';
import { listInputDevices, requestInputPermission, type InputDevice } from '../daw/engine/recorder.js';
import { isMidiSupported, listMidiInputs, type MidiInputDevice } from '../daw/engine/midi-input.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { useDawStore } from './dawStore.js';
import type { TrackId } from '../daw/model/types.js';
import { resolveTrackInput, trackInputRef } from '../daw/model/track-input.js';
import {
  assignInputDevice, rememberResolved, setTrackInputChannels,
} from '../daw/edit/track-input-ops.js';

export type RecordStatus = 'idle' | 'armed' | 'countIn' | 'recording' | 'committing';

interface RecordingState {
  status: RecordStatus;
  settings: RecordSettings;
  devices: InputDevice[];
  midiDevices: MidiInputDevice[];
  /**
   * What each armed track listens to.  Per track, because six microphones on
   * one interface is six different inputs, and a DAW that can only say
   * "the input device" cannot record a band.
   */
  inputs: Record<TrackId, TrackInput>;
  /** True once a MIDI input is actually open. */
  midiOpen: boolean;
  /** Last key played, for the activity light.  Cleared when it comes up. */
  midiNote: { pitch: number; velocity: number } | null;
  /** Peak of each track's live input, 0…1. */
  levels: Record<TrackId, number>;
  /** Seconds of tape rolled on the current take. */
  elapsedSec: number;
  plan: RecordPlan | null;
  /** What the last committed pass laid down. */
  lastTakeNote: string | null;
  error: string | null;

  setSettings: (patch: Partial<RecordSettings>) => void;
  setTrackInput: (trackId: TrackId, patch: Partial<TrackInput>) => void;
  refreshDevices: () => Promise<void>;
  refreshMidiDevices: () => Promise<void>;
  toggleArm: (trackId: TrackId) => Promise<void>;
  /** Match the one MIDI handle to whichever instrument tracks are armed. */
  syncMidiArm: () => Promise<void>;
  disarmTrack: (trackId: TrackId) => void;
  disarmAll: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

/** One unsubscribe per open input, so closing one track leaves the rest alone. */
const levelUnsubscribers = new Map<TrackId, () => void>();
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let midiNoteClear: ReturnType<typeof setTimeout> | null = null;

function dropLevelListener(trackId: TrackId): void {
  levelUnsubscribers.get(trackId)?.();
  levelUnsubscribers.delete(trackId);
}

function stopElapsed(): void {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: 'idle',
  settings: DEFAULT_RECORD_SETTINGS,
  devices: [],
  midiDevices: [],
  inputs: {},
  midiOpen: false,
  midiNote: null,
  levels: {},
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

    if (patch.monitoring !== undefined && patch.monitoring !== before.monitoring) {
      const on = patch.monitoring === 'on';
      dawRuntime.setAllMonitoring(on);
      if (get().midiOpen) dawRuntime.setMidiMonitoring(on);
    }
    if (get().midiOpen
      && patch.midiInputId !== undefined && patch.midiInputId !== before.midiInputId) {
      const daw = useDawStore.getState();
      const midiTracks = armedSplit(daw.session).midi.map((t) => t.id);
      if (midiTracks.length === 0) return;
      void dawRuntime.openMidiInput(daw.session, midiTracks, {
        deviceId: patch.midiInputId,
        monitor: get().settings.monitoring === 'on',
      }).then(
        (handle) => set({ midiOpen: handle.deviceCount > 0, error: null }),
        (err: Error) => set({ midiOpen: false, error: err.message }),
      );
    }
  },

  /**
   * Change what ONE armed track listens to, and re-open just that input.
   *
   * Re-opening is the only way a device change reaches a stream that is
   * already running, and doing it per track is what keeps changing microphone
   * four from interrupting the other five.
   */
  setTrackInput: (trackId, patch) => {
    const current = get().inputs[trackId] ?? DEFAULT_TRACK_INPUT;
    const next: TrackInput = { ...current, ...patch };
    set({ inputs: { ...get().inputs, [trackId]: next } });

    // The choice goes into the SESSION, by device NAME, so it is still there
    // tomorrow — and on the other machine, where the id means nothing.  This
    // is an edit to the project like any other, which is what makes it save
    // with the project and undo with everything else.
    useDawStore.getState().apply((session) => {
      let out = session;
      if (patch.deviceId !== undefined) {
        const device = get().devices.find((d) => d.id === next.deviceId) ?? null;
        out = assignInputDevice(out, trackId, device, next.channels);
      }
      if (patch.channels !== undefined) out = setTrackInputChannels(out, trackId, next.channels);
      return out;
    });

    if (!dawRuntime.inputFor(trackId)) return;
    const daw = useDawStore.getState();
    void dawRuntime.openInput(daw.session, trackId, {
      deviceId: next.deviceId,
      channels: next.channels,
      monitor: get().settings.monitoring === 'on',
    }).then(
      (capture) => {
        if (!capture) { set({ error: '입력을 다시 열 수 없습니다' }); return; }
        dropLevelListener(trackId);
        levelUnsubscribers.set(trackId,
          capture.onLevel((peak) => set({ levels: { ...get().levels, [trackId]: peak } })));
        set({ error: null });
      },
      (err: Error) => set({ error: err.message }),
    );
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

    // Arming NO LONGER disarms everything else: several tracks rolling at once
    // is the point.  Each one opens its own input and closes its own input.
    daw.apply((s) => setRecordArm(s, trackId, arming));

    if (!arming) {
      get().disarmTrack(trackId);
      return;
    }

    const { settings } = get();
    try {
      if (trackRecordKind(track) === 'midi') {
        await get().syncMidiArm();
        set({ status: 'armed', error: null });
        void get().refreshMidiDevices();
        return;
      }

      // What this track records from is a property of the track, resolved
      // against what is plugged in right now.  A saved device that is not
      // here falls back to the system default and SAYS SO — recording a
      // vocal off the laptop microphone because the interface is unplugged
      // is the failure nobody hears until playback.
      const saved = trackInputRef(track);
      const resolution = resolveTrackInput(saved, get().devices);
      const input: TrackInput = saved.deviceLabel || saved.deviceId
        ? { deviceId: resolution.deviceId, channels: resolution.channels }
        : (get().inputs[trackId] ?? {
          deviceId: settings.inputDeviceId, channels: settings.channels,
        });
      set({ inputs: { ...get().inputs, [trackId]: input } });
      if (resolution.reason) set({ error: `${track.name}: ${resolution.reason}` });
      // The id the lookup found is worth keeping: next time it is the fast path.
      if (resolution.kind === 'label') {
        useDawStore.getState().apply((s2) => rememberResolved(s2, trackId, resolution));
      }
      const capture = await dawRuntime.openInput(useDawStore.getState().session, trackId, {
        deviceId: input.deviceId,
        channels: input.channels,
        monitor: settings.monitoring === 'on',
      });
      if (!capture) throw new Error('입력을 열 수 없습니다');
      dropLevelListener(trackId);
      levelUnsubscribers.set(trackId,
        capture.onLevel((peak) => set({ levels: { ...get().levels, [trackId]: peak } })));
      set({ status: 'armed', error: null });
    } catch (err) {
      useDawStore.getState().apply((s) => setRecordArm(s, trackId, false));
      set({
        status: armedTracks(useDawStore.getState().session).length > 0 ? 'armed' : 'idle',
        error: `${track.name}: ${(err as Error).message}`,
      });
    }
  },

  /**
   * Open, re-open or close the ONE keyboard, matched to the armed instrument
   * tracks.  There is a single MIDI handle no matter how many tracks are
   * armed — the keyboard is one device; what changes is who hears it.
   */
  syncMidiArm: async () => {
    const daw = useDawStore.getState();
    const midiTracks = armedSplit(daw.session).midi.map((t) => t.id);
    if (midiTracks.length === 0) {
      dawRuntime.onMidiActivity = null;
      dawRuntime.closeMidiInput();
      set({ midiOpen: false, midiNote: null });
      return;
    }
    if (dawRuntime.isMidiOpen) {
      // Already listening — just widen or narrow who it plays through.
      dawRuntime.setMidiTracks(midiTracks);
      return;
    }
    const handle = await dawRuntime.openMidiInput(daw.session, midiTracks, {
      deviceId: get().settings.midiInputId,
      monitor: get().settings.monitoring === 'on',
    });
    dawRuntime.onMidiActivity = (event) => {
      if (event.kind !== 'noteOn') return;
      if (midiNoteClear) clearTimeout(midiNoteClear);
      set({ midiNote: { pitch: event.pitch, velocity: event.velocity } });
      // The light stays lit briefly after the key comes up, otherwise a
      // staccato note is a flicker nobody sees.
      midiNoteClear = globalThis.setTimeout(() => set({ midiNote: null }), 320);
    };
    set({ midiOpen: handle.deviceCount > 0 });
  },

  /** Disarm one track and close only what belonged to it. */
  disarmTrack: (trackId) => {
    dropLevelListener(trackId);
    dawRuntime.closeInput(trackId);
    const levels = { ...get().levels };
    delete levels[trackId];
    set({ levels });
    void get().syncMidiArm();
    if (armedTracks(useDawStore.getState().session).length === 0) {
      stopElapsed();
      set({ status: 'idle', elapsedSec: 0, plan: null });
    }
  },

  disarmAll: () => {
    for (const trackId of [...levelUnsubscribers.keys()]) dropLevelListener(trackId);
    if (midiNoteClear) { clearTimeout(midiNoteClear); midiNoteClear = null; }
    stopElapsed();
    dawRuntime.onMidiActivity = null;
    dawRuntime.closeInput();
    dawRuntime.closeMidiInput();
    useDawStore.getState().apply((s) => clearRecordArm(s));
    set({
      status: 'idle', midiOpen: false, midiNote: null,
      levels: {}, elapsedSec: 0, plan: null,
    });
  },

  start: async () => {
    const daw = useDawStore.getState();
    const { settings } = get();
    const readiness = canRecord(daw.session, settings, {
      audioOpen: dawRuntime.openInputTracks,
      midiOpen: dawRuntime.isMidiOpen,
    });
    if (!readiness.ok) { set({ error: readiness.reason ?? '녹음할 수 없습니다' }); return; }

    const loop = daw.loopEnabled ? { startSec: daw.loopStartSec, endSec: daw.loopEndSec } : null;
    const plan = planRecording(daw.session, settings, daw.playheadSec, loop);
    set({
      plan, error: null, elapsedSec: 0, lastTakeNote: null,
      status: plan.countInSec > 0 ? 'countIn' : 'recording',
    });

    try {
      // One call for the whole pass — microphones and keyboard alike ride the
      // same transport from the same tape zero.
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
    const daw = useDawStore.getState();
    const captured = dawRuntime.stopRecording();

    if (!plan || passIsEmpty(captured)) {
      set({ status: 'armed', elapsedSec: 0, plan: null, error: '녹음된 것이 없습니다' });
      return;
    }

    set({ status: 'committing' });
    try {
      // Every track lands in ONE edit, so one Cmd+Z takes the whole pass back.
      const result = await commitPass(daw.session, {
        audio: captured.audio,
        midi: captured.midi,
        tapeSec: captured.tapeSec,
      }, plan, settings);
      useDawStore.getState().apply(() => result.session);
      set({
        status: 'armed', elapsedSec: 0, plan: null,
        lastTakeNote: describePass(result),
        // A track that recorded nothing is reported, not swallowed — with six
        // microphones open, a silent one has to be findable.
        error: result.problems.length > 0 ? result.problems.join(' / ') : null,
      });
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
