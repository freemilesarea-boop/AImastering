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
  useAllModuleParameters,
  ALL_MODULE_PARAMETER_DEFS,
  type ModuleId,
  type ParameterValue,
} from '../audio/parameters/index.js';
import {
  PresetPatchDispatcher,
  PreviewRenderController,
  IpcPreviewRenderTransport,
  mergeOptions,
  summarizePending,
  initialStateFromBaseOptions,
  buildExportOverride,
  hashOverride,
  type PreviewRenderState,
  type PendingSummary,
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
  // Pending summary (production path only; null in storybook).
  const previewBridge = usePreviewBridge();
  const pendingByModule = previewBridge?.summary.pendingByModule;
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
        {...(pendingByModule ? { pendingByModule } : {})}
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

// Renders the inline header actions: preview-ready tag + modified badge +
// bypass toggle + reset.
function SlideOverActions({ moduleId }: { moduleId: ModuleId }) {
  const { isModified, bypass, setBypass, reset } = useModuleParameters(moduleId);
  const bridge = usePreviewBridge();
  const previewState = bridge?.summary.pendingByModule[moduleId] ?? null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
      {previewState && (
        <span
          title={previewState === 'renderable'
            ? 'This module has changes that will reflect on the next preview update'
            : 'This module has changes that are staged only (not in the preview)'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 22,
            paddingInline: 8,
            borderRadius: radius.chip,
            border: `1px solid ${previewState === 'renderable' ? 'rgba(16,185,129,0.45)' : surface.border}`,
            background: previewState === 'renderable' ? meter.safe.background : surface.well,
            color: previewState === 'renderable' ? meter.safe.foreground : text.muted,
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            fontWeight: typography.weight.medium,
            letterSpacing: '0.02em',
          }}
        >
          {previewState === 'renderable' ? 'Preview-ready' : 'Staged only'}
        </span>
      )}
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

  // Re-master & Export wiring (production path only).
  const bridge = usePreviewBridge();
  const exportInfo = bridge ? buildExportOverride(bridge.summary) : null;

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
        {...(bridge && exportInfo ? {
          reMasterExport: {
            appliedKeys: exportInfo.appliedOverrideKeys,
            skippedParameterIds: exportInfo.skippedParameterIds,
            hasUnpreviewedChanges: bridge.hasUnpreviewedChanges,
            phase: bridge.exportPhase,
            error: bridge.exportError,
            lastExportPath: bridge.lastExportPath,
            onReMasterExport: bridge.onReMasterExport,
            asIs: {
              available: bridge.exportAsIsAvailable,
              phase: bridge.exportAsIsPhase,
              error: bridge.exportAsIsError,
              lastExportPath: bridge.lastExportAsIsPath,
              onExportAsIs: bridge.onExportAsIs,
            },
          },
        } : {})}
      />
    );
  }
}

// ── Preview bridge — shared pending summary + render controls ──────────
//
// M3-P-NEXT-5D-1: multiple consumers (preview strip, module strip pending
// dots, slide-over "Preview-ready" tag) need the same pending summary +
// render state.  A small context provides it.  Mounted only in the
// production path; storybook consumers see `null` and show no pending.

type ExportPhase = 'idle' | 'exporting' | 'done' | 'error';

interface PreviewBridge {
  summary: PendingSummary;
  phase: PreviewControlPhase;
  lastRenderedAt: number | null;
  error: string | null;
  onUpdate: () => void;
  // Export (M3-P-NEXT-5D-2-a)
  exportPhase: ExportPhase;
  exportError: string | null;
  lastExportPath: string | null;
  /** Renderable changes not yet reflected in the preview (export-includes warning). */
  hasUnpreviewedChanges: boolean;
  /** Re-master with the current render override, then save via dialog. */
  onReMasterExport: () => void;
  // Export As-is (M3-P-NEXT-5D-2-b)
  exportAsIsAvailable: boolean;
  exportAsIsPhase: ExportPhase;
  exportAsIsError: string | null;
  lastExportAsIsPath: string | null;
  /** Save the current master WAV unchanged (no re-render). */
  onExportAsIs: () => void;
}

const PreviewBridgeContext = React.createContext<PreviewBridge | null>(null);
function usePreviewBridge(): PreviewBridge | null {
  return React.useContext(PreviewBridgeContext);
}

function ProductionPreviewProvider({
  sourceAudioPath,
  baseOptions,
  masterOutputPath,
  onRendered,
  children,
}: {
  sourceAudioPath: string;
  baseOptions: MasteringOptions;   // already normalised
  /** The current master WAV path — saved unchanged by "Export As-is". */
  masterOutputPath: string | null;
  onRendered: (previewPath: string) => void;
  children: React.ReactNode;
}) {
  const { state } = useAllModuleParameters();
  const [lastRenderedOverride, setLastRenderedOverride] = useState<Partial<MasteringOptions>>({});
  const [phase, setPhase] = useState<PreviewControlPhase>('idle');
  const [lastRenderedAt, setLastRenderedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Export state (M3-P-NEXT-5D-2-a)
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  // Export As-is state (M3-P-NEXT-5D-2-b)
  const [exportAsIsPhase, setExportAsIsPhase] = useState<ExportPhase>('idle');
  const [exportAsIsError, setExportAsIsError] = useState<string | null>(null);
  const [lastExportAsIsPath, setLastExportAsIsPath] = useState<string | null>(null);

  const summary = useMemo(
    () => summarizePending(state, lastRenderedOverride, baseOptions),
    [state, lastRenderedOverride, baseOptions],
  );

  // Renderable changes the user hasn't previewed yet (export-includes warning).
  const hasUnpreviewedChanges = summary.patchHash !== hashOverride(lastRenderedOverride);

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
        setLastRenderedOverride(requestedOverrideRef.current);
      },
      onError: () => { /* state set via onState */ },
      onNoop: () => setPhase('idle'),
    });
  }
  React.useEffect(() => () => controllerRef.current?.dispose(), []);

  const onUpdate = useCallback(() => {
    if (!summary.hasUnrenderedChanges) return;
    const override = summary.renderOverride;
    requestedOverrideRef.current = override;
    const options = mergeOptions(baseOptions, override);
    controllerRef.current!.request({
      sourceAudioPath,
      options,
      changedKeys: Object.keys(override),
      patchHash: summary.patchHash,
      appliedOverrideKeys: Object.keys(override),
      skippedParameterIds: summary.unsupportedPending.map((u) => `${u.moduleId}.${u.parameterId}`),
      targetSummary: `${options.targetLufs.toFixed(1)} LUFS · ${options.targetTp.toFixed(1)} dBTP`,
    });
    controllerRef.current!.flush();   // explicit click → render now
  }, [summary, baseOptions, sourceAudioPath]);

  // Re-master & Export — reuses the EXISTING audio:master + file:save-wav
  // channels.  No new IPC, no Python change.  The export override is the
  // SAME `summary.renderOverride` the preview uses (consistency by
  // construction).
  const onReMasterExport = useCallback(() => {
    const { optionsOverride } = buildExportOverride(summary);
    const options = mergeOptions(baseOptions, optionsOverride);
    const api = window.electronAPI;
    if (!api) { setExportPhase('error'); setExportError('electronAPI unavailable'); return; }
    setExportPhase('exporting');
    setExportError(null);
    void (async () => {
      try {
        const result = await api.invoke('audio:master', sourceAudioPath, '', options) as
          { outputPath?: string } | undefined;
        const outputPath = result?.outputPath;
        if (!outputPath) { setExportPhase('error'); setExportError('master produced no output'); return; }
        const saved = await api.invoke('file:save-wav', outputPath) as string | null;
        if (saved) {
          setLastExportPath(saved);
          setExportPhase('done');
        } else {
          // User cancelled the save dialog — return to idle, keep prior state.
          setExportPhase('idle');
        }
      } catch (err) {
        setExportPhase('error');
        setExportError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [summary, baseOptions, sourceAudioPath]);

  // Export As-is — saves the current master WAV unchanged.  Reuses
  // file:save-wav; no re-render.
  const onExportAsIs = useCallback(() => {
    const api = window.electronAPI;
    if (!api) { setExportAsIsPhase('error'); setExportAsIsError('electronAPI unavailable'); return; }
    if (!masterOutputPath) { setExportAsIsPhase('error'); setExportAsIsError('no master to export'); return; }
    setExportAsIsPhase('exporting');
    setExportAsIsError(null);
    void (async () => {
      try {
        const saved = await api.invoke('file:save-wav', masterOutputPath) as string | null;
        if (saved) { setLastExportAsIsPath(saved); setExportAsIsPhase('done'); }
        else setExportAsIsPhase('idle');   // user cancelled
      } catch (err) {
        setExportAsIsPhase('error');
        setExportAsIsError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [masterOutputPath]);

  const bridge: PreviewBridge = {
    summary, phase, lastRenderedAt, error, onUpdate,
    exportPhase, exportError, lastExportPath, hasUnpreviewedChanges, onReMasterExport,
    exportAsIsAvailable: Boolean(masterOutputPath),
    exportAsIsPhase, exportAsIsError, lastExportAsIsPath, onExportAsIs,
  };
  return (
    <PreviewBridgeContext.Provider value={bridge}>
      {children}
    </PreviewBridgeContext.Provider>
  );
}

/** Preview strip — reads the bridge.  Rendered as ProductLayoutInner's slot. */
function PreviewSlotFromBridge() {
  const bridge = usePreviewBridge();
  if (!bridge) return null;
  return (
    <LouiPreviewControl
      pendingCount={bridge.summary.renderablePendingCount}
      stagedOnlyCount={bridge.summary.unsupportedPendingCount}
      phase={bridge.phase}
      lastRenderedAt={bridge.lastRenderedAt}
      error={bridge.error}
      onUpdate={bridge.onUpdate}
    />
  );
}

/** Normalise store-shaped options into a shared-types MasteringOptions. */
function normaliseOptions(o: {
  style: MasteringOptions['style'];
  targetLufs: number; targetTp: number; sampleRate: number; bitDepth: number;
  applyAiCorrections: boolean;
  limiterStrength?: MasteringOptions['limiterStrength'];
  saturationAmount?: number | undefined;
  stereoWidth?: number | undefined;
  outputGainDb?: number | undefined;
}): MasteringOptions {
  return {
    style: o.style,
    targetLufs: o.targetLufs,
    targetTp: o.targetTp,
    sampleRate: o.sampleRate,
    bitDepth: o.bitDepth,
    applyAiCorrections: o.applyAiCorrections,
    ...(o.limiterStrength !== undefined ? { limiterStrength: o.limiterStrength } : {}),
    ...(o.saturationAmount !== undefined ? { saturationAmount: o.saturationAmount } : {}),
    ...(o.stereoWidth !== undefined ? { stereoWidth: o.stereoWidth } : {}),
    ...(o.outputGainDb !== undefined ? { outputGainDb: o.outputGainDb } : {}),
  };
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

  // Normalise the store options + seed the parameter state from the base
  // master so renderable params start matching the preview (no false
  // pending at load).
  const normalisedBase = useMemo(() => normaliseOptions(baseOptions), [baseOptions]);
  const initialParamState = useMemo(
    () => initialStateFromBaseOptions(normalisedBase),
    [normalisedBase],
  );

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
      <ModuleParameterStateProvider dispatcher={dispatcher} initialState={initialParamState}>
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
          {...(sourceAudioPath ? {
            preview: {
              sourceAudioPath,
              baseOptions: normalisedBase,
              masterOutputPath: masteringResult?.outputPath ?? null,
              onRendered: onPreviewRendered,
            },
          } : {})}
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
  preview?: {
    sourceAudioPath: string;
    baseOptions: MasteringOptions;
    masterOutputPath: string | null;
    onRendered: (previewPath: string) => void;
  };
}) {
  const session = useWasmAnalyzerSession();
  const layout = (
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
      {...(props.preview ? { previewSlot: <PreviewSlotFromBridge /> } : {})}
    />
  );
  if (!props.preview) return layout;
  return (
    <ProductionPreviewProvider
      sourceAudioPath={props.preview.sourceAudioPath}
      baseOptions={props.preview.baseOptions}
      masterOutputPath={props.preview.masterOutputPath}
      onRendered={props.preview.onRendered}
    >
      {layout}
    </ProductionPreviewProvider>
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
