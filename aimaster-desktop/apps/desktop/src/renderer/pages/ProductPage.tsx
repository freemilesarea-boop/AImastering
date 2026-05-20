// ProductPage — Loui Mastering product-layout result screen.
//
// Ozone-style layout:
//   ┌─────────────────────────── TopBar ──────────────────────────────┐
//   ├──────────────────────── Preset Header ──────────────────────────┤
//   ├──────────────────────────────────────────────────┬──────────────┤
//   │                                                  │              │
//   │           Analyzer Canvas (Spectrum)             │   Meter      │
//   │                                                  │   Column     │
//   │                                                  │              │
//   ├──────────────────────────────────────────────────┴──────────────┤
//   │                        Module Strip                              │
//   ├─────────────────────────── Status ──────────────────────────────┤
//   └──────────────────────────────────────────────────────────────────┘
//
// Mounted by App.tsx ONLY when the product-layout flag is on.  When the
// flag is off, App.tsx renders the legacy ResultPage as before.
//
// Storybook + tests can drive the page deterministically by passing
// `sessionOverride` — a pre-built AnalyzerSession that bypasses the
// WasmAnalyzerProvider entirely.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore.js';
import { useAudioStore } from '../stores/audioStore.js';
import { toFileUrl } from '../utils/fileUrl.js';
import { surface, text, typography, meter, space, radius } from '../theme/loui-theme.js';
import { analyzerFactoryLabel } from '../audio/analyzer-factory-resolver.js';
import {
  WasmAnalyzerProvider,
  useWasmAnalyzerSession,
} from '../audio/wasm-analyzer-context.js';
import {
  ModuleParameterStateProvider,
  useModuleParameters,
  ALL_MODULE_PARAMETER_DEFS,
  type ModuleId,
  type ParameterValue,
} from '../audio/parameters/index.js';
import {
  PresetPatchDispatcher,
  PreviewRenderController,
  IpcPreviewRenderTransport,
  buildPreviewOverride,
  mergeOptions,
  type PreviewRenderState,
} from '../audio/engine-bridge/index.js';
import { LouiPreviewControl, type PreviewControlPhase } from '../components/product/LouiPreviewControl.js';
import type { MasteringOptions } from '@aimaster/shared-types';
import {
  LouiTopBar,
  LouiPresetHeader,
  LouiAnalyzerCanvas,
  LouiMeterColumn,
  LouiModuleStrip,
  LouiStatusBar,
  LouiModuleSlideOver,
  EqParameterPanel,
  DynamicsParameterPanel,
  ImagerParameterPanel,
  LimiterParameterPanel,
  ExportParameterPanel,
  type ModuleCardDef,
} from '../components/product/index.js';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';

export interface ProductPageProps {
  /**
   * Storybook / test override.  When provided, the page renders its
   * panels with this session directly — no AudioContext, no WASM
   * provider, no media element.
   */
  sessionOverride?: AnalyzerSession | null;
  /**
   * Storybook-only convenience: render the layout in "playing" state
   * without a real audio element.
   */
  storybookActive?: boolean;
}

// ── Inner layout (shared between production and storybook modes) ────────

function ProductLayoutInner({
  session,
  active,
  sampleRate,
  channels,
  targetLufs,
  targetTp,
  presetId,
  onPresetChange,
  selectedModule,
  onSelectModule,
  onPlayPause,
  isPlaying,
  durationLabel,
  currentTimeLabel,
  onSeek,
  progress,
  modules,
  onImport,
  onExport,
  onSettings,
  previewSlot,
}: {
  session: AnalyzerSession | null;
  active: boolean;
  sampleRate: number;
  channels: number;
  targetLufs?: number;
  targetTp?: number;
  presetId?: string;
  onPresetChange?: (id: string) => void;
  selectedModule?: ModuleCardDef['id'];
  onSelectModule?: (id: ModuleCardDef['id']) => void;
  onPlayPause?: () => void;
  isPlaying?: boolean;
  durationLabel?: string;
  currentTimeLabel?: string;
  onSeek?: (ratio: number) => void;
  progress?: number;
  modules?: ModuleCardDef[];
  onImport?: () => void;
  onExport?: () => void;
  onSettings?: () => void;
  /** Optional preview-control strip (production path only). */
  previewSlot?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: surface.background,
        color: text.secondary,
        fontFamily: typography.family.sans,
      }}
    >
      <LouiTopBar
        subtitle="Result"
        engineLabel={analyzerFactoryLabel()}
        {...(onImport ? { onImport } : {})}
        {...(onExport ? { onExport } : {})}
        {...(onSettings ? { onSettings } : {})}
      />

      <LouiPresetHeader
        {...(presetId ? { activeId: presetId } : {})}
        {...(onPresetChange ? { onTargetChange: onPresetChange } : {})}
      />

      {/* Preview-control strip — staged-change → re-render loop (production). */}
      {previewSlot}

      {/* Optional transport strip — visible only when a play handler is wired
          (production path).  Storybook stories without media skip this. */}
      {onPlayPause && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: space['3'],
            paddingInline: space['4'],
            paddingBlock: space['2'],
            background: surface.background,
            borderBottom: `1px solid ${surface.border}`,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onPlayPause}
            className="no-drag"
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              border: `1px solid ${surface.border}`,
              background: surface.well,
              color: text.primary,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="2" width="3.5" height="12" rx="1" />
                <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
              </svg>
            ) : (
              <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2.5l10 5.5-10 5.5V2.5z" />
              </svg>
            )}
          </button>
          <div
            className="no-drag"
            onClick={(e) => {
              if (!onSeek) return;
              const rect = e.currentTarget.getBoundingClientRect();
              onSeek((e.clientX - rect.left) / rect.width);
            }}
            style={{
              flex: 1,
              height: 6,
              background: surface.well,
              borderRadius: 3,
              cursor: onSeek ? 'pointer' : 'default',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.round((progress ?? 0) * 100)}%`,
                height: '100%',
                background: text.tertiary,
                transition: 'width 100ms linear',
              }}
            />
          </div>
          <span
            style={{
              fontFamily: typography.family.mono,
              fontSize: typography.size.xs,
              color: text.muted,
              fontVariantNumeric: 'tabular-nums',
              minWidth: 88,
              textAlign: 'right',
            }}
          >
            {currentTimeLabel ?? '0:00'} / {durationLabel ?? '0:00'}
          </span>
        </div>
      )}

      {/* Main content grid — analyzer (flex) + meter column (320px) */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: space['3'],
          padding: space['3'],
        }}
      >
        <LouiAnalyzerCanvas session={session} active={active} />
        <LouiMeterColumn
          session={session}
          {...(typeof targetLufs === 'number' ? { targetLufs } : {})}
        />
      </div>

      <LouiModuleStrip
        {...(selectedModule ? { selectedId: selectedModule } : {})}
        {...(onSelectModule ? { onSelect: onSelectModule } : {})}
        {...(modules ? { modules } : {})}
      />

      <LouiStatusBar
        sampleRate={sampleRate}
        channels={channels}
        oversample={4}
        {...(typeof targetLufs === 'number' ? { targetLufs } : { targetLufs: -14 })}
        {...(typeof targetTp === 'number' ? { targetTp } : { targetTp: -1 })}
        engineLabel={analyzerFactoryLabel()}
        running={active}
      />

      {/* Module parameter slide-over.  Mounts behind a backdrop when a
          module is selected; closes via ESC / backdrop / close button.
          Re-clicking the same card from LouiModuleStrip also closes
          (handled by the caller's `onSelectModule` toggle logic). */}
      <ModuleSlideOverHost
        selected={selectedModule ?? null}
        onClose={() => { if (selectedModule) onSelectModule?.(selectedModule); }}
      />
    </div>
  );
}

// ── Slide-over host — maps `selectedModule` id to the right panel ──────

function ModuleSlideOverHost(props: {
  selected: ModuleCardDef['id'] | null;
  onClose: () => void;
}) {
  const isOpen = Boolean(props.selected);
  // Keep the previous selection visible during the close transition so
  // the content doesn't blank out before the panel finishes sliding.
  const [renderedId, setRenderedId] = React.useState<ModuleCardDef['id'] | null>(props.selected);
  React.useEffect(() => {
    if (props.selected) setRenderedId(props.selected);
  }, [props.selected]);

  const titleFor = (id: ModuleCardDef['id']): { title: string; subtitle: string } => {
    switch (id) {
      case 'eq':       return { title: 'EQ',       subtitle: 'Adaptive 7-band' };
      case 'dynamics': return { title: 'Dynamics', subtitle: 'Glue Comp' };
      case 'imager':   return { title: 'Imager',   subtitle: 'Stereo width · Mono fold-down' };
      case 'limiter':  return { title: 'Limiter',  subtitle: 'True-peak guard' };
      case 'export':   return { title: 'Export',   subtitle: 'Format · Sample rate · Dither' };
    }
  };

  const id = renderedId ?? 'eq';
  const meta = titleFor(id);
  return (
    <LouiModuleSlideOver
      title={meta.title}
      subtitle={meta.subtitle}
      open={isOpen}
      onClose={props.onClose}
      headerActions={renderedId ? <SlideOverActions moduleId={renderedId as ModuleId} /> : null}
    >
      {renderedId ? <ControlledPanelHost moduleId={renderedId as ModuleId} /> : null}
    </LouiModuleSlideOver>
  );
}

// Renders the inline header actions: modified badge + bypass toggle + reset.
function SlideOverActions({ moduleId }: { moduleId: ModuleId }) {
  const { isModified, bypass, setBypass, reset } = useModuleParameters(moduleId);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
      {isModified && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 22,
          paddingInline: 8,
          borderRadius: radius.chip,
          border: `1px solid rgba(167,139,250,0.45)`,
          background: 'rgba(167,139,250,0.16)',
          color: meter.accent.foreground,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          Modified
        </span>
      )}
      <button
        type="button"
        onClick={() => setBypass(!bypass)}
        aria-pressed={bypass}
        title={bypass ? 'Bypassed — click to enable' : 'Enabled — click to bypass'}
        style={{
          height: 22,
          paddingInline: 10,
          borderRadius: radius.chip,
          border: `1px solid ${bypass ? meter.warn.foreground : surface.border}`,
          background: bypass ? meter.warn.background : 'transparent',
          color: bypass ? meter.warn.foreground : text.tertiary,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          letterSpacing: '0.02em',
          cursor: 'pointer',
        }}
      >
        {bypass ? 'Bypassed' : 'On'}
      </button>
      <button
        type="button"
        onClick={() => reset()}
        title="Reset module parameters to defaults"
        style={{
          height: 22,
          paddingInline: 8,
          borderRadius: radius.chip,
          border: `1px solid ${surface.border}`,
          background: 'transparent',
          color: text.tertiary,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          cursor: 'pointer',
        }}
      >
        Reset
      </button>
    </div>
  );
}

// Pulls the module slice from the central state and feeds it to the
// appropriate panel as controlled props.  Every onChange becomes a
// SET_MODULE_PARAM command in the log.
function ControlledPanelHost({ moduleId }: { moduleId: ModuleId }) {
  const api = useModuleParameters(moduleId);
  const stateRecord = api.state.parameters;
  const onParamChange = (parameterId: string, value: ParameterValue) =>
    api.setParam(parameterId, value);
  const onBypassChange = (b: boolean) => api.setBypass(b);
  const onReset = () => api.reset();

  // Read limiter targets when rendering the export panel so the
  // "Normalize Target" echo reflects the live state.
  const limiterApi = useModuleParameters('limiter');
  const tLufs = limiterApi.get('targetLufs');
  const tTp   = limiterApi.get('ceilingDbtp');

  const common = {
    state: stateRecord,
    bypass: api.bypass,
    isModified: api.isModified,
    onParamChange,
    onBypassChange,
    onReset,
  };

  switch (moduleId) {
    case 'eq':       return <EqParameterPanel       {...common} />;
    case 'dynamics': return <DynamicsParameterPanel {...common} />;
    case 'imager':   return <ImagerParameterPanel   {...common} />;
    case 'limiter':  return <LimiterParameterPanel  {...common} />;
    case 'export':   return (
      <ExportParameterPanel
        {...common}
        targetLufs={typeof tLufs === 'number' ? tLufs : -14}
        targetTp={typeof tTp   === 'number' ? tTp   : -1}
      />
    );
  }
}

// ── Production preview-control — staged patch → re-render preview ───────
//
// 5C renderable set = `limiter.targetLufs` only.  This component
// subscribes to the limiter slice (so it re-renders when targetLufs
// changes), reads the dispatcher's staged patch, builds a MasteringOptions
// override, and drives the re-render controller on an explicit click.

function ProductionPreviewControl({
  dispatcher,
  sourceAudioPath,
  baseOptions: storeOptions,
  onRendered,
}: {
  dispatcher: PresetPatchDispatcher;
  sourceAudioPath: string;
  /** Store-shaped mastering options (optionals may be `undefined`). */
  baseOptions: {
    style: MasteringOptions['style'];
    targetLufs: number; targetTp: number; sampleRate: number; bitDepth: number;
    applyAiCorrections: boolean;
    limiterStrength?: MasteringOptions['limiterStrength'];
    saturationAmount?: number | undefined;
    stereoWidth?: number | undefined;
    outputGainDb?: number | undefined;
  };
  onRendered: (previewPath: string) => void;
}) {
  // Normalise the store options into a shared-types MasteringOptions —
  // drop `undefined` optionals so exactOptionalPropertyTypes is satisfied.
  const baseOptions: MasteringOptions = {
    style: storeOptions.style,
    targetLufs: storeOptions.targetLufs,
    targetTp: storeOptions.targetTp,
    sampleRate: storeOptions.sampleRate,
    bitDepth: storeOptions.bitDepth,
    applyAiCorrections: storeOptions.applyAiCorrections,
    ...(storeOptions.limiterStrength !== undefined ? { limiterStrength: storeOptions.limiterStrength } : {}),
    ...(storeOptions.saturationAmount !== undefined ? { saturationAmount: storeOptions.saturationAmount } : {}),
    ...(storeOptions.stereoWidth !== undefined ? { stereoWidth: storeOptions.stereoWidth } : {}),
    ...(storeOptions.outputGainDb !== undefined ? { outputGainDb: storeOptions.outputGainDb } : {}),
  };
  // Subscribe to the limiter slice — re-renders this component when the
  // renderable parameter (targetLufs) changes.
  useModuleParameters('limiter');

  const [phase, setPhase] = useState<PreviewControlPhase>('idle');
  const [lastRenderedAt, setLastRenderedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderedOverride, setRenderedOverride] = useState<Partial<MasteringOptions>>({});

  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const requestedOverrideRef = useRef<Partial<MasteringOptions>>({});

  const controllerRef = useRef<PreviewRenderController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new PreviewRenderController(new IpcPreviewRenderTransport(), {
      debounceMs: 600,
      onState: (s: PreviewRenderState) => {
        switch (s.phase) {
          case 'idle':      setPhase('idle'); break;
          case 'pending':   setPhase('pending'); break;
          case 'rendering': setPhase('rendering'); break;
          case 'updated':   setPhase('updated'); setLastRenderedAt(s.at); break;
          case 'error':     setPhase('error'); setError(s.error); break;
        }
      },
      onSuccess: (previewPath) => {
        onRenderedRef.current(previewPath);
        setRenderedOverride(requestedOverrideRef.current);
      },
      onError: () => { /* state already set via onState */ },
    });
  }
  React.useEffect(() => () => controllerRef.current?.dispose(), []);

  // Pending renderable changes vs the override that produced the current preview.
  const build = buildPreviewOverride(dispatcher.getStagedPatch());
  const current = build.optionsOverride;
  const pendingKeys = Object.keys(current).filter(
    (k) => (current as Record<string, unknown>)[k] !== (renderedOverride as Record<string, unknown>)[k],
  );

  const onUpdate = () => {
    if (pendingKeys.length === 0) return;
    requestedOverrideRef.current = current;
    const options = mergeOptions(baseOptions, current);
    controllerRef.current!.request({ sourceAudioPath, options, changedKeys: pendingKeys });
    controllerRef.current!.flush();   // explicit click → render now
  };

  return (
    <LouiPreviewControl
      pendingCount={pendingKeys.length}
      phase={phase}
      lastRenderedAt={lastRenderedAt}
      error={error}
      onUpdate={onUpdate}
    />
  );
}

// ── Storybook / test path — session bypasses provider ────────────────────

function ProductLayoutWithOverride({
  session,
  active,
}: {
  session: AnalyzerSession | null;
  active: boolean;
}) {
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [selectedModule, setSelectedModule] = useState<ModuleCardDef['id'] | undefined>(undefined);
  // Toggle: click the same card → close.
  const onSelectModule = (id: ModuleCardDef['id']) =>
    setSelectedModule((prev) => (prev === id ? undefined : id));
  // Stage wired parameters into an EngineSchema preset patch.  No live
  // DSP write — see audio/engine-bridge/engine-dispatcher.ts.
  const dispatcher = useMemo(() => new PresetPatchDispatcher(ALL_MODULE_PARAMETER_DEFS), []);
  return (
    <ModuleParameterStateProvider dispatcher={dispatcher}>
      <ProductLayoutInner
        session={session}
        active={active}
        sampleRate={48000}
        channels={2}
        targetLufs={-14}
        targetTp={-1}
        {...(presetId ? { presetId } : {})}
        onPresetChange={setPresetId}
        {...(selectedModule ? { selectedModule } : {})}
        onSelectModule={onSelectModule}
      />
    </ModuleParameterStateProvider>
  );
}

// ── Production path — provider + audio element ──────────────────────────

function ProductPageProduction() {
  const setPage         = useAppStore((s) => s.setPage);
  const masteringResult = useAudioStore((s) => s.masteringResult);
  const sourceAudioPath = useAudioStore((s) => s.selectedFile);
  const baseOptions     = useAudioStore((s) => s.options);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [meterReady, setMeterReady] = useState(false);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [selectedModule, setSelectedModule] = useState<ModuleCardDef['id'] | undefined>(undefined);
  // Preview source override — set when a re-render swaps the preview file.
  const [previewSrcOverride, setPreviewSrcOverride] = useState<string | null>(null);
  const dispatcher = useMemo(() => new PresetPatchDispatcher(ALL_MODULE_PARAMETER_DEFS), []);

  const basePreviewSrc = masteringResult?.previewPath ? toFileUrl(masteringResult.previewPath) : '';
  const previewSrc = previewSrcOverride ?? basePreviewSrc;
  const meta = masteringResult?.analysisReport?.mastering;
  const targetLufs = typeof meta?.targetLufs === 'number' ? meta.targetLufs : -14;
  const targetTp   = typeof meta?.targetTruePeak === 'number' ? meta.targetTruePeak : -1;

  // Swap the preview audio source to a freshly-rendered file, preserving
  // playback position + play/pause state.  If the swap source fails to
  // load, the previous preview keeps playing (browser retains the old
  // buffer until the new one is ready).
  const onPreviewRendered = useCallback((newPreviewPath: string) => {
    const a = audioRef.current;
    const wasPlaying = a ? !a.paused : false;
    const t = a ? a.currentTime : 0;
    setPreviewSrcOverride(toFileUrl(newPreviewPath));
    if (!a) return;
    const restore = () => {
      try { a.currentTime = t; } catch { /* duration may differ slightly */ }
      if (wasPlaying) void a.play();
      a.removeEventListener('loadedmetadata', restore);
    };
    a.addEventListener('loadedmetadata', restore);
  }, []);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { void a.play(); } else { a.pause(); }
  }, []);

  const seekTo = useCallback((ratio: number) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    a.currentTime = Math.max(0, Math.min(duration, ratio * duration));
  }, [duration]);

  const fmtTime = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  const onImport = useCallback(() => { setPage('home'); }, [setPage]);
  const onExport = useCallback(async () => {
    if (!masteringResult?.outputPath) return;
    await window.electronAPI?.invoke('file:save-wav', masteringResult.outputPath);
  }, [masteringResult]);
  const onSettings = useCallback(() => { setPage('settings'); }, [setPage]);

  // Toggle behaviour: re-clicking the active card closes the slide-over.
  const onSelectModule = useCallback((id: ModuleCardDef['id']) => {
    setSelectedModule((prev) => (prev === id ? undefined : id));
  }, []);

  return (
    <>
      {/* Hidden audio element — required for WasmAnalyzerProvider to attach
          a MediaElementAudioSourceNode.  We control it via React state. */}
      <audio
        ref={audioRef}
        src={previewSrc || undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTime(0); }}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (a) setTime(a.currentTime);
        }}
        onLoadedMetadata={() => {
          const a = audioRef.current;
          if (a) setDuration(a.duration);
          setMeterReady(true);
        }}
        style={{ display: 'none' }}
      />

      <WasmAnalyzerProvider
        mediaElement={meterReady ? audioRef.current : null}
        active={playing}
      >
      <ModuleParameterStateProvider dispatcher={dispatcher}>
        <ProductPageProductionInner
          isPlaying={playing}
          onPlayPause={togglePlay}
          progress={duration > 0 ? time / duration : 0}
          currentTimeLabel={fmtTime(time)}
          durationLabel={fmtTime(duration)}
          onSeek={seekTo}
          targetLufs={targetLufs}
          targetTp={targetTp}
          {...(presetId ? { presetId } : {})}
          onPresetChange={setPresetId}
          {...(selectedModule ? { selectedModule } : {})}
          onSelectModule={onSelectModule}
          onImport={onImport}
          onExport={onExport}
          onSettings={onSettings}
          previewControl={
            sourceAudioPath ? (
              <ProductionPreviewControl
                dispatcher={dispatcher}
                sourceAudioPath={sourceAudioPath}
                baseOptions={baseOptions}
                onRendered={onPreviewRendered}
              />
            ) : null
          }
        />
      </ModuleParameterStateProvider>
      </WasmAnalyzerProvider>
    </>
  );
}

function ProductPageProductionInner(props: {
  isPlaying: boolean;
  onPlayPause: () => void;
  progress: number;
  currentTimeLabel: string;
  durationLabel: string;
  onSeek: (ratio: number) => void;
  targetLufs: number;
  targetTp: number;
  presetId?: string;
  onPresetChange: (id: string) => void;
  selectedModule?: ModuleCardDef['id'];
  onSelectModule: (id: ModuleCardDef['id']) => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  previewControl?: React.ReactNode;
}) {
  const session = useWasmAnalyzerSession();
  return (
    <ProductLayoutInner
      session={session}
      active={props.isPlaying}
      sampleRate={48000}
      channels={2}
      targetLufs={props.targetLufs}
      targetTp={props.targetTp}
      {...(props.presetId ? { presetId: props.presetId } : {})}
      onPresetChange={props.onPresetChange}
      {...(props.selectedModule ? { selectedModule: props.selectedModule } : {})}
      onSelectModule={props.onSelectModule}
      isPlaying={props.isPlaying}
      onPlayPause={props.onPlayPause}
      progress={props.progress}
      currentTimeLabel={props.currentTimeLabel}
      durationLabel={props.durationLabel}
      onSeek={props.onSeek}
      onImport={props.onImport}
      onExport={props.onExport}
      onSettings={props.onSettings}
      {...(props.previewControl ? { previewSlot: props.previewControl } : {})}
    />
  );
}

// ── Public component ─────────────────────────────────────────────────────

export default function ProductPage(props: ProductPageProps = {}) {
  // Two top-level branches — both return distinct component subtrees, so
  // no hooks are shared across branches.  `sessionOverride === undefined`
  // means production path; otherwise the storybook override drives the
  // layout directly.
  if (props.sessionOverride !== undefined) {
    return (
      <ProductLayoutWithOverride
        session={props.sessionOverride}
        active={props.storybookActive ?? Boolean(props.sessionOverride)}
      />
    );
  }
  return <ProductPageProduction />;
}
