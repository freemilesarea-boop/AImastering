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
  assignInputDevice, rememberResolved, setTrackInputPatch,
} from '../daw/edit/track-input-ops.js';
import type { InputPatch } from '../daw/model/input-channels.js';
import {
  MAX_LATENCY_SEC, agreeLoopback, latencyFromContext, measureLoopback,
  type LatencyConfig,
} from '../daw/model/input-latency.js';

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
  /** True while the loopback click is being played and listened for. */
  calibrating: boolean;
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
  /**
   * How wide each device turned out to be, keyed by device id.
   *
   * Filled in when a stream opens, because that is the only moment the
   * browser will say.  `''` is the system default's key, since it has no id.
   */
  deviceWidths: Record<string, number>;
  error: string | null;

  setSettings: (patch: Partial<RecordSettings>) => void;
  setTrackInput: (trackId: TrackId, patch: Partial<TrackInput>) => void;
  /** Remember an open stream's real width, so the picker can offer it. */
  noteDeviceWidth: (deviceId: string | null, channels: number) => void;
  /** How many inputs a device is known to have.  2 until one has been opened. */
  widthOf: (deviceId: string | null) => number;
  /** Take the browser's own estimate — free, and better than nothing. */
  readReportedLatency: () => void;
  setLatency: (config: Partial<LatencyConfig>) => void;
  /** Play a click, hear it come back, and time the round trip. */
  calibrateLatency: () => Promise<void>;
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

/**
 * How long after the tape starts the calibration click is played.
 *
 * Long enough that the click is nowhere near the first block — the noise-floor
 * check needs a couple of quiet milliseconds in front of it to tell a hot
 * input from a click at sample zero.
 */
const CALIBRATION_LEAD_SEC = 0.25;

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
  calibrating: false,
  midiOpen: false,
  midiNote: null,
  levels: {},
  elapsedSec: 0,
  plan: null,
  lastTakeNote: null,
  deviceWidths: {},
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
      const socket: InputPatch = { firstChannel: next.firstChannel, channels: next.channels };
      if (patch.deviceId !== undefined) {
        const device = get().devices.find((d) => d.id === next.deviceId) ?? null;
        out = assignInputDevice(out, trackId, device, socket);
      }
      if (patch.channels !== undefined || patch.firstChannel !== undefined) {
        out = setTrackInputPatch(out, trackId, socket);
      }
      return out;
    });

    if (!dawRuntime.inputFor(trackId)) return;
    const daw = useDawStore.getState();
    void dawRuntime.openInput(daw.session, trackId, {
      deviceId: next.deviceId,
      channels: next.channels,
      firstChannel: next.firstChannel,
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

  noteDeviceWidth: (deviceId, channels) => {
    const key = deviceId ?? '';
    if (get().deviceWidths[key] === channels) return;
    set({ deviceWidths: { ...get().deviceWidths, [key]: channels } });
  },

  widthOf: (deviceId) => {
    const known = get().deviceWidths[deviceId ?? ''];
    if (known) return known;
    // Fall back to what `enumerateDevices` was willing to say, and to 2 when
    // it said nothing — never to a guess wide enough to offer sockets that
    // may not exist.
    const device = get().devices.find((d) => d.id === (deviceId ?? ''));
    return device?.channels ?? 2;
  },

  /**
   * Read `baseLatency` + `outputLatency` off the live context.
   *
   * Never overwrites a MEASURED number: a loopback measurement includes the
   * interface's input converters, which these two do not, so replacing it
   * with them would be a downgrade dressed as a refresh.
   */
  readReportedLatency: () => {
    const { settings } = get();
    if (settings.latencySource === 'measured') return;
    const config = latencyFromContext(dawRuntime.context);
    if (config.source === 'none') return;
    set({
      settings: {
        ...settings,
        latencySec: config.seconds,
        latencySource: config.source,
      },
    });
  },

  setLatency: (config) => {
    const { settings } = get();
    set({
      settings: {
        ...settings,
        ...(config.seconds !== undefined ? { latencySec: config.seconds } : {}),
        ...(config.source !== undefined ? { latencySource: config.source } : {}),
        ...(config.enabled !== undefined ? { latencyEnabled: config.enabled } : {}),
      },
    });
  },

  /**
   * Measure the round trip by playing a click and finding it in the input.
   *
   * Three passes of the tape, because one is not evidence:
   *
   *   1. SILENCE.  Nothing played.  Anything above the threshold here means
   *      the input already has signal on it and no click can be told apart
   *      from it.
   *   2. and 3. THE CLICK, twice.  The round trip is the same both times; a
   *      transient that is not our click is not.
   *
   * The reference is the moment the click was SCHEDULED, and the capture's
   * zero is taken the instant the tape starts, so the answer carries up to one
   * render block (about 3 ms) of uncertainty from the block boundary the
   * worklet happened to be on.  Said in the panel rather than hidden, because
   * a measurement that claims more precision than it has is worse than an
   * estimate that admits what it is.
   */
  calibrateLatency: async () => {
    const ctx = dawRuntime.context;
    if (!ctx) { set({ error: '오디오 엔진이 아직 열려 있지 않습니다' }); return; }
    if (get().status !== 'armed') {
      set({ error: '보정은 무장 상태에서만 — 녹음 중에는 테이프를 건드릴 수 없습니다' });
      return;
    }
    const trackId = armedSplit(useDawStore.getState().session).audio[0]?.id;
    const capture = trackId ? dawRuntime.inputFor(trackId) : null;
    if (!capture) { set({ error: '오디오 트랙을 하나 무장한 뒤 보정하세요' }); return; }

    /** One pass of the tape.  `withClick` false listens without playing. */
    const pass = async (withClick: boolean): Promise<number | null> => {
      capture.start();
      const startedAt = ctx.currentTime;
      const clickAt = startedAt + CALIBRATION_LEAD_SEC;

      if (withClick) {
        // Short, loud.  Loud so the threshold is nowhere near the room; short
        // so the FIRST crossing is the front edge and not the middle of a tone.
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 1000;
        gain.gain.setValueAtTime(0, clickAt);
        gain.gain.linearRampToValueAtTime(0.8, clickAt + 0.0005);
        gain.gain.exponentialRampToValueAtTime(0.0001, clickAt + 0.02);
        osc.connect(gain).connect(ctx.destination);
        osc.start(clickAt);
        osc.stop(clickAt + 0.03);
      }

      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, (CALIBRATION_LEAD_SEC + MAX_LATENCY_SEC + 0.25) * 1000);
      });

      const buffer = capture.stop();
      const found = measureLoopback(
        buffer.toChannels()[0] ?? new Float32Array(0), buffer.sampleRate,
        { playedAtSec: clickAt - startedAt },
      );
      buffer.clear();
      return found;
    };

    set({ calibrating: true, error: null });
    try {
      await ctx.resume();

      // Listen first, with nothing played.  Anything crossing the threshold in
      // a silent pass means the input already has signal on it, and a click
      // measured against that would return whatever the room did — which is
      // exactly how an unplugged input produces a confident number.
      if (await pass(false) !== null) {
        set({
          error: '입력에 이미 신호가 들어오고 있어 보정할 수 없습니다 — '
            + '연주를 멈추고 입력 레벨을 확인한 뒤 다시 시도하세요',
        });
        return;
      }

      // Then the same click twice.  The round trip does not change between
      // them; anything else does.
      const seconds = agreeLoopback([await pass(true), await pass(true)]);
      if (seconds === null) {
        set({
          error: '클릭을 확인하지 못했습니다 — 출력을 입력으로 되돌려 연결했는지, '
            + '입력 레벨이 너무 낮지 않은지 확인하세요',
        });
        return;
      }
      set({
        settings: {
          ...get().settings,
          latencySec: seconds, latencySource: 'measured', latencyEnabled: true,
        },
      });
    } catch (err) {
      set({ error: `보정 실패: ${(err as Error).message}` });
    } finally {
      set({ calibrating: false });
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
        ? {
          deviceId: resolution.deviceId,
          channels: resolution.patch.channels,
          firstChannel: resolution.patch.firstChannel,
        }
        : (get().inputs[trackId] ?? {
          deviceId: settings.inputDeviceId,
          channels: settings.channels,
          firstChannel: 0,
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
        firstChannel: input.firstChannel,
        monitor: settings.monitoring === 'on',
      });
      if (!capture) throw new Error('입력을 열 수 없습니다');

      // The open stream is the only honest answer to "how many inputs does
      // this box have" — `enumerateDevices` usually will not say.  Recording
      // it here is what lets the picker offer input 5 at all, and what tells
      // the user when the socket they chose was pulled back to a real one.
      get().noteDeviceWidth(input.deviceId, capture.deviceChannels);
      if (capture.patch.firstChannel !== input.firstChannel
        || capture.patch.channels !== input.channels) {
        set({
          inputs: {
            ...get().inputs,
            [trackId]: { ...input, ...capture.patch },
          },
          error: `${track.name}: 선택한 입력이 이 장치에 없어 ${capture.patchLabel} 로 열었습니다`,
        });
      }
      // The context can finally be asked what it costs, now that it is running.
      get().readReportedLatency();
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
