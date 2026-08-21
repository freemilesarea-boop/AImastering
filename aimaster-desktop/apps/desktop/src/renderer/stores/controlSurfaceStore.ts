// The control surface, running.
//
// The model decides what a message means and the store decides when to listen.
// Two things shape it:
//
//   THE DESK OUTLIVES THE SESSION.  Mappings are stored beside the app's other
//   machine settings, and the MIDI port is HELD open independently of whether
//   a track is armed — a surface that stops working the moment you disarm a
//   track is not a surface.
//
//   A FADER SENDS A HUNDRED MESSAGES A SECOND.  Each one is applied
//   transiently and the edit is committed when the fader settles, so a move is
//   one undo step rather than a hundred — the same rule the automation
//   gestures already follow.

import { create } from 'zustand';
import {
  createBinding, describeSource, modeFor, sourceOf,
  INITIAL_BINDING_STATE,
  type BindingState, type ControlAction, type ControlBinding, type ControlMessage,
  type TransportCommand,
} from '../daw/model/control-surface.js';
import {
  applyControl, toControlMessage,
} from '../daw/edit/control-surface-actions.js';
import {
  clearBindings, describeImport, exportSurface, importSurface, listBindings,
  putBinding, removeBinding, setSurfaceDeviceId, setSurfaceEnabled, storedConflicts,
  surfaceDeviceId, surfaceEnabled, updateBinding,
} from '../daw/engine/control-surface-store.js';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import { nextId } from '../daw/model/ids.js';
import { useDawStore } from './dawStore.js';
import { useRecordingStore } from './recordingStore.js';
import { useAppStore } from './appStore.js';

/** How long after the last message a fader move counts as finished. */
const SETTLE_MS = 240;

interface SurfaceState {
  enabled: boolean;
  deviceId: string | null;
  bindings: ControlBinding[];
  /** Set while MIDI learn is waiting for a control to be moved. */
  learning: ControlAction | null;
  /** The last control that moved, for the panel's activity line. */
  lastSeen: { text: string; boundTo: string | null } | null;
  error: string | null;

  refresh: () => void;
  setEnabled: (enabled: boolean) => Promise<void>;
  setDeviceId: (deviceId: string | null) => Promise<void>;
  startLearn: (action: ControlAction) => void;
  cancelLearn: () => void;
  edit: (id: string, patch: Partial<ControlBinding>) => void;
  remove: (id: string) => void;
  clearAll: () => void;
  exportToFile: () => Promise<void>;
  importFromFile: () => Promise<void>;
}

/** Pickup and encoder state, per binding.  Not React state — it changes per message. */
const bindingStates = new Map<string, BindingState>();
let unsubscribe: (() => void) | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCommit(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = globalThis.setTimeout(() => {
    settleTimer = null;
    useDawStore.getState().commitEdit();
  }, SETTLE_MS);
}

function runTransport(command: TransportCommand): void {
  const daw = useDawStore.getState();
  switch (command) {
    case 'play':   daw.isPlaying ? daw.stop() : daw.play(); break;
    case 'stop':   daw.stop(); break;
    case 'rewind': daw.seek(0); break;
    case 'toggleLoop': daw.toggleLoop(); break;
    case 'record': {
      const recorder = useRecordingStore.getState();
      if (recorder.status === 'recording' || recorder.status === 'countIn') void recorder.stop();
      else void recorder.start();
      break;
    }
  }
}

export const useControlSurfaceStore = create<SurfaceState>((set, get) => ({
  enabled: false,
  deviceId: null,
  bindings: [],
  learning: null,
  lastSeen: null,
  error: null,

  refresh: () => set({
    enabled: surfaceEnabled(),
    deviceId: surfaceDeviceId(),
    bindings: listBindings(),
  }),

  setEnabled: async (enabled) => {
    setSurfaceEnabled(enabled);
    set({ enabled });
    if (!enabled) { stopListening(); set({ learning: null }); return; }
    await startListening(set);
  },

  setDeviceId: async (deviceId) => {
    setSurfaceDeviceId(deviceId);
    set({ deviceId });
    if (get().enabled) { stopListening(); await startListening(set); }
  },

  /**
   * Wait for one control to move, and bind it.
   *
   * Learning turns the surface on if it is off — someone pressing "learn" has
   * unambiguously said they want the desk connected.
   */
  startLearn: (action) => {
    set({ learning: action, error: null });
    if (!get().enabled) void get().setEnabled(true);
  },

  cancelLearn: () => set({ learning: null }),

  edit: (id, patch) => {
    const result = updateBinding(id, patch);
    if (!result.ok) { set({ error: result.reason }); return; }
    bindingStates.delete(id);
    get().refresh();
  },

  remove: (id) => {
    removeBinding(id);
    bindingStates.delete(id);
    get().refresh();
  },

  clearAll: () => {
    clearBindings();
    bindingStates.clear();
    get().refresh();
  },

  exportToFile: async () => {
    const api = globalThis.window?.electronAPI;
    if (!api) { set({ error: '파일 저장을 사용할 수 없습니다' }); return; }
    if (get().bindings.length === 0) { set({ error: '내보낼 매핑이 없습니다' }); return; }
    try {
      const dest = await api.invoke('daw:surface-export', exportSurface()) as string | null;
      if (dest) useAppStore.getState().notify(`매핑을 내보냈습니다 — ${dest}`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFromFile: async () => {
    const api = globalThis.window?.electronAPI;
    if (!api) { set({ error: '파일 열기를 사용할 수 없습니다' }); return; }
    try {
      const json = await api.invoke('daw:surface-import') as string | null;
      if (!json) return;
      const report = importSurface(json);
      get().refresh();
      bindingStates.clear();
      useAppStore.getState().notify(
        describeImport(report), report.added + report.replaced === 0 ? 'warning' : 'info');
      for (const reason of report.reasons.slice(0, 3)) {
        useAppStore.getState().notify(reason, 'warning');
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

// ── Listening ─────────────────────────────────────────────────────────────────

type SetState = (patch: Partial<SurfaceState>) => void;

function stopListening(): void {
  unsubscribe?.();
  unsubscribe = null;
  bindingStates.clear();
  dawRuntime.releaseMidiHold();
}

async function startListening(set: SetState): Promise<void> {
  const daw = useDawStore.getState();
  try {
    const open = await dawRuntime.holdMidiOpen(daw.session, surfaceDeviceId());
    if (!open) { set({ error: 'MIDI 입력 장치를 찾을 수 없습니다' }); return; }
  } catch (err) {
    set({ enabled: false, error: err instanceof Error ? err.message : String(err) });
    setSurfaceEnabled(false);
    return;
  }
  unsubscribe?.();
  unsubscribe = dawRuntime.addMidiListener((event) => {
    const message = toControlMessage(event);
    if (message) receive(message, set);
  });
  set({ error: null });
}

function receive(message: ControlMessage, set: SetState): void {
  const state = useControlSurfaceStore.getState();

  // Learn first: a control being learned is not also being played.
  const learning = state.learning;
  if (learning) {
    // A release is not a control moving — waiting for the press means a button
    // learns the moment it is pressed rather than when it comes back up.
    if (!message.pressed && message.kind === 'note') return;
    const source = sourceOf(message, true);
    const binding = createBinding(nextId('map'), source, learning, {
      mode: modeFor(message, learning),
      label: describeSource(source),
    });
    const result = putBinding(binding);
    set({ learning: null });
    if (!result.ok) { set({ error: result.reason }); return; }
    useControlSurfaceStore.getState().refresh();
    useAppStore.getState().notify(`${describeSource(source)} 에 연결했습니다`);
    return;
  }

  const binding = bindingForMessage(state.bindings, message);
  if (!binding) {
    // Still worth showing: "the desk is talking, nothing is listening" is
    // exactly what someone setting up a surface needs to see.
    set({ lastSeen: { text: describeMessage(message), boundTo: null } });
    return;
  }

  const before = bindingStates.get(binding.id) ?? INITIAL_BINDING_STATE;
  const session = useDawStore.getState().session;
  const outcome = applyControl(session, binding, message, before);
  bindingStates.set(binding.id, outcome.state);

  if (outcome.command) { runTransport(outcome.command); }
  else if (outcome.session !== session) {
    // Transient + a settle timer: one fader move is one undo step.
    useDawStore.getState().applyTransient(() => outcome.session);
    scheduleCommit();
  }

  set({
    lastSeen: {
      text: describeMessage(message),
      boundTo: outcome.ignored === 'pickup'
        ? `${binding.label || describeSource(binding.source)} — 픽업 대기`
        : binding.label || describeSource(binding.source),
    },
  });
}

function bindingForMessage(
  bindings: readonly ControlBinding[], message: ControlMessage,
): ControlBinding | undefined {
  // Same precedence rule the model states: a channel-pinned binding wins.
  let omni: ControlBinding | undefined;
  for (const binding of bindings) {
    const source = binding.source;
    if (source.channel !== null && source.channel !== message.channel) continue;
    const hit = source.kind === 'cc' ? message.kind === 'cc' && message.number === source.controller
      : source.kind === 'note' ? message.kind === 'note' && message.number === source.pitch
        : message.kind === 'pitchBend';
    if (!hit) continue;
    if (source.channel !== null) return binding;
    omni ??= binding;
  }
  return omni;
}

function describeMessage(message: ControlMessage): string {
  const channel = `ch${message.channel + 1}`;
  if (message.kind === 'cc') return `CC ${message.number} = ${message.raw} · ${channel}`;
  if (message.kind === 'note') return `노트 ${message.number} ${message.pressed ? '누름' : '뗌'} · ${channel}`;
  return `벤드 ${message.raw} · ${channel}`;
}

/** Conflicts as the panel shows them — two bindings on one physical control. */
export function surfaceConflicts(): ReturnType<typeof storedConflicts> {
  return storedConflicts();
}
