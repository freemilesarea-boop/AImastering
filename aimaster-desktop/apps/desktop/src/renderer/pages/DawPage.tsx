/**
 * DawPage — the workspace, laid out like a DAW.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ transport · timecode · zoom · master bus · 합산                   │  toolbar
 *   ├───────────────┬──────────────────────────────────────┬───────────┤
 *   │ INSPECTOR     │ ruler                                │  RACK     │
 *   │ selected      ├──────────┬───────────────────────────┤  modules  │
 *   │ track         │ headers  │ arrange lanes (waveforms) │  on the   │
 *   │               │          │                           │  selected │
 *   │               │          │                           │  track    │
 *   ├───────────────┴──────────┴───────────────────────────┴───────────┤
 *   │ MIXCONSOLE — one vertical strip per track, plus the master        │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The layout is not decoration. An engineer works by looking at the arrange
 * window and reaching for the console without moving their eyes, so both are
 * on screen at once and the console is at the bottom where a console is.
 * The inspector shows the selected track because that is the one question
 * the arrange window cannot answer by itself.
 *
 * What is real and what is not, stated plainly rather than implied:
 *
 *   • The waveforms are the real decoded audio, the faders and pan are the
 *     real mixer, the inserts are the real per-stem chains, and the master
 *     bus is the app's own mastering. Playback is the baked preview.
 *   • There is no timeline EDITING — no clip trimming, no moving parts in
 *     time, no recording, no MIDI. Stems arrive aligned at zero, so a
 *     timeline is a viewport here, not an editor. The ruler and the playhead
 *     are real; dragging a clip does nothing because there is nothing yet
 *     for it to do.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import {
  useStemStore, audibleFlags, pendingCount,
  type StemTrackState,
} from '../stores/stemStore.js';
import { STEM_ROLES, STEM_CHAIN, type StemRole } from '../audio/presets/stem-defaults.js';
import { masterBusChoices, masterWireFor } from '../audio/presets/stem-master.js';
import { ensureStemChain, resetStemChain, hasStemChain, resolveStemWire } from '../audio/presets/stem-studio.js';
import { StemPreviewEngine, type PreviewStatus, type PreviewStemInput } from '../audio/stem-preview-engine.js';
import TrackWaveform, { type PeakData } from '../components/daw/TrackWaveform.js';
import TrackHeader from '../components/daw/TrackHeader.js';
import MixerStrip from '../components/daw/MixerStrip.js';
import { trackColor, roleLabel } from '../components/daw/TrackColors.js';
import InsertRack, {
  startingValues, moduleLabel, type InsertState,
} from '../components/daw/InsertRack.js';
import { TrackPluginEditor } from '../components/daw/TrackPluginEditor.js';
import { MODULE_IDS, type ModuleId, type ParameterValue } from '../audio/parameters/parameter-state.js';
import { saveSongSettings } from '../audio/session/song-settings.js';
import type { FreeEqBand } from '../audio/modules/eq-graph-model.js';
import {
  subscribeTrackMetrics, getTrackMetricsMap, getTrackMetricsServer, EMPTY_METRICS,
} from '../audio/track-metrics-store.js';
import { usePaneSizes } from '../components/daw/usePaneSizes.js';

const LANE_HEIGHT = 68;
const HEADER_WIDTH = 208;

/**
 * Absolute paths for the files in a drop.
 *
 * Electron exposes the real filesystem path on `File`, which a browser does
 * not — and the whole app addresses audio by absolute path, so a drop that
 * only produced a `File` object could not be analysed, rendered or exported.
 * A file without one is skipped rather than added as a track that can never
 * do anything.
 */
function droppedPaths(list: FileList | null): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = (list[i] as File & { path?: string }).path;
    if (typeof p === 'string' && p.length > 0) out.push(p);
  }
  return out;
}

function baseConfig(): Record<string, unknown> {
  return {
    inputGainDb: 0,
    eqLowCutHz: 20, eqLowShelfDb: 0, eqPresenceDb: 0, eqAirDb: 0,
    eqAdaptive: false, eqBypass: true,
    dynThresholdDb: 0, dynRatio: 1, dynAttackMs: 10, dynReleaseMs: 120,
    dynMixPct: 100, dynBypass: true,
    imgWidthPct: 100, imgLowMonoHz: 20, imgBypass: true,
    limCeilingDbtp: 0, limLookaheadMs: 1, limIsp: false, limBypass: true,
    outputGainDb: 0, masterBypass: false,
  };
}

function timecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Module names engaged on a role's chain, for the console's insert slots. */
function insertsFor(role: StemRole): string[] {
  const preset = STEM_CHAIN[role];
  const names: string[] = [];
  if (preset.eqBands.length > 0) names.push('EQ');
  if (preset.modules.dynamics) names.push('Compressor');
  if (preset.modules.deess) names.push('De-esser');
  if (preset.modules.impact) names.push('Transient');
  if (preset.modules['low-end-focus']) names.push('Low Focus');
  if (preset.modules.imager) names.push('Imager');
  return names;
}


/**
 * The plugins a track starts with, taken from its instrument's chain.
 *
 * The rack is seeded rather than started empty so the chain the classifier
 * chose is visible as plugins the moment the user looks at it — opening the
 * inserts on a kick and finding nothing would suggest the kick chain does
 * not exist, when it does.
 */
function seedInserts(role: StemRole): ModuleId[] {
  const preset = STEM_CHAIN[role];
  const ids = Object.keys(preset.modules) as ModuleId[];
  if (preset.eqBands.length > 0) ids.push('parametric-eq');
  return ids.filter((id) => MODULE_IDS.includes(id));
}

/** Read a track's rack out of its saved chain. */
function readInserts(filePath: string, role: StemRole, ids: ModuleId[]): InsertState[] {
  const saved = ensureStemChain(filePath, role);
  return ids.map((id) => ({
    id,
    bypass: saved.state[id]?.bypass ?? true,
    parameters: saved.state[id]?.parameters ?? {},
  }));
}

/** Write one module's bypass and parameters back into a track's saved chain. */
function writeInsert(
  filePath: string,
  role: StemRole,
  id: ModuleId,
  patch: { bypass?: boolean; parameters?: Record<string, ParameterValue> },
): void {
  const saved = ensureStemChain(filePath, role);
  saveSongSettings({
    ...saved,
    state: {
      ...saved.state,
      [id]: {
        ...saved.state[id],
        ...(patch.bypass !== undefined ? { bypass: patch.bypass } : {}),
        parameters: { ...saved.state[id].parameters, ...(patch.parameters ?? {}) },
      },
    },
  });
}

/** A track's free-EQ bands, as saved. */
function readFreeBands(filePath: string, role: StemRole): FreeEqBand[] {
  return ensureStemChain(filePath, role).freeBands;
}

/**
 * Replace a track's free-EQ bands.
 *
 * Separate from `writeInsert` because the bands are not parameters: the
 * parametric EQ's shape is a list whose length the user controls, and
 * folding it into the module's parameter map would mean inventing sixteen
 * sets of frequency/gain/Q fields that the engine does not have.
 */
function writeFreeBands(filePath: string, role: StemRole, bands: FreeEqBand[]): void {
  const saved = ensureStemChain(filePath, role);
  saveSongSettings({ ...saved, freeBands: bands });
}

// ── Ruler ────────────────────────────────────────────────────────────────────

function Ruler({ duration, zoom, scroll, playhead, onSeek }: {
  duration: number;
  zoom: number;
  scroll: number;
  playhead: number;
  onSeek: (sec: number) => void;
}): React.ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const visible = 1 / Math.max(1, zoom);
  const from = Math.max(0, Math.min(1 - visible, scroll));

  // Tick spacing that stays readable at every zoom: pick the coarsest
  // interval that still puts a label roughly every 90 px.
  const spanSec = Math.max(0.001, duration * visible);
  const CANDIDATES = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = CANDIDATES.find((c) => (c / spanSec) * 800 >= 90) ?? 600;

  const ticks: number[] = [];
  const startSec = from * duration;
  for (let t = Math.ceil(startSec / step) * step; t <= startSec + spanSec; t += step) ticks.push(t);

  return (
    <div
      ref={boxRef}
      onClick={(e) => {
        const box = boxRef.current;
        if (!box || duration <= 0) return;
        const x = (e.clientX - box.getBoundingClientRect().left) / box.clientWidth;
        onSeek((from + x * visible) * duration);
      }}
      className="relative h-6 border-b border-black/60 bg-zinc-950/80 cursor-pointer select-none"
    >
      {ticks.map((t) => {
        const frac = (t / Math.max(duration, 0.001) - from) / visible;
        return (
          <div key={t} className="absolute top-0 bottom-0" style={{ left: `${frac * 100}%` }}>
            <div className="w-px h-full bg-zinc-800" />
            <span className="absolute left-1 top-0.5 text-[9px] font-mono text-zinc-600 whitespace-nowrap">
              {timecode(t)}
            </span>
          </div>
        );
      })}
      {duration > 0 && (
        <div
          className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
          style={{ left: `${((playhead / duration - from) / visible) * 100}%` }}
        />
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DawPage(): React.ReactElement {
  const setPage = useAppStore((s) => s.setPage);
  const notify = useAppStore((s) => s.notify);
  const setStudioReturnTo = useAppStore((s) => s.setStudioReturnTo);
  const setFile = useAudioStore((s) => s.setFile);

  const {
    tracks, rendering, lastReport, lastOutputPath, renderError,
    masterPresetId, masterTargetLufs,
    addFiles, clear, analyzePending, setRole, setGain, setPan,
    toggleMute, toggleSolo, remove, setRendering, setRenderResult,
    setMasterPreset, setMasterTargetLufs, setInserts,
  } = useStemStore();

  const { sizes, startDrag, dragging } = usePaneSizes();
  const [dropActive, setDropActive] = useState(false);
  const [openInsert, setOpenInsert] = useState<ModuleId | null>(null);
  /** Bumped whenever a track's saved chain changes, to re-read the rack. */
  const [rackTick, setRackTick] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0);
  const [peaks, setPeaks] = useState<Map<string, PeakData>>(new Map());
  const [customTick, setCustomTick] = useState(0);

  const audible = useMemo(() => audibleFlags(tracks), [tracks]);
  const pending = pendingCount(tracks);
  const selected = tracks.find((t) => t.id === selectedId) ?? tracks[0] ?? null;
  const masterChoices = useMemo(() => masterBusChoices(), []);
  const activeMaster = masterChoices.find((c) => c.id === masterPresetId) ?? null;

  const custom = useMemo(
    () => new Set(tracks.filter((t) => hasStemChain(t.filePath)).map((t) => t.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks, customTick],
  );

  const rackIds: ModuleId[] = useMemo(
    () => (selected ? (selected.inserts ?? seedInserts(selected.role)) : []),
    [selected],
  );
  const rack: InsertState[] = useMemo(
    () => (selected ? readInserts(selected.filePath, selected.role, rackIds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, rackIds, rackTick],
  );
  const openModule = rack.find((i) => i.id === openInsert) ?? null;

  const addPlugin = useCallback((id: ModuleId) => {
    if (!selected) return;
    const start = startingValues(id);
    writeInsert(selected.filePath, selected.role, id, start);
    setInserts(selected.id, [...rackIds.filter((m) => m !== id), id]);
    setRackTick((n) => n + 1);
  }, [selected, rackIds, setInserts]);

  const removePlugin = useCallback((id: ModuleId) => {
    if (!selected) return;
    // Bypassed as well as delisted: the saved chain keeps a flag for every
    // module, and leaving it engaged would keep processing a plugin the
    // rack no longer shows.
    writeInsert(selected.filePath, selected.role, id, { bypass: true });
    setInserts(selected.id, rackIds.filter((m) => m !== id));
    if (openInsert === id) setOpenInsert(null);
    setRackTick((n) => n + 1);
  }, [selected, rackIds, openInsert, setInserts]);

  const togglePlugin = useCallback((id: ModuleId) => {
    if (!selected) return;
    const current = rack.find((i) => i.id === id);
    writeInsert(selected.filePath, selected.role, id, { bypass: !(current?.bypass ?? true) });
    setRackTick((n) => n + 1);
  }, [selected, rack]);

  /**
   * Write one module's parameters.
   *
   * Takes a patch rather than a single id because a drag on a curve moves
   * two or three axes in the same gesture, and writing them one at a time
   * would have each save read a copy of the settings from before the last.
   */
  const editParameters = useCallback((moduleId: ModuleId, patch: Record<string, ParameterValue>) => {
    if (!selected) return;
    writeInsert(selected.filePath, selected.role, moduleId, { parameters: patch });
    setRackTick((n) => n + 1);
  }, [selected]);

  const editFreeBands = useCallback((bands: FreeEqBand[]) => {
    if (!selected) return;
    writeFreeBands(selected.filePath, selected.role, bands);
    setRackTick((n) => n + 1);
  }, [selected]);

  const freeBands = useMemo(
    () => (selected ? readFreeBands(selected.filePath, selected.role) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, rackTick],
  );

  // ── Analysis ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (pending > 0 && !rendering) void analyzePending();
  }, [pending, rendering, analyzePending]);

  // ── Waveforms ────────────────────────────────────────────────────────────
  // Fetched per track as it appears, so the arrange window fills in rather
  // than staying empty until the slowest file is decoded.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    void (async () => {
      for (const t of tracks) {
        if (peaks.has(t.filePath)) continue;
        const res = await api.invoke('stem:peaks', t.filePath) as
          { ok: boolean; count?: number; min?: number[]; max?: number[]; rms?: number[]; durationSec?: number };
        if (cancelled) return;
        if (res.ok && res.min && res.max && res.rms) {
          setPeaks((prev) => new Map(prev).set(t.filePath, {
            count: res.count ?? res.min!.length,
            min: res.min!, max: res.max!, rms: res.rms!,
            durationSec: res.durationSec ?? 0,
          }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  const duration = useMemo(
    () => tracks.reduce((max, t) => Math.max(max, peaks.get(t.filePath)?.durationSec ?? 0), 0),
    [tracks, peaks],
  );

  // ── Preview ──────────────────────────────────────────────────────────────
  const engineRef = useRef<StemPreviewEngine | null>(null);
  const [status, setStatus] = useState<PreviewStatus>({
    state: 'idle', position: 0, duration: 0, memoryBytes: 0,
    liveChains: 0, chainsDegraded: null, error: null,
  });
  const [preparing, setPreparing] = useState<{ done: number; total: number; name: string } | null>(null);
  /**
   * Whether the plugins run in the audio thread.
   *
   * Remembered across restarts, because the reason to turn it off is that
   * it broke something — and having to find the switch again after every
   * relaunch would make the escape hatch useless.
   */
  const [liveChains, setLiveChainsPref] = useState(() => {
    try { return localStorage.getItem('loui.daw.liveChains') !== 'off'; } catch { return true; }
  });
  const [baked, setBaked] = useState<Map<string, { path: string; channels: 1 | 2; samples: number }>>(new Map());

  useEffect(() => {
    const engine = new StemPreviewEngine();
    // Read from storage rather than from `liveChains`: this effect runs once
    // and must not be re-run when the preference changes (that would rebuild
    // the whole engine), so closing over the state would leave a stale value
    // with no way to tell.
    let wanted = true;
    try { wanted = localStorage.getItem('loui.daw.liveChains') !== 'off'; } catch { /* default on */ }
    engine.setLiveChains(wanted);
    engineRef.current = engine;
    const off = engine.subscribe(setStatus);
    return () => { off(); engine.dispose(); engineRef.current = null; };
  }, []);

  useEffect(() => {
    if (status.state !== 'playing') return;
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (e) setStatus(e.status());
    }, 100);
    return () => window.clearInterval(id);
  }, [status.state]);

  /**
   * The selected track's chain telemetry.
   *
   * `useSyncExternalStore` rather than an effect: the store publishes on its
   * own timer at 10 Hz and never on message arrival, so this cannot become
   * the audio-rate render loop that once killed the renderer.
   */
  const metricsMap = useSyncExternalStore(
    subscribeTrackMetrics, getTrackMetricsMap, getTrackMetricsServer,
  );
  const selectedMetrics = selected ? (metricsMap.get(selected.id) ?? EMPTY_METRICS) : EMPTY_METRICS;
  /**
   * The post-plugin spectrum tap, re-read whenever the graph is rebuilt.
   *
   * `status.state` is the signal: the engine replaces its analysers when it
   * loads or when live chains are toggled, and both of those move the
   * transport state.
   */
  const selectedAnalyser = useMemo(
    () => (selected ? engineRef.current?.analyserFor(selected.id) ?? null : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, status.state, liveChains],
  );

  // What a re-bake actually depends on: which files are in the session. The
  // chains are applied live, so a plugin edit or a role change costs nothing
  // and must not put a "re-bake" prompt on screen.
  const fileSignature = useMemo(
    () => tracks.map((t) => `${t.id}:${t.filePath}`).join('|'),
    [tracks],
  );
  const bakedSignature = useRef('');
  const stale = baked.size > 0 && bakedSignature.current !== fileSignature;

  const handlePrepare = useCallback(async () => {
    const api = window.electronAPI;
    const engine = engineRef.current;
    if (!api || !engine || tracks.length === 0) return;
    setPreparing({ done: 0, total: tracks.length, name: tracks[0]?.name ?? '' });
    try {
      const next = new Map<string, { path: string; channels: 1 | 2; samples: number }>();
      const failures: string[] = [];
      for (const [i, t] of tracks.entries()) {
        setPreparing({ done: i, total: tracks.length, name: t.name });
        const res = await api.invoke('stem:preview-render', {
          filePath: t.filePath,
          // No chain: the plugins run live in the audio thread now, so the
          // decoded buffer must be the raw stem. This is also what makes the
          // bake stable — adding a compressor no longer re-renders anything.
          config: null,
          sampleRate: 48000,
        }) as { ok: boolean; error?: string; previewPath?: string; channels?: 1 | 2; samples?: number };
        if (res.ok && res.previewPath) {
          next.set(t.id, { path: res.previewPath, channels: res.channels ?? 2, samples: res.samples ?? 0 });
        } else failures.push(`${t.name}: ${res.error ?? '알 수 없는 오류'}`);
      }
      setBaked(next);
      bakedSignature.current = fileSignature;
      if (failures.length > 0) notify(`미리듣기 준비 실패 ${failures.length}개 — ${failures[0]}`, 'warning');

      const inputs: PreviewStemInput[] = tracks.filter((t) => next.has(t.id)).map((t) => ({
        id: t.id,
        previewPath: next.get(t.id)!.path,
        channels: next.get(t.id)!.channels,
        samples: next.get(t.id)!.samples,
        gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo,
        config: resolveStemWire(t.filePath, t.role),
      }));
      await engine.load(inputs);
      // The user pressed play. Baking is the step in between, not the
      // answer — finishing it silently and waiting for a second click is
      // how a transport button feels broken.
      if (engine.status().state === 'ready') engine.play();
    } finally {
      setPreparing(null);
    }
  }, [tracks, fileSignature, notify]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || baked.size === 0) return;
    engine.update(tracks.filter((t) => baked.has(t.id)).map((t) => ({
      id: t.id,
      previewPath: baked.get(t.id)!.path,
      channels: baked.get(t.id)!.channels,
      samples: baked.get(t.id)!.samples,
      gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo,
      config: resolveStemWire(t.filePath, t.role),
    })));
    // `rackTick` is the dependency that carries a plugin edit: the saved
    // chain changed on disk, not in `tracks`, so without it a knob move
    // would be inaudible until something else re-rendered the page.
  }, [tracks, baked, rackTick]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleAdd = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const paths = await api.invoke('file:open-dialog-multi') as string[] | null;
    if (paths && paths.length > 0) addFiles(paths);
  }, [addFiles]);

  const openInStudio = useCallback((t: StemTrackState) => {
    ensureStemChain(t.filePath, t.role);
    setFile(t.filePath);
    setStudioReturnTo('daw');
    setPage('studio');
  }, [setFile, setStudioReturnTo, setPage]);

  const handleRender = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || tracks.length === 0) return;
    setRendering(true);
    try {
      const master = masterPresetId ? masterWireFor(masterPresetId, masterTargetLufs ?? undefined) : null;
      const res = await api.invoke('stem:render', {
        tracks: tracks.map((t) => ({
          filePath: t.filePath, gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo,
          config: { ...baseConfig(), suiteConfig: resolveStemWire(t.filePath, t.role) },
        })),
        master: master ? { ...baseConfig(), limCeilingDbtp: master.ceilingDbtp, suiteConfig: master.wire } : null,
        ...(master ? { masterTarget: { targetLufs: master.targetLufs } } : {}),
        sampleRate: 48000, bitDepth: 24,
      }) as {
        ok: boolean; error?: string; outputPath?: string;
        report?: import('../stores/stemStore.js').StemRenderReport;
      };
      if (res.ok && res.outputPath) setRenderResult(res.outputPath, res.report ?? null, null);
      else setRenderResult(null, null, res.error ?? '합산에 실패했습니다.');
    } catch (err) {
      setRenderResult(null, null, (err as Error).message);
    }
  }, [tracks, masterPresetId, masterTargetLufs, setRendering, setRenderResult]);

  const playing = status.state === 'playing';
  const bridgeMissing = typeof window !== 'undefined' && !window.electronAPI;
  const canPlay = status.state === 'ready' || playing;
  const playFrac = duration > 0 ? Math.min(1, status.position / duration) : 0;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="h-full flex flex-col bg-zinc-950 text-zinc-300 overflow-hidden select-none relative"
      onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropActive(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        const paths = droppedPaths(e.dataTransfer?.files ?? null);
        if (paths.length > 0) addFiles(paths);
        else notify('이 항목에서는 파일 경로를 읽지 못했습니다 — 파인더에서 직접 끌어다 놓아 주세요.', 'warning');
      }}
      style={dragging ? { cursor: dragging === 'console' ? 'ns-resize' : 'ew-resize' } : undefined}
    >
      {dropActive && (
        <div className="absolute inset-0 z-30 pointer-events-none border-2 border-dashed border-zinc-400/70
                        bg-zinc-100/5 flex items-center justify-center">
          <span className="text-[13px] text-zinc-200 bg-zinc-900/90 px-4 py-2 rounded">
            놓으면 트랙으로 추가합니다
          </span>
        </div>
      )}

      {bridgeMissing && (
        <div className="shrink-0 px-3 py-1.5 bg-red-950/70 border-b border-red-900 text-[11px] text-red-300">
          앱 브릿지에 연결되지 않았습니다 — 분석·재생·믹스다운이 모두 동작하지 않습니다. 앱을 다시 시작해 주세요.
        </div>
      )}
      {status.error && (
        <div className="shrink-0 px-3 py-1.5 bg-amber-950/60 border-b border-amber-900/70 text-[11px] text-amber-300">
          {status.error}
        </div>
      )}
      {status.chainsDegraded && (
        <div className="shrink-0 px-3 py-1.5 bg-amber-950/60 border-b border-amber-900/70 text-[11px] text-amber-300">
          {status.chainsDegraded}
        </div>
      )}

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="drag-region shrink-0 h-11 flex items-center gap-2 px-3 border-b border-black/60 bg-zinc-900/70">
        <span className="font-semibold text-[11px] tracking-wide text-zinc-400 no-drag">LOUVER</span>
        <span className="text-zinc-700">/</span>
        <span className="text-[11px] text-zinc-500 no-drag">
          {tracks.length > 0 ? `${tracks.length} TRACKS` : 'NO SESSION'}
        </span>

        <div className="w-4" />

        {/* Transport */}
        <div className="no-drag flex items-center gap-1">
          <button
            onClick={() => (playing ? engineRef.current?.pause() : canPlay ? engineRef.current?.play() : void handlePrepare())}
            disabled={preparing !== null || status.state === 'loading' || tracks.length === 0}
            className="w-9 h-7 rounded-sm border border-zinc-700 bg-zinc-800/80 hover:border-zinc-500
                       disabled:opacity-30 flex items-center justify-center transition-colors"
            title={canPlay ? (playing ? '일시정지' : '재생') : '미리듣기 준비'}
          >
            {playing
              ? <span className="block w-2.5 h-2.5 border-x-[3px] border-zinc-200" />
              : <span className="block w-0 h-0 border-y-[6px] border-y-transparent border-l-[9px] border-l-zinc-200 ml-0.5" />}
          </button>
          <button
            onClick={() => engineRef.current?.stop()}
            disabled={!canPlay}
            className="w-9 h-7 rounded-sm border border-zinc-700 bg-zinc-800/80 hover:border-zinc-500
                       disabled:opacity-30 flex items-center justify-center transition-colors"
            title="정지"
          >
            <span className="block w-2.5 h-2.5 bg-zinc-200" />
          </button>
        </div>

        {/* Timecode — a DAW's clock, in the DAW's font. */}
        <div className="no-drag ml-1 px-3 py-1 rounded-sm bg-black/60 border border-black">
          <span className="font-mono text-[13px] text-emerald-400 tabular-nums tracking-wider">
            {timecode(status.position)}
          </span>
          <span className="font-mono text-[10px] text-zinc-600 tabular-nums ml-2">
            / {timecode(duration)}
          </span>
        </div>

        {preparing && (
          <span className="no-drag text-[10px] text-amber-400 tabular-nums">
            굽는 중 {preparing.done + 1}/{preparing.total} · {preparing.name}
          </span>
        )}
        {!preparing && status.state === 'loading' && (
          <span className="no-drag text-[10px] text-amber-400">불러오는 중…</span>
        )}
        {stale && canPlay && (
          <button
            onClick={() => void handlePrepare()}
            className="no-drag text-[10px] px-2 py-1 rounded-sm border border-amber-500/40 text-amber-300"
            title="체인이 바뀌었습니다"
          >다시 굽기</button>
        )}

        {/* Live plugins. The audio thread is the one place a fault takes the
            whole window with it, so the way out is on the toolbar rather
            than buried in settings. */}
        <button
          onClick={() => {
            const next = !liveChains;
            setLiveChainsPref(next);
            try { localStorage.setItem('loui.daw.liveChains', next ? 'on' : 'off'); } catch { /* not fatal */ }
            engineRef.current?.setLiveChains(next);
          }}
          className={`no-drag text-[10px] px-2 py-1 rounded-sm border transition-colors ${
            liveChains
              ? 'border-emerald-600/60 text-emerald-400'
              : 'border-zinc-700 text-zinc-500'}`}
          title={liveChains
            ? '플러그인이 실시간으로 걸립니다 — 노브를 돌리면 바로 들립니다. 문제가 생기면 꺼서 원본으로 들을 수 있습니다.'
            : '플러그인이 미리듣기에 걸리지 않습니다 — 페이더·팬·솔로만 동작합니다. 믹스다운에는 정상 적용됩니다.'}
        >
          {liveChains ? '실시간 플러그인 ON' : '실시간 플러그인 OFF'}
        </button>

        {/* Zoom */}
        <div className="no-drag ml-2 flex items-center gap-1">
          <button
            onClick={() => setZoom((z) => Math.max(1, z / 1.6))}
            className="w-6 h-6 rounded-sm border border-zinc-700 text-zinc-500 hover:text-zinc-200 text-xs"
          >−</button>
          <button
            onClick={() => setZoom((z) => Math.min(64, z * 1.6))}
            className="w-6 h-6 rounded-sm border border-zinc-700 text-zinc-500 hover:text-zinc-200 text-xs"
          >+</button>
          <span className="text-[9px] font-mono text-zinc-600 w-8">{zoom.toFixed(1)}×</span>
        </div>

        <div className="flex-1" />

        <div className="no-drag flex items-center gap-2">
          <button onClick={() => void handleAdd()}
            className="text-[11px] px-2.5 py-1 rounded-sm border border-zinc-700 hover:border-zinc-500 transition-colors">
            트랙 추가
          </button>
          <button onClick={() => void handleRender()}
            disabled={rendering || tracks.length === 0 || pending > 0}
            className="text-[11px] px-3 py-1 rounded-sm bg-zinc-100 text-zinc-900 font-medium
                       hover:bg-white disabled:opacity-30 transition-colors">
            {rendering ? '합산 중…' : '믹스다운'}
          </button>
          <button onClick={() => setPage('home')}
            className="text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors">홈</button>
        </div>
      </div>

      {/* ── Middle: inspector | arrange | rack ────────────────────────── */}
      <div className="flex-1 flex min-h-0">

        {/* Inspector */}
        <div
          className="shrink-0 border-r border-black/60 bg-zinc-900/40 overflow-y-auto"
          style={{ width: sizes.inspector }}
        >
          <div className="px-3 py-2 border-b border-black/40">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">Inspector</div>
          </div>
          {!selected ? (
            <p className="px-3 py-3 text-[10px] text-zinc-600 leading-relaxed">
              트랙을 선택하면 여기에 세부 정보가 나옵니다.
            </p>
          ) : (
            <div className="px-3 py-3 space-y-3">
              <div>
                <div className="text-[11px] text-zinc-200 truncate">{selected.name}</div>
                <div className="text-[9px] text-zinc-600 truncate">{selected.filePath}</div>
              </div>

              <label className="block">
                <span className="text-[9px] uppercase tracking-widest text-zinc-600">Instrument</span>
                <select
                  value={selected.role}
                  onChange={(e) => setRole(selected.id, e.target.value as StemRole)}
                  className="mt-1 w-full text-[11px] bg-zinc-950 border border-zinc-700 rounded-sm px-1.5 py-1
                             focus:outline-none focus:border-zinc-500"
                >
                  {STEM_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </label>

              <InsertRack
                inserts={rack}
                openId={openInsert}
                onOpen={setOpenInsert}
                onAdd={addPlugin}
                onRemove={removePlugin}
                onToggleBypass={togglePlugin}
              />

              <button
                onClick={() => openInStudio(selected)}
                className="w-full text-[10px] py-1 rounded-sm border border-zinc-800 text-zinc-600
                           hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                title="같은 체인을 큰 화면(그래프 포함)에서 편집합니다"
              >
                큰 화면에서 편집
              </button>

              {custom.has(selected.id) && (
                <button
                  onClick={() => {
                    resetStemChain(selected.filePath, selected.role);
                    setInserts(selected.id, seedInserts(selected.role));
                    setOpenInsert(null);
                    setCustomTick((n) => n + 1);
                    setRackTick((n) => n + 1);
                  }}
                  className="w-full text-[10px] py-1 rounded-sm border border-zinc-800 text-zinc-600
                             hover:text-amber-400 transition-colors"
                >
                  악기 기본값으로 초기화
                </button>
              )}

              <div>
                <div className="text-[9px] uppercase tracking-widest text-zinc-600 mb-1">Why</div>
                <p className={`text-[10px] leading-snug ${selected.warning ? 'text-amber-400/90' : 'text-zinc-500'}`}>
                  {selected.warning ?? selected.error ?? selected.why}
                </p>
              </div>
            </div>
          )}
        </div>

        <div
          onPointerDown={(e) => startDrag('inspector', e)}
          className="w-1 shrink-0 cursor-ew-resize hover:bg-zinc-600/60 transition-colors"
          title="드래그해서 인스펙터 너비를 조절합니다"
        />

        {/* Arrange */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex shrink-0">
            <div className="shrink-0 border-r border-black/60 bg-zinc-950/80" style={{ width: HEADER_WIDTH }}>
              <div className="h-6 flex items-center px-2 border-b border-black/60">
                <span className="text-[9px] uppercase tracking-widest text-zinc-600">Tracks</span>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <Ruler
                duration={duration}
                zoom={zoom}
                scroll={scroll}
                playhead={status.position}
                onSeek={(sec) => engineRef.current?.seek(sec)}
              />
            </div>
          </div>

          <div className="flex-1 flex min-h-0 overflow-y-auto">
            <div className="shrink-0 border-r border-black/60" style={{ width: HEADER_WIDTH }}>
              {tracks.map((t, i) => (
                <TrackHeader
                  key={t.id}
                  name={t.name}
                  role={roleLabel(t.role)}
                  color={trackColor(t.role)}
                  gainDb={t.gainDb}
                  mute={t.mute}
                  solo={t.solo}
                  audible={audible[i] ?? true}
                  selected={selected?.id === t.id}
                  height={LANE_HEIGHT}
                  status={t.status}
                  warning={t.warning}
                  onSelect={() => setSelectedId(t.id)}
                  onGain={(db) => setGain(t.id, db)}
                  onMute={() => toggleMute(t.id)}
                  onSolo={() => toggleSolo(t.id)}
                  onRemove={() => remove(t.id)}
                />
              ))}
            </div>

            <div className="flex-1 min-w-0 bg-zinc-950">
              {tracks.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 px-8 text-center">
                  <p className="text-[12px] text-zinc-500">트랙을 불러오세요</p>
                  <p className="text-[10px] text-zinc-600 max-w-md leading-relaxed">
                    DAW에서 내보낸 스템(킥, 베이스, 보컬…)을 넣으면 파일 이름과 실제 측정으로 악기를 판별하고,
                    악기마다 다른 체인을 걸어 하나로 합칩니다. 스템은 이미 0에 정렬돼 있으므로 타임라인 편집은 없습니다.
                  </p>
                </div>
              ) : tracks.map((t, i) => (
                <div
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={`border-b border-black/50 px-px ${selected?.id === t.id ? 'bg-zinc-900/60' : ''}`}
                  style={{ height: LANE_HEIGHT }}
                >
                  <div className="h-full rounded-sm overflow-hidden" style={{
                    background: `${trackColor(t.role)}12`,
                    borderLeft: `2px solid ${trackColor(t.role)}`,
                  }}>
                    <TrackWaveform
                      peaks={peaks.get(t.filePath) ?? null}
                      color={trackColor(t.role)}
                      height={LANE_HEIGHT - 2}
                      zoom={zoom}
                      scroll={scroll}
                      dimmed={!(audible[i] ?? true)}
                      playhead={playing || status.position > 0 ? playFrac : null}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* The open plugin. A DAW opens a plugin in its own window; this
              sits over the arrange area, which is the same idea without a
              second window to lose behind the first. */}
          {selected && openModule && (
            <div className="shrink-0 max-h-[62%] overflow-y-auto border-t border-black/60 bg-zinc-900/95">
              <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5
                              border-b border-black/50 bg-zinc-900/95">
                <span className="text-[11px] text-zinc-200">
                  {moduleLabel(openModule.id)}
                </span>
                <span className="text-[10px] text-zinc-600 truncate">{selected.name}</span>
                <div className="flex-1" />
                <button
                  onClick={() => togglePlugin(openModule.id)}
                  className={`text-[10px] px-2 py-0.5 rounded-sm border transition-colors ${
                    openModule.bypass
                      ? 'border-zinc-700 text-zinc-500'
                      : 'border-emerald-600/60 text-emerald-400'}`}
                >
                  {openModule.bypass ? '꺼짐' : '켜짐'}
                </button>
                <button
                  onClick={() => setOpenInsert(null)}
                  className="text-[11px] text-zinc-600 hover:text-zinc-200 px-1"
                >✕</button>
              </div>
              <div className="px-3 py-2">
                <TrackPluginEditor
                  moduleId={openModule.id}
                  values={openModule.parameters}
                  bypass={openModule.bypass}
                  metrics={selectedMetrics}
                  analyser={selectedAnalyser}
                  freeBands={freeBands}
                  onChange={(patch) => editParameters(openModule.id, patch)}
                  onFreeBands={editFreeBands}
                />
              </div>
            </div>
          )}

          {/* Horizontal scroll — a viewport control, not an edit tool. */}
          {zoom > 1 && (
            <div className="shrink-0 h-5 flex items-center px-2 border-t border-black/60 bg-zinc-900/50">
              <input
                type="range" min={0} max={1} step={0.001}
                value={scroll}
                onChange={(e) => setScroll(Number(e.target.value))}
                className="daw-mini w-full"
                aria-label="가로 스크롤"
              />
            </div>
          )}
        </div>

        <div
          onPointerDown={(e) => startDrag('rack', e)}
          className="w-1 shrink-0 cursor-ew-resize hover:bg-zinc-600/60 transition-colors"
          title="드래그해서 마스터 랙 너비를 조절합니다"
        />

        {/* Rack — the master bus lives here, as a DAW's output section does. */}
        <div
          className="shrink-0 border-l border-black/60 bg-zinc-900/40 overflow-y-auto"
          style={{ width: sizes.rack }}
        >
          <div className="px-3 py-2 border-b border-black/40">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">Master Bus</div>
          </div>
          <div className="px-3 py-3 space-y-3">
            <select
              value={masterPresetId ?? ''}
              onChange={(e) => setMasterPreset(e.target.value === '' ? null : e.target.value)}
              className="w-full text-[11px] bg-zinc-950 border border-zinc-700 rounded-sm px-1.5 py-1
                         focus:outline-none focus:border-zinc-500"
            >
              <option value="">없음 (합산만)</option>
              {masterChoices.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
            </select>

            {activeMaster && (
              <>
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[9px] uppercase tracking-widest text-zinc-600">Loudness</span>
                    <span className="text-[10px] font-mono text-zinc-400 tabular-nums">
                      {(masterTargetLufs ?? activeMaster.targetLufs).toFixed(1)} LUFS
                    </span>
                  </div>
                  <input
                    type="range" min={-20} max={-6} step={0.5}
                    value={masterTargetLufs ?? activeMaster.targetLufs}
                    onChange={(e) => setMasterTargetLufs(Number(e.target.value))}
                    className="daw-mini w-full mt-1"
                    aria-label="목표 라우드니스"
                  />
                </div>
                <div className="text-[9px] font-mono text-zinc-600">
                  CEILING {activeMaster.ceilingDbtp.toFixed(1)} dBTP
                </div>
                <p className="text-[10px] text-zinc-600 leading-snug">{activeMaster.description}</p>
              </>
            )}

            <p className="text-[9px] text-zinc-700 leading-snug border-t border-black/40 pt-2">
              미리듣기는 스템 체인과 믹서까지입니다. 마스터 버스는 믹스다운에 적용됩니다 —
              라우드니스는 완성된 파일을 재서 맞추는 방식이라 실시간으로는 같은 값이 나오지 않습니다.
            </p>

            {lastReport && (
              <div className="border-t border-black/40 pt-2 space-y-1">
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">Last mixdown</div>
                <div className="text-[10px] font-mono text-zinc-400 tabular-nums">
                  {lastReport.masterLufs.toFixed(1)} LUFS · {lastReport.masterTruePeakDb.toFixed(1)} dBTP
                </div>
                <div className={`text-[9px] font-mono tabular-nums ${lastReport.sumPeakDb > 0 ? 'text-amber-400' : 'text-zinc-600'}`}>
                  SUM {lastReport.sumPeakDb.toFixed(1)} dBFS
                </div>
                {lastReport.loudnessNote !== 'ok' && lastReport.loudnessNote !== 'not-requested' && (
                  <div className="text-[9px] text-amber-400">목표 미달 — {lastReport.loudnessNote}</div>
                )}
                {lastOutputPath && (
                  <button
                    onClick={() => void window.electronAPI?.invoke('file:save-wav', lastOutputPath)}
                    className="w-full text-[10px] py-1 rounded-sm border border-zinc-700 hover:border-zinc-500 transition-colors"
                  >WAV 저장</button>
                )}
              </div>
            )}

            {(renderError || status.error) && (
              <p className="text-[10px] text-amber-400 leading-snug border-t border-black/40 pt-2">
                {renderError ?? status.error}
              </p>
            )}

            {tracks.length > 0 && (
              <button
                onClick={clear}
                className="w-full text-[10px] py-1 rounded-sm border border-zinc-800 text-zinc-600
                           hover:text-red-400 transition-colors"
              >세션 비우기</button>
            )}
          </div>
        </div>
      </div>

      {/* ── MixConsole ─────────────────────────────────────────────────── */}
      <div
        className="shrink-0 border-t border-black/60 bg-zinc-950 flex flex-col"
        style={{ height: sizes.console }}
      >
        {/* Grab strip. Four pixels of target with a visible hairline — a
            resize edge that cannot be found is the same as one that is not
            there. */}
        <div
          onPointerDown={(e) => startDrag('console', e)}
          className="shrink-0 h-1 -mt-1 cursor-ns-resize bg-transparent hover:bg-zinc-600/60 transition-colors"
          title="드래그해서 믹스콘솔 높이를 조절합니다"
        />
        <div className="shrink-0 h-6 flex items-center px-3 border-b border-black/50 bg-zinc-900/60">
          <span className="text-[9px] uppercase tracking-widest text-zinc-600">MixConsole</span>
          <span className="ml-3 text-[9px] text-zinc-700">
            {audible.filter(Boolean).length} / {tracks.length} audible
          </span>
          <div className="flex-1" />
          <span className="text-[9px] font-mono text-zinc-700 tabular-nums">
            {status.liveChains > 0 ? `${status.liveChains} live chains · ` : ''}
            {status.memoryBytes > 0 ? `${(status.memoryBytes / 1e6).toFixed(0)} MB` : ''}
          </span>
        </div>

        <div className="flex-1 flex min-h-0 overflow-x-auto">
          {tracks.map((t, i) => (
            <MixerStrip
              key={t.id}
              name={t.name}
              role={roleLabel(t.role)}
              color={trackColor(t.role)}
              gainDb={t.gainDb}
              pan={t.pan}
              mute={t.mute}
              solo={t.solo}
              audible={audible[i] ?? true}
              selected={selected?.id === t.id}
              inserts={insertsFor(t.role)}
              level={null}
              onSelect={() => setSelectedId(t.id)}
              onGain={(db) => setGain(t.id, db)}
              onPan={(v) => setPan(t.id, v)}
              onMute={() => toggleMute(t.id)}
              onSolo={() => toggleSolo(t.id)}
              onOpenInserts={() => openInStudio(t)}
            />
          ))}

          {tracks.length === 0 && (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-[10px] text-zinc-700">채널 없음</span>
            </div>
          )}

          {/* Master strip — always last, always on the right. */}
          <div className="w-[96px] shrink-0 h-full flex flex-col bg-zinc-900/70 border-l-2 border-zinc-700">
            <div className="h-1 shrink-0 bg-zinc-400" />
            <div className="px-2 pt-1.5 pb-1 border-b border-black/30">
              <div className="text-[10px] text-zinc-100">MASTER</div>
              <div className="text-[9px] text-zinc-500 truncate">
                {activeMaster?.displayName ?? '없음'}
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center px-2">
              <div className="text-center">
                <div className="text-[10px] font-mono text-zinc-400 tabular-nums">
                  {lastReport ? `${lastReport.masterLufs.toFixed(1)}` : '—'}
                </div>
                <div className="text-[8px] text-zinc-600 tracking-widest">LUFS</div>
              </div>
            </div>
            <div className="px-2 pb-2">
              <div className="text-[8px] text-zinc-700 leading-tight text-center">
                믹스다운에서 적용
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
