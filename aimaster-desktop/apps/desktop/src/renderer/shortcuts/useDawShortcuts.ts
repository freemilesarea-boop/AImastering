// useDawShortcuts — installs the global DAW keyboard layer.
//
// Mounted once, from App.  Owns:
//   • the single window-level keydown listener + dispatch,
//   • the store→deps wiring for the command map,
//   • the mastering-options undo recorder (coalesced so a slider drag is one
//     undo step),
//   • snap markers derived from the section analysis of the current master.

import { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import {
  useWorkspaceStore, getTransportElement, snapTime,
} from '../stores/workspaceStore.js';
import { resumeSharedContext } from '../audio/shared-audio-graph.js';
import { BINDINGS } from './definitions.js';
import { buildCommands, type CommandDeps, type DawBridge, type TransportApi } from './commands.js';
import { buildDawCommands, buildDawOverrides } from './daw-commands.js';
import { useDawStore } from '../stores/dawStore.js';
import { matchesChord, detectPlatform, type Platform } from './keys.js';

/** Typing surfaces where the DAW layer must stay out of the way. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/** True when the user has actually selected text on the page. */
function hasTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const sel = window.getSelection();
  return Boolean(sel && !sel.isCollapsed && sel.toString().trim().length > 0);
}

/** Space on a focused button belongs to the button, not to the transport. */
function isButtonTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'BUTTON' || target.getAttribute('role') === 'button';
}

const HISTORY_COALESCE_MS = 400;

export function useDawShortcuts(): void {
  const platformRef = useRef<Platform>(detectPlatform());

  // ── Command deps — read stores lazily so commands always see fresh state ──
  const deps = useMemo<CommandDeps>(() => {
    const transport: TransportApi = {
      hasElement: () => getTransportElement() !== null,
      toggle: () => {
        const el = getTransportElement();
        if (!el) return;
        if (el.paused) {
          // Resume the shared AudioContext inside the key gesture — the
          // preview graph is otherwise left suspended and silent.
          void resumeSharedContext();
          void el.play();
        } else {
          el.pause();
        }
      },
      pause: () => { getTransportElement()?.pause(); },
      seek: (sec) => {
        const el = getTransportElement();
        if (!el) return;
        const dur = Number.isFinite(el.duration) ? el.duration : 0;
        const target = snapTime(Math.max(0, dur > 0 ? Math.min(sec, dur) : sec));
        el.currentTime = target;
        useWorkspaceStore.getState().setTransportState({ positionSec: target });
      },
      position: () => getTransportElement()?.currentTime ?? useWorkspaceStore.getState().positionSec,
      duration: () => {
        const el = getTransportElement();
        const d = el && Number.isFinite(el.duration) ? el.duration : 0;
        return d || useWorkspaceStore.getState().durationSec;
      },
      isMuted: () => getTransportElement()?.muted ?? useWorkspaceStore.getState().muted,
      setMuted: (v) => {
        const el = getTransportElement();
        if (el) el.muted = v;
      },
    };

    return {
      notify: (message, type) => useAppStore.getState().notify(message, type),
      setPage: (page) => useAppStore.getState().setPage(page),
      getAudio: () => {
        const s = useAudioStore.getState();
        return {
          selectedFile:      s.selectedFile,
          masteringResult:   s.masteringResult,
          options:           s.options,
          referenceFilePath: s.referenceFilePath,
        };
      },
      audio: {
        reset:            () => useAudioStore.getState().reset(),
        setFile:          (p) => useAudioStore.getState().setFile(p),
        addFilesToQueue:  (paths) => useAudioStore.getState().addFilesToQueue(paths),
        updateOptions:    (patch) => useAudioStore.getState().updateOptions(patch),
        setReferenceFile: (p) => useAudioStore.getState().setReferenceFile(p),
        setShowAdvanced:  (v) => useAudioStore.getState().setShowAdvanced(v),
        addRevision:      (input) => useAudioStore.getState().addRevision(input),
      },
      workspace: () => useWorkspaceStore.getState(),
      transport,
      invoke: (channel, ...args) => {
        const api = window.electronAPI;
        if (!api) return Promise.reject(new Error('electronAPI unavailable'));
        return api.invoke(channel as Parameters<typeof api.invoke>[0], ...args);
      },
    };
  }, []);

  // The DAW workspace owns a second meaning for some keys; the bridge picks
  // whichever matches the page that is actually on screen.
  const dawBridge = useMemo<DawBridge>(() => {
    const dawDeps = {
      notify: deps.notify,
      openWorkspace: () => useAppStore.getState().setPage('daw'),
      daw: () => useDawStore.getState(),
      invoke: deps.invoke,
    };
    return {
      isActive: () => useAppStore.getState().currentPage === 'daw',
      commands: buildDawCommands(dawDeps),
      overrides: buildDawOverrides(dawDeps),
    };
  }, [deps]);

  const commands = useMemo(() => buildCommands(deps, dawBridge), [deps, dawBridge]);

  // ── Keydown dispatch ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const typing = isTypingTarget(e.target);

      // Escape closes the transient overlays even while typing.
      if (e.key === 'Escape') {
        const ws = useWorkspaceStore.getState();
        if (ws.panels.help || ws.panels.mediaBay) {
          ws.setPanel('help', false);
          ws.setPanel('mediaBay', false);
          e.preventDefault();
        }
        return;
      }
      if (typing) return;

      const platform = platformRef.current;
      for (const { def, chord } of BINDINGS) {
        if (!matchesChord(e, chord, platform)) continue;
        // Let a focused button keep Space/Enter for activation.
        if ((chord.code === 'Space' || chord.code === 'Enter') && isButtonTarget(e.target)) return;
        // Copying selected text (a path, a metric) must stay possible —
        // only an empty selection means "copy the mastering settings".
        if (def.id === 'edit.copy' && hasTextSelection()) return;
        e.preventDefault();
        e.stopPropagation();
        const run = commands[def.id];
        try {
          const result = run();
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err: unknown) => {
              // eslint-disable-next-line no-console
              console.error(`[shortcuts] ${def.id} failed:`, err);
              useAppStore.getState().notify('단축키 실행 중 오류가 발생했습니다', 'error');
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[shortcuts] ${def.id} failed:`, err);
        }
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [commands]);

  // ── Undo history recorder ───────────────────────────────────────────────
  useEffect(() => {
    const ws = useWorkspaceStore.getState();
    if (!ws.history) ws.resetOptionsHistory(useAudioStore.getState().options);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastOptions = useAudioStore.getState().options;

    const unsub = useAudioStore.subscribe((state) => {
      if (state.options === lastOptions) return;
      lastOptions = state.options;
      if (useWorkspaceStore.getState().applyingHistory) {
        useWorkspaceStore.getState().endApplyHistory();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        useWorkspaceStore.getState().recordOptions(useAudioStore.getState().options);
      }, HISTORY_COALESCE_MS);
    });

    return () => { if (timer) clearTimeout(timer); unsub(); };
  }, []);

  // ── Snap markers + loop reset follow the loaded file ────────────────────
  const selectedFile    = useAudioStore((s) => s.selectedFile);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  useEffect(() => {
    const ws = useWorkspaceStore.getState();
    ws.setLoop({ startSec: 0, endSec: 0 });
    ws.setLoopEnabled(false);
    ws.setSelection(null);
    ws.resetZoom();
  }, [selectedFile]);

  useEffect(() => {
    const sections = masteringResult?.sectionAnalysis?.sections ?? [];
    const marks = new Set<number>();
    for (const s of sections) { marks.add(s.start); marks.add(s.end); }
    useWorkspaceStore.getState().setSnapMarkers([...marks]);
  }, [masteringResult]);
}
