/**
 * StudioPage — the full module rack.
 *
 * Layout is two columns and deliberately not a slide-over.  With five
 * modules an overlay was fine; with twenty, the thing you need on screen is
 * the CHAIN, permanently, so you can see what is engaged while you edit one
 * module.  So: chain on the left, the selected module's parameters on the
 * right, and nothing covering either.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ file · master bypass · reset                            │
 *   ├──────────────────┬──────────────────────────────────────┤
 *   │ Signal chain     │  Selected module                     │
 *   │  Restoration     │   ┌───────────────────────────────┐  │
 *   │   De-click    ▸  │   │ Parameters                    │  │
 *   │   De-noise    ▸  │   │  …                            │  │
 *   │  Tone            │   └───────────────────────────────┘  │
 *   │   …              │                                      │
 *   ├──────────────────┴──────────────────────────────────────┤
 *   │ engaged summary · latency                               │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The page owns no DSP.  It reads and writes the central parameter state;
 * `chain-config.ts` turns that state into the config both the preview and
 * the export render consume.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from '../components/TopBar.js';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { LouiModuleRack, type ModuleReadout } from '../components/product/LouiModuleRack.js';
import { ModuleParameterPanel } from '../components/product/panels/ModuleParameterPanel.js';
import { LouiEqGraph } from '../components/product/modules/LouiEqGraph.js';
import { LouiDynamicsGraph } from '../components/product/modules/LouiDynamicsGraph.js';
import { LouiFreeEqBandList } from '../components/product/modules/LouiFreeEqBandList.js';
import {
  RestorationView,
  RESTORATION_VIEW_MODULES,
} from '../components/product/modules/LouiRestorationViews.js';
import {
  ToneDynamicsView,
  TONE_DYN_VIEW_MODULES,
} from '../components/product/modules/LouiToneDynamicsViews.js';
import {
  CharacterView,
  CHARACTER_VIEW_MODULES,
} from '../components/product/modules/LouiCharacterViews.js';
import { buildDynamicsGraph, compressorStartingPoint } from '../audio/modules/dynamics-graph-model.js';
import {
  buildGraphBands,
  bandEdits,
  freeBandsToGraph,
  freeBandToWire,
  makeFreeBand,
  FREE_KIND_CYCLE,
  type FreeEqBand,
  type GraphBand,
} from '../audio/modules/eq-graph-model.js';
import { getNativeAnalysers } from '../audio/shared-audio-graph.js';
import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../audio/parameters/index.js';
import { getModule } from '../audio/modules/loui-module-suite.js';
import { MODULE_GLOSSARY } from '../audio/parameters/parameter-glossary.js';
import {
  buildChainConfig, activeModuleIds, MASTER_NATIVE_BIT_DEPTH, MAX_PARAMETRIC_BANDS,
  DEFAULT_MONITOR, monitorAltersOutput, type MonitorSettings,
} from '../audio/chain-config.js';

/** Last path segment, for showing which reference is loaded. */
function baseName(p: string): string {
  return p.split('/').pop()?.split('\\').pop() ?? p;
}

/** Keep a dragged value inside its range. */
function clampRange(v: number, lo: number, hi: number): number {
  return !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
}
import { LouiMonitorBar } from '../components/product/LouiMonitorBar.js';
import { LouiStudioPresetBar } from '../components/product/LouiStudioPresetBar.js';
import { presetApplyPlan } from '../audio/presets/preset-to-state.js';
import { recommendedFor } from '../audio/presets/recommended-defaults.js';
import {
  loadSongSettings, saveSongSettings, clearSongSettings, changedModules,
} from '../audio/session/song-settings.js';
import type { LouiPreset } from '../audio/presets/loui-presets.js';
import { LouiPreviewTransport } from '../components/product/LouiPreviewTransport.js';
import type { MonitorReadout } from '../components/product/LouiMonitorBar.js';
import { useRealtimePreview } from '../hooks/useRealtimePreview.js';
import { isRealtimePreviewEnabled } from '../audio/realtime-preview-flag.js';
import { toFileUrl } from '../utils/fileUrl.js';
import { surface, text, typography, space, radius, meter } from '../theme/loui-theme.js';

/** Modules whose engagement is decided by the shared spectral stage. */
const SPECTRAL_MODULE_IDS = new Set<ModuleId>(['match-eq', 'spectral-shaper', 'stabilizer']);

/**
 * Registry ids that share a parameter module.  The rack lists them as
 * separate rows (they are separate ideas to a user), but they edit the same
 * parameters, so selecting either opens the same panel.
 */
const REGISTRY_TO_PARAM: Record<string, ModuleId> = {
  maximizer: 'limiter',
  'harshness-control': 'spectral-shaper',
  'reference-match': 'match-eq',
  'ai-harshness-guard': 'dynamic-eq',
  // Dither is its own idea to a user but its parameters only mean anything
  // against the export's bit depth, so they live on the export module.
  dither: 'export',
};

function paramModuleFor(registryId: string): ModuleId | undefined {
  const direct = REGISTRY_TO_PARAM[registryId];
  if (direct) return direct;
  const mod = getModule(registryId);
  return mod?.paramModuleId;
}

export default function StudioPage() {
  const setPage = useAppStore((s) => s.setPage);
  const notify = useAppStore((s) => s.notify);
  const selectedFile = useAudioStore((s) => s.selectedFile);
  const refreshStudioSaved = useAudioStore((s) => s.refreshStudioSaved);

  // Parameter state lives here for now: the provider in
  // `useModuleParameterState` is mounted by the product layout, which this
  // page does not sit inside.  Keeping it local means the Studio works
  // standalone; wiring it to the provider is a drop-in replacement because
  // the shape is identical.
  //
  // Seeded from whatever was saved for this song, so opening the Studio on
  // a track that was worked on last week picks it up where it was left
  // rather than at defaults. `useState`'s initialiser runs once per mount
  // and the page remounts per song, which is exactly the right cadence.
  const [state, setState] = useState<AllModulesParameterState>(() => {
    const saved = selectedFile ? loadSongSettings(selectedFile) : null;
    return saved?.state ?? defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  });
  const [selected, setSelected] = useState<string>('eq');
  const [masterBypass, setMasterBypass] = useState(
    () => (selectedFile ? loadSongSettings(selectedFile)?.masterBypass : false) ?? false,
  );
  // Monitoring is session state, not module state — it must never end up in
  // a preset or an export.  See `MonitorSettings`.
  const [monitor, setMonitor] = useState<MonitorSettings>(DEFAULT_MONITOR);
  // The element the chain is inserted into.  Held in state (not a ref) so
  // the preview hook re-attaches when the player mounts — but it is set
  // exactly once per element, so it cannot churn.
  const [media, setMedia] = useState<HTMLMediaElement | null>(null);
  // The free EQ's bands.  Not in `state` because that is a flat map of
  // named scalars per module and this list has neither fixed length nor
  // fixed names; it reaches the chain through `parametricBands`.
  const [freeBands, setFreeBands] = useState<FreeEqBand[]>(
    () => (selectedFile ? loadSongSettings(selectedFile)?.freeBands : undefined) ?? [],
  );
  /** The preset last applied, for the bar's active mark. */
  const [appliedPreset, setAppliedPreset] = useState<string | null>(
    () => (selectedFile ? loadSongSettings(selectedFile)?.presetId : null) ?? null,
  );
  /**
   * When this song was last saved, and whether it has moved since.
   *
   * Tracked rather than diffed: comparing the whole rack against the saved
   * snapshot on every pointer move during an EQ drag would be the most
   * expensive thing on the page, and the only question the header needs
   * answered is "is there anything to save".
   */
  const [savedAt, setSavedAt] = useState<number | null>(
    () => (selectedFile ? loadSongSettings(selectedFile)?.savedAt : null) ?? null,
  );
  const [dirty, setDirty] = useState(false);

  /**
   * The Match EQ reference.
   *
   * Held here rather than in the parameter state because it is 32 measured
   * numbers plus the path they came from, and that state is a flat map of
   * named scalars per module — the same reason the free EQ's bands live
   * outside it. It reaches the chain through `matchTargetCurveDb`.
   */
  const [reference, setReference] = useState<{
    path: string | null;
    name: string | null;
    curveDb: readonly number[] | null;
    busy: boolean;
    error: string | null;
  }>(() => {
    const saved = selectedFile ? loadSongSettings(selectedFile) : null;
    return {
      path: saved?.referencePath ?? null,
      name: saved?.referencePath ? baseName(saved.referencePath) : null,
      curveDb: saved?.referenceCurveDb ?? null,
      busy: false,
      error: null,
    };
  });

  const chooseReference = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const picked = await api.invoke('file:open-dialog') as string | null;
    if (!picked) return;
    setReference((r) => ({ ...r, busy: true, error: null }));
    const res = await api.invoke('audio:reference-curve', picked) as
      { ok: true; curveDb: number[]; measuredSeconds: number } | { ok: false; error: string };
    if (!res.ok) {
      setReference((r) => ({ ...r, busy: false, error: res.error }));
      return;
    }
    setReference({
      path: picked, name: baseName(picked), curveDb: res.curveDb,
      busy: false, error: null,
    });
    // Match EQ ships bypassed, because matching to nothing is a no-op that
    // would still cost an STFT frame of latency. Choosing a reference IS
    // the request to match, so leaving it bypassed here would mean loading
    // a reference and hearing nothing — the same dead end this whole
    // feature exists to remove.
    setState((prev) => ({ ...prev, 'match-eq': { ...prev['match-eq'], bypass: false } }));
    notify(`레퍼런스 분석 완료 (${res.measuredSeconds.toFixed(0)}초) · 레퍼런스 매칭을 켰습니다`, 'success');
  }, [notify]);

  const clearReference = useCallback(() => {
    setReference({ path: null, name: null, curveDb: null, busy: false, error: null });
  }, []);

  const referenceControls = useMemo(() => ({
    name: reference.name,
    onChoose: () => { void chooseReference(); },
    onClear: clearReference,
    busy: reference.busy,
    error: reference.error,
  }), [reference.name, reference.busy, reference.error, chooseReference, clearReference]);

  const src = selectedFile ? toFileUrl(selectedFile) : null;
  // Read once per mount: the flag is a kill switch, not a live toggle.
  const [realtimeEnabled] = useState(() => isRealtimePreviewEnabled());

  const paramModule = paramModuleFor(selected);

  const setParam = useCallback((moduleId: ModuleId, parameterId: string, value: ParameterValue) => {
    setState((prev) => ({
      ...prev,
      [moduleId]: {
        ...prev[moduleId],
        parameters: { ...prev[moduleId].parameters, [parameterId]: value },
      },
    }));
  }, []);

  /**
   * Several parameters at once, in ONE state update.
   *
   * A graph drag moves frequency and gain together; writing them through
   * two `setParam` calls would push two configs per pointer event, and the
   * intermediate one describes a band that was never asked for.
   */
  const setParams = useCallback((moduleId: ModuleId, edits: Array<[string, ParameterValue]>) => {
    if (edits.length === 0) return;
    setState((prev) => {
      const params = { ...prev[moduleId].parameters };
      for (const [id, value] of edits) params[id] = value;
      return { ...prev, [moduleId]: { ...prev[moduleId], parameters: params } };
    });
  }, []);

  /**
   * Apply a preset.
   *
   * Written into the same state a slider writes, in one update: the preview
   * hears it on the next config push, and moving any control afterwards is
   * an ordinary edit rather than "leaving preset mode".  Modules the preset
   * does not mention are left exactly as they are — a preset that silently
   * reset the rest would throw away work every time one was auditioned.
   */
  const applyPreset = useCallback((preset: LouiPreset) => {
    const plan = presetApplyPlan(preset);
    setState((prev) => {
      const next = { ...prev };
      for (const b of plan.bypasses) {
        next[b.moduleId] = { ...next[b.moduleId], bypass: b.bypass };
      }
      for (const p of plan.parameters) {
        const mod = next[p.moduleId];
        next[p.moduleId] = {
          ...mod,
          parameters: { ...mod.parameters, [p.parameterId]: p.value },
        };
      }
      return next;
    });
    setAppliedPreset(preset.id);
  }, []);

  /**
   * Write one module's recommended starting point.
   *
   * Bypass moves with the parameters, because half the recommendations are
   * "leave this off" and applying only the numbers would switch a module on
   * that the recommendation says should not be.
   */
  const applyRecommended = useCallback((moduleId: ModuleId) => {
    const entry = recommendedFor(moduleId);
    if (!entry) return;
    setState((prev) => {
      const mod = prev[moduleId];
      return {
        ...prev,
        [moduleId]: {
          ...mod,
          ...(entry.bypass !== undefined ? { bypass: entry.bypass } : {}),
          parameters: { ...mod.parameters, ...entry.parameters },
        },
      };
    });
  }, []);

  /**
   * The beginner's one button: every module at once.
   *
   * Written in a single update so the preview hears one config rather than
   * twenty-four, and so undoing it is one step.
   */
  const applyAllRecommended = useCallback(() => {
    setState((prev) => {
      const next = { ...prev };
      for (const id of MODULE_IDS) {
        const entry = recommendedFor(id);
        if (!entry) continue;
        const mod = next[id];
        next[id] = {
          ...mod,
          ...(entry.bypass !== undefined ? { bypass: entry.bypass } : {}),
          parameters: { ...mod.parameters, ...entry.parameters },
        };
      }
      return next;
    });
    // The free EQ is a band list, not named scalars, and the recommendation
    // has no opinion on it — clearing it would throw away deliberate work.
    setAppliedPreset(null);
    notify('모든 모듈에 추천 설정을 적용했습니다', 'success');
  }, [notify]);

  const setBypass = useCallback((moduleId: ModuleId, bypass: boolean) => {
    setState((prev) => ({ ...prev, [moduleId]: { ...prev[moduleId], bypass } }));
  }, []);

  const resetAll = useCallback(() => {
    setState(defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS));
    setMasterBypass(false);
    setMonitor(DEFAULT_MONITOR);
  }, []);

  // Anything that would change the render marks the song unsaved. One
  // effect rather than a flag in every setter: the setters are the wide
  // surface (graph drags, preset bar, band list, bypass rows) and missing
  // one of them would silently lose work at save time.
  const firstPass = useRef(true);
  useEffect(() => {
    if (firstPass.current) { firstPass.current = false; return; }
    setDirty(true);
  }, [state, freeBands, masterBypass, reference.curveDb]);

  /** Write this song's work down, keyed by its path. */
  const saveSettings = useCallback(() => {
    if (!selectedFile) return;
    const entry = saveSongSettings({
      filePath: selectedFile,
      state,
      freeBands,
      masterBypass,
      presetId: appliedPreset,
      referencePath: reference.path,
      referenceCurveDb: reference.curveDb ? [...reference.curveDb] : null,
    });
    setSavedAt(entry.savedAt);
    setDirty(false);
    refreshStudioSaved();
    notify(`${changedModules(state).length}개 모듈 설정을 저장했습니다`, 'success');
  }, [selectedFile, state, freeBands, masterBypass, appliedPreset, reference, refreshStudioSaved, notify]);

  /** Throw this song's saved work away and go back to defaults. */
  const forgetSettings = useCallback(() => {
    if (!selectedFile) return;
    clearSongSettings(selectedFile);
    setSavedAt(null);
    setDirty(false);
    refreshStudioSaved();
    notify('저장한 설정을 지웠습니다', 'info');
  }, [selectedFile, refreshStudioSaved, notify]);

  const resetModule = useCallback((moduleId: ModuleId) => {
    setState((prev) => ({
      ...prev,
      [moduleId]: defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS)[moduleId],
    }));
  }, []);

  // The config the engine would receive right now.  Recomputed on every
  // edit — it is a pure function over state and cheap enough that
  // memoising on `state` is all the debouncing this view needs.
  const config = useMemo(
    () => buildChainConfig({
      state, masterBypass, monitor,
      parametricBands: freeBands.map(freeBandToWire),
      // Without this Match EQ can never engage — it is the target it
      // compares the mix against, and nothing used to supply one.
      ...(reference.curveDb ? { matchTargetCurveDb: reference.curveDb } : {}),
    }),
    [state, masterBypass, monitor, freeBands, reference.curveDb],
  );

  /**
   * Which registry rows count as engaged.  `activeModuleIds` speaks in
   * parameter-module terms; the rack also shows alias rows, so map those
   * back onto whatever drives them.
   */
  const engagedIds = useMemo(() => {
    const active = new Set<string>(activeModuleIds(config));
    for (const [registryId, param] of Object.entries(REGISTRY_TO_PARAM)) {
      if (active.has(param)) active.add(registryId);
    }
    return [...active];
  }, [config]);

  const bypassById = useMemo(() => {
    const out: Partial<Record<ModuleId, boolean>> = {};
    for (const id of MODULE_IDS) out[id] = state[id].bypass;
    return out;
  }, [state]);

  // The realtime preview.  `config` is the same object the export render
  // consumes, so what you hear is what you get.
  const preview = useRealtimePreview({
    media,
    enabled: realtimeEnabled,
    config,
  });

  // Live monitor figures, but only while the chain is genuinely running —
  // showing the last numbers from a stopped engine would be a lie the user
  // could act on.
  const liveReadout: MonitorReadout = useMemo(() => {
    const m = preview.metrics;
    if (preview.phase !== 'running' || !m.running) return {};
    return {
      loudnessDeltaDb: m.loudnessDeltaDb,
      matchGainDb: m.matchGainDb,
      ...(Number.isFinite(m.dryLufs) ? { dryLufs: m.dryLufs } : {}),
      ...(Number.isFinite(m.wetLufs) ? { wetLufs: m.wetLufs } : {}),
    };
  }, [preview.phase, preview.metrics]);

  /**
   * Readouts.  Without a running engine there is no metering to show, so
   * each row reports the setting that decides whether it is doing anything
   * — an honest "what is dialled in", never a fabricated meter.
   */
  const readouts = useMemo(() => {
    const out: Record<string, ModuleReadout> = {};
    const n = (id: ModuleId, p: string) => {
      const v = state[id].parameters[p];
      return typeof v === 'number' ? v : 0;
    };
    const put = (id: string, value: string, active: boolean) => { out[id] = { value, active }; };

    put('denoise', `${n('denoise', 'reductionDb').toFixed(0)} dB`, n('denoise', 'reductionDb') > 0);
    put('dehum', `${n('dehum', 'depthDb').toFixed(0)} dB`, n('dehum', 'depthDb') > 0);
    put('deess', `${n('deess', 'rangeDb').toFixed(0)} dB`, n('deess', 'rangeDb') > 0);
    put('low-end-focus', `${n('low-end-focus', 'contrastPct').toFixed(0)}%`, n('low-end-focus', 'contrastPct') > 0);
    put('tape', `${n('tape', 'mixPct').toFixed(0)}%`, n('tape', 'mixPct') > 0);
    put('vintage-comp', `${n('vintage-comp', 'ratio').toFixed(1)}:1`, n('vintage-comp', 'ratio') > 1);
    put('dynamics', `${n('dynamics', 'ratio').toFixed(1)}:1`, n('dynamics', 'ratio') > 1);
    // The limiter and glue compressor have real meters once the chain is
    // running; fall back to their settings when it is not.
    const live = preview.phase === 'running' && preview.metrics.running;
    if (live && preview.metrics.limiterGrDb > 0.05) {
      put('limiter', `-${preview.metrics.limiterGrDb.toFixed(1)} dB GR`, true);
    } else {
      put('limiter', `${n('limiter', 'ceilingDbtp').toFixed(1)} dBTP`, true);
    }
    if (live && preview.metrics.dynamicsGrDb > 0.05) {
      put('dynamics', `-${preview.metrics.dynamicsGrDb.toFixed(1)} dB GR`, true);
    }
    put('maximizer', `+${n('limiter', 'driveDb').toFixed(1)} dB`, n('limiter', 'driveDb') > 0);
    put('imager', `${n('imager', 'widthPct').toFixed(0)}%`, n('imager', 'widthPct') !== 100);

    // Dither reports the depth it targets.  At or above the master's native
    // depth there is no reduction to dither, and saying so is more useful
    // than showing a mode that is not running.
    const depthStr = state.export.parameters['bitDepth'];
    const depth = typeof depthStr === 'string' ? Number(depthStr) : MASTER_NATIVE_BIT_DEPTH;
    const ditherMode = String(state.export.parameters['dither'] ?? 'tpdf');
    const reduces = depth < MASTER_NATIVE_BIT_DEPTH;
    put(
      'dither',
      reduces ? `${depth}-bit · ${ditherMode}` : `${depth}-bit · 감축 없음`,
      reduces && !state.export.bypass,
    );

    for (const id of SPECTRAL_MODULE_IDS) {
      const amount = n(id, 'amountPct');
      put(id, `${amount.toFixed(0)}%`, engagedIds.includes(id));
    }
    put('reference-match', out['match-eq']?.value ?? '', engagedIds.includes('reference-match'));
    put('harshness-control', out['spectral-shaper']?.value ?? '', engagedIds.includes('harshness-control'));

    const exciterSum = [0, 1, 2, 3].reduce((a, i) => a + n('exciter', `band${i}Pct`), 0);
    put('exciter', `${(exciterSum / 4).toFixed(0)}%`, exciterSum > 0);

    const impactPeak = [0, 1, 2, 3]
      .map((i) => n('impact', `band${i}Pct`))
      .reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
    put('impact', impactPeak === 0 ? '0%' : `${impactPeak > 0 ? '+' : ''}${impactPeak.toFixed(0)}%`, impactPeak !== 0);

    return out;
  }, [state, engagedIds, preview.phase, preview.metrics]);

  const handleSelect = useCallback((id: string) => setSelected(id), []);
  const handleToggleBypass = useCallback(
    (id: ModuleId, bypass: boolean) => setBypass(id, bypass),
    [setBypass],
  );

  const registryEntry = getModule(selected);
  const def = paramModule ? ALL_MODULE_PARAMETER_DEFS[paramModule] : undefined;

  // ── EQ curve editor ──────────────────────────────────────────────────
  // The EQ modules are edited on a graph rather than a stack of sliders.
  // The bands are derived from the same parameter values the sliders read,
  // and a drag writes those parameters back — so the two views can never
  // disagree, and the graph inherits the realtime push for free.
  const isFreeEq = paramModule === 'parametric-eq';
  const graphBands = isFreeEq
    ? freeBandsToGraph(freeBands)
    : paramModule ? buildGraphBands(paramModule, state[paramModule].parameters) : null;
  const wantsGraph = graphBands !== null;

  /** A node moved.  Fixed modules write parameters; the free EQ edits its list. */
  const handleBandChange = useCallback((
    band: GraphBand,
    next: { hz?: number; gainDb?: number; q?: number },
  ) => {
    if (band.free) {
      setFreeBands((prev) => prev.map((b) => (b.id !== band.id ? b : {
        ...b,
        ...(next.hz !== undefined ? { frequencyHz: clampRange(next.hz, 20, 20_000) } : {}),
        ...(next.gainDb !== undefined ? { gainDb: clampRange(next.gainDb, -30, 30) } : {}),
        ...(next.q !== undefined ? { q: clampRange(next.q, 0.1, 18) } : {}),
      })));
      return;
    }
    if (!paramModule) return;
    setParams(paramModule, bandEdits(band, next));
  }, [paramModule, setParams]);

  // ── Dynamics editor ──────────────────────────────────────────────────
  // The compressor modules get a transfer curve and a live GR meter rather
  // than a column of numbers.  The reduction comes from the metrics the
  // audio thread already posts; nothing new is sampled per block.
  const dynamicsSpec = paramModule
    ? buildDynamicsGraph(paramModule, state[paramModule].parameters)
    : null;
  const dynamicsReduction = useMemo(() => {
    if (!dynamicsSpec) return [];
    if (dynamicsSpec.kind === 'multiband') return preview.metrics.multibandGrDb;
    if (dynamicsSpec.kind === 'vintage-comp') {
      // The vari-mu has no meter of its own in the chain; saying "0.0"
      // would be a claim, so the cell shows the idle dash instead.
      return [0];
    }
    return [preview.metrics.dynamicsGrDb];
  }, [dynamicsSpec, preview.metrics]);

  const freeGestures = useMemo(() => ({
    onAdd: (hz: number, gainDb: number) => setFreeBands((prev) => (
      prev.length >= MAX_PARAMETRIC_BANDS ? prev : [...prev, makeFreeBand(hz, gainDb)]
    )),
    onRemove: (id: string) => setFreeBands((prev) => prev.filter((b) => b.id !== id)),
    onCycleType: (id: string) => setFreeBands((prev) => prev.map((b) => {
      if (b.id !== id) return b;
      const i = FREE_KIND_CYCLE.indexOf(b.kind as (typeof FREE_KIND_CYCLE)[number]);
      return { ...b, kind: FREE_KIND_CYCLE[(i + 1) % FREE_KIND_CYCLE.length]! };
    })),
    atCapacity: freeBands.length >= MAX_PARAMETRIC_BANDS,
  }), [freeBands.length]);

  /** A typed edit from the band list.  Same state the graph writes. */
  const patchFreeBand = useCallback((id: string, patch: Partial<FreeEqBand>) => {
    setFreeBands((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);
  // The post-chain analyser, for the trace behind the curve.  Only asked
  // for when a graph is on screen, so no analyser is built otherwise.
  const analyser = useMemo(
    () => (media && wantsGraph ? getNativeAnalysers(media).main : null),
    [media, wantsGraph],
  );

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: surface.background,
      overflow: 'hidden',
    }}>
      <TopBar />

      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space['3'],
        paddingInline: space['5'],
        paddingBlock: space['3'],
        borderBottom: `1px solid ${surface.border}`,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}>
            Studio
          </span>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.sm,
            color: text.secondary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {selectedFile
              ? selectedFile.split('/').pop()?.split('\\').pop()
              : '음원을 선택하면 미리듣기에 반영됩니다'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
          <HeaderButton
            label={masterBypass ? 'Chain off' : 'Chain on'}
            active={!masterBypass}
            onClick={() => setMasterBypass((v) => !v)}
          />
          {monitorAltersOutput(monitor) && (
            <span style={{
              fontFamily: typography.family.sans,
              fontSize: typography.size.xs,
              color: meter.warn.foreground,
              whiteSpace: 'nowrap',
            }}>
              비교 모드
            </span>
          )}
          {/* Saving is the join between the Studio and the batch: without
              it the work is heard once and thrown away on Back. */}
          {selectedFile && (
            <>
              <span style={{
                fontFamily: typography.family.sans,
                fontSize: typography.size.xs,
                color: dirty ? meter.warn.foreground : text.muted,
                whiteSpace: 'nowrap',
              }}>
                {dirty
                  ? '저장 안 됨 (Unsaved)'
                  : savedAt
                    ? `저장됨 ${new Date(savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                    : '저장 기록 없음'}
              </span>
              <HeaderButton
                label={dirty ? '이 곡 설정 저장 ●' : '이 곡 설정 저장'}
                active={dirty}
                onClick={saveSettings}
              />
              {savedAt !== null && (
                <HeaderButton label="저장 삭제" onClick={forgetSettings} />
              )}
            </>
          )}
          <HeaderButton label="Reset all" onClick={resetAll} />
          <HeaderButton label="Back" onClick={() => setPage('home')} />
        </div>
      </header>

      <div style={{
        paddingInline: space['4'],
        paddingTop: space['3'],
        display: 'flex',
        flexDirection: 'column',
        gap: space['3'],
      }}>
        <LouiPreviewTransport
          src={src}
          onMediaRef={setMedia}
          phase={preview.phase}
          error={preview.error}
          metrics={preview.metrics}
        />
        <LouiStudioPresetBar
          appliedId={appliedPreset}
          onApply={applyPreset}
          onApplyRecommended={applyAllRecommended}
        />

        <LouiMonitorBar
          value={monitor}
          onChange={setMonitor}
          appliesTo={preview.phase === 'running' ? 'live' : 'render'}
          readout={liveReadout}
        />
      </div>

      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 320px) 1fr',
        gap: space['4'],
        padding: space['4'],
      }}>
        <LouiModuleRack
          selectedId={selected}
          engagedIds={engagedIds}
          bypassById={bypassById}
          readouts={readouts}
          latencySamples={preview.metrics.latencySamples}
          sampleRate={48_000}
          onSelect={handleSelect}
          onToggleBypass={handleToggleBypass}
        />

        <div style={{ minHeight: 0, overflowY: 'auto', paddingRight: space['1'] }}>
          {def && paramModule && registryEntry ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: space['3'],
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.lg,
                    fontWeight: typography.weight.medium,
                    color: text.primary,
                  }}>
                    {registryEntry.displayName}
                    <span style={{ color: text.tertiary, fontWeight: typography.weight.normal }}>
                      {MODULE_GLOSSARY[paramModule] ? `  ${MODULE_GLOSSARY[paramModule].ko}` : ''}
                    </span>
                  </span>
                  {/* The plain-Korean sentence leads, because the person
                      who needs an explanation reads it first; the English
                      description follows for the person who wants the
                      precise wording. */}
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.sm,
                    color: text.secondary,
                    lineHeight: 1.6,
                    maxWidth: '60ch',
                  }}>
                    {MODULE_GLOSSARY[paramModule]?.plain ?? ''}
                  </span>
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.xs,
                    color: text.muted,
                    lineHeight: 1.5,
                    maxWidth: '60ch',
                  }}>
                    {registryEntry.description}
                  </span>
                </div>
                <HeaderButton label="Reset" onClick={() => resetModule(paramModule)} />
              </div>

              <ModuleParameterPanel
                moduleId={paramModule}
                def={def}
                values={state[paramModule].parameters}
                bypass={state[paramModule].bypass}
                onChange={(id, value) => setParam(paramModule, id, value)}
                recommended={recommendedFor(paramModule)}
                onApplyRecommended={() => applyRecommended(paramModule)}
                {...(CHARACTER_VIEW_MODULES.has(paramModule)
                  ? {
                    editor: (
                      <CharacterView
                        moduleId={paramModule}
                        values={state[paramModule].parameters}
                        metrics={preview.metrics}
                        disabled={state[paramModule].bypass}
                      />
                    ),
                  }
                  : {})}
                {...(TONE_DYN_VIEW_MODULES.has(paramModule)
                  ? {
                    editor: (
                      <ToneDynamicsView
                        moduleId={paramModule}
                        registryId={selected}
                        values={state[paramModule].parameters}
                        metrics={preview.metrics}
                        disabled={state[paramModule].bypass}
                      />
                    ),
                  }
                  : {})}
                {...(RESTORATION_VIEW_MODULES.has(paramModule)
                  ? {
                    editor: (
                      <RestorationView
                        moduleId={paramModule}
                        values={state[paramModule].parameters}
                        metrics={preview.metrics}
                        disabled={state[paramModule].bypass}
                        {...(reference.curveDb ? { targetCurveDb: reference.curveDb } : {})}
                        reference={referenceControls}
                      />
                    ),
                  }
                  : {})}
                {...(dynamicsSpec
                  ? {
                    editor: (
                      <LouiDynamicsGraph
                        spec={dynamicsSpec}
                        reductionDb={dynamicsReduction}
                        live={preview.metrics.running && !preview.metrics.bypass}
                        disabled={state[paramModule].bypass}
                        onSetUp={() => setParams(
                          paramModule, compressorStartingPoint(paramModule),
                        )}
                      />
                    ),
                  }
                  : {})}
                {...(graphBands
                  ? {
                    editor: (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
                        <LouiEqGraph
                          bands={graphBands}
                          analyser={analyser}
                          disabled={state[paramModule].bypass}
                          onBandChange={handleBandChange}
                          {...(isFreeEq ? { free: freeGestures } : {})}
                        />
                        {isFreeEq && (
                          // The graph is the fast way to work; typing is the
                          // exact one.  Both edit the same bands.
                          <LouiFreeEqBandList
                            bands={freeBands}
                            disabled={state[paramModule].bypass}
                            onChange={patchFreeBand}
                            onRemove={freeGestures.onRemove}
                            onAdd={() => freeGestures.onAdd(1000, 0)}
                            atCapacity={freeGestures.atCapacity}
                          />
                        )}
                      </div>
                    ),
                  }
                  : {})}
                {...(paramModule === 'denoise' || SPECTRAL_MODULE_IDS.has(paramModule)
                  ? { note: '이 모듈은 STFT 기반이라 켜면 지연이 추가됩니다 (2048 샘플 ≈ 43 ms @ 48 kHz). 실시간 모니터링 시 참고하세요.' }
                  : {})}
              />
            </div>
          ) : (
            // A registry row with no parameter module is normally an
            // unfinished entry.  Bass Control is the deliberate case: it has
            // no DSP, and its view says so rather than drawing a panel that
            // would be indistinguishable from a working one.
            selected === 'bass-control'
              ? (
                <ToneDynamicsView
                  moduleId="bass-control"
                  registryId="bass-control"
                  values={{}}
                  metrics={preview.metrics}
                />
              )
              : <EmptyPanel />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────

function HeaderButton(props: { label: string; active?: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: 'none',
        cursor: 'pointer',
        paddingInline: space['3'],
        paddingBlock: space['1'],
        borderRadius: radius.chip,
        border: `1px solid ${props.active ? 'rgba(167,139,250,0.5)' : surface.border}`,
        background: props.active
          ? 'rgba(167,139,250,0.16)'
          : hover ? surface.overlay : surface.well,
        color: props.active ? meter.accent.foreground : text.secondary,
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.medium,
        transition: 'background 120ms ease-out',
        whiteSpace: 'nowrap',
      }}
    >
      {props.label}
    </button>
  );
}

function EmptyPanel() {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: `1px dashed ${surface.border}`,
      borderRadius: radius.panel,
    }}>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.sm,
        color: text.muted,
      }}>
        이 모듈은 아직 조절할 파라미터가 없습니다
      </span>
    </div>
  );
}
