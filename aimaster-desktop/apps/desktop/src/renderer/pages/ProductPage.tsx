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
import { useRealtimeMasteringGraph } from '../hooks/useRealtimeMasteringGraph.js';
import { LouiRealtimeDebugPanel } from '../components/product/LouiRealtimeDebugPanel.js';
import {
  ModuleParameterStateProvider,
  useModuleParameters,
  useAllModuleParameters,
  useApplyPreset,
  ALL_MODULE_PARAMETER_DEFS,
  type ModuleId,
  type ParameterValue,
} from '../audio/parameters/index.js';
import { getPreset, DEFAULT_PRESET_ID } from '../audio/presets/loui-presets.js';
import { presetApplyPlan } from '../audio/presets/preset-to-state.js';
import { setLastUsedPreset, getLastUsedPreset } from '../audio/presets/preset-storage.js';
import { LouiPresetSlideOver } from '../components/product/LouiPresetSlideOver.js';
import { LouiRevisionStack } from '../components/product/LouiRevisionStack.js';
import type { RevisionInput } from '../audio/revisions/revision-types.js';
import type { MasteringOptions as StoreMasteringOptions } from '../stores/audioStore.js';
import { getActiveRevision, getBaselineRevision, findDuplicate } from '../audio/revisions/revision-logic.js';
import { LouiModuleChain } from '../components/product/modules/LouiModuleChain.js';
import { LouiRealtimeStatus } from '../components/product/modules/LouiRealtimeStatus.js';
import { LouiRealtimeToggle } from '../components/product/modules/LouiRealtimeToggle.js';
import { setRealtimePreviewEnabled } from '../audio/realtime-preview-flag.js';
import { CHAIN_MODULE_IDS, getModule } from '../audio/modules/loui-module-suite.js';
import { RealtimeGrProvider, useRealtimeGr } from '../audio/modules/realtime-gr-context.js';
import { RealtimePreviewProvider, useRealtimePreviewStatus } from '../audio/modules/realtime-preview-context.js';
import { LouiGainReductionMeter } from '../components/product/modules/LouiGainReductionMeter.js';
import { decayPeak } from '../audio/modules/gr-meter-model.js';
import { stateToChainConfig } from '../audio/realtime-mastering-chain.js';
import { isRustOfflineRenderEnabled } from '../audio/rust-offline-render-flag.js';
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
  type ExportOverrideResult,
} from '../audio/engine-bridge/index.js';
import { LouiPreviewControl, type PreviewControlPhase } from '../components/product/LouiPreviewControl.js';
import type {
  MasteringOptions,
  ExportFormat,
  ExportDither,
  SaveAudioRequest,
  SaveAudioResponse,
} from '@aimaster/shared-types';
import {
  LouiTopBar,
  LouiPresetHeader,
  LouiAnalyzerCanvas,
  LouiMeterColumn,
  LouiModuleStrip,
  LouiStatusBar,
  LouiModuleSlideOver,
  LouiABCompare,
  useABShortcut,
  type ABMode,
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
  onBrowsePresets,
  selectedModule,
  onSelectModule,
  onPlayPause,
  isPlaying,
  durationLabel,
  currentTimeLabel,
  onSeek,
  progress,
  modules,
  onBack,
  onImport,
  onExport,
  onSettings,
  previewSlot,
  revisionSlot,
  moduleSuiteSlot,
  abControl,
}: {
  session: AnalyzerSession | null;
  active: boolean;
  sampleRate: number;
  channels: number;
  targetLufs?: number;
  targetTp?: number;
  presetId?: string;
  onPresetChange?: (id: string) => void;
  /** Opens the full preset browser slide-over. */
  onBrowsePresets?: () => void;
  selectedModule?: ModuleCardDef['id'];
  onSelectModule?: (id: ModuleCardDef['id']) => void;
  onPlayPause?: () => void;
  isPlaying?: boolean;
  durationLabel?: string;
  currentTimeLabel?: string;
  onSeek?: (ratio: number) => void;
  progress?: number;
  modules?: ModuleCardDef[];
  onBack?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onSettings?: () => void;
  /** Optional preview-control strip (production path only). */
  previewSlot?: React.ReactNode;
  /** Optional revision (version) stack (production path only). */
  revisionSlot?: React.ReactNode;
  /** Optional module-suite chain overview (production path only). */
  moduleSuiteSlot?: React.ReactNode;
  /** Optional A/B compare control (production path only). */
  abControl?: React.ReactNode;
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
        {...(onBack ? { onBack } : {})}
        {...(onImport ? { onImport } : {})}
        {...(onExport ? { onExport } : {})}
        {...(onSettings ? { onSettings } : {})}
      />

      <LouiPresetHeader
        {...(presetId ? { activeId: presetId } : {})}
        {...(onPresetChange ? { onTargetChange: onPresetChange } : {})}
        {...(onBrowsePresets ? { onBrowse: onBrowsePresets } : {})}
      />

      {/* Preview-control strip — staged-change → re-render loop (production). */}
      {previewSlot}

      {/* Revision (version) stack — multiple masters of the same source. */}
      {revisionSlot && (
        <div style={{ paddingInline: space['4'], paddingBlock: space['3'], borderBottom: `1px solid ${surface.border}` }}>
          {revisionSlot}
        </div>
      )}

      {/* Module suite — honest chain overview (Live / Preview / Planned). */}
      {moduleSuiteSlot && (
        <div style={{ paddingInline: space['4'], paddingBlock: space['3'], borderBottom: `1px solid ${surface.border}` }}>
          {moduleSuiteSlot}
        </div>
      )}

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
          {abControl}
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
  const rt = useRealtimePreviewStatus();
  const previewState = bridge?.summary.pendingByModule[moduleId] ?? null;
  // Honest 3-state heard/staged badge.  When realtime is processing, every
  // module edit (renderable or not) is audible now → "Heard live".  When
  // it is off, renderable edits are "Staged" (Update Preview applies them);
  // non-renderable edits are "Realtime-only" (never in the Python render).
  const heardLive = rt.active && (previewState !== null || isModified);
  const badge: { label: string; title: string; tone: 'live' | 'staged' | 'rtonly' } | null = heardLive
    ? { label: 'Heard live', tone: 'live', title: 'Realtime preview is on — this module’s changes are audible now.' }
    : previewState === 'renderable'
      ? { label: 'Staged', tone: 'staged', title: 'Click Update Preview / Create Revision to hear this (loudness, true-peak, width, output gain reflect in the render).' }
      : previewState === 'staged'
        ? { label: 'Staged · Realtime-only', tone: 'rtonly', title: 'Not included in the Python re-render or export. Enable Realtime preview to hear it, or use the Rust experimental render to bake it into a file.' }
        : null;
  const badgeBorder = badge?.tone === 'live' ? 'rgba(16,185,129,0.45)' : badge?.tone === 'staged' ? 'rgba(167,139,250,0.45)' : surface.border;
  const badgeBg = badge?.tone === 'live' ? meter.safe.background : badge?.tone === 'staged' ? 'rgba(167,139,250,0.12)' : surface.well;
  const badgeColor = badge?.tone === 'live' ? meter.safe.foreground : badge?.tone === 'staged' ? meter.accent.foreground : text.muted;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
      {badge && (
        <span
          title={badge.title}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 22,
            paddingInline: 8,
            borderRadius: radius.chip,
            border: `1px solid ${badgeBorder}`,
            background: badgeBg,
            color: badgeColor,
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            fontWeight: typography.weight.medium,
            letterSpacing: '0.02em',
          }}
        >
          {badge.label}
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
// Live GR meter for the Limiter / Maximizer panel — reads the realtime GR
// context (REAL limiterGrDb; "unavailable" when the preview isn't running).
function GrMeterFromContext() {
  const gr = useRealtimeGr();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingBlock: space['2'] }}>
      <LouiGainReductionMeter grDb={gr.grDb} peakDb={gr.peakDb} available={gr.available} source={gr.source} label="Limiter GR" />
    </div>
  );
}

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
  const exportInfo: ExportOverrideResult | null = bridge ? bridge.exportOverride : null;

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
    case 'limiter':  return (
      <>
        <GrMeterFromContext />
        <LimiterParameterPanel {...common} />
      </>
    );
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
            quality: {
              label: bridge.qualityLabel,
              willApply: bridge.exportOverride.qualityAppliedKeys.length > 0,
              format: bridge.exportFormat,
              transcodeRequired: bridge.transcodeRequired,
              ditherIgnored: bridge.ditherIgnored,
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
  // Export quality (M3-P-NEXT-5D-2-c)
  exportOverride: ExportOverrideResult;
  /** Human label of the export quality, e.g. "FLAC · 48 kHz · 24-bit". */
  qualityLabel: string;
  // Export format / dither (M3-P-NEXT-5D-2-d)
  exportFormat: string;
  /** True when the format requires an ffmpeg transcode (non-WAV). */
  transcodeRequired: boolean;
  /** True when dither doesn't apply (lossy format or 32-bit float). */
  ditherIgnored: boolean;
  // Revision workflow (M3-REVISION-WORKFLOW)
  /** A new revision is currently rendering. */
  creatingRevision: boolean;
  /** Error from the last create-revision attempt. */
  createRevisionError: string | null;
  /** Render the current edit settings into a NEW revision (reuses audio:master). */
  onCreateRevision: () => void;
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
  presetId,
  onRevisionCreated,
  children,
}: {
  sourceAudioPath: string;
  baseOptions: MasteringOptions;   // already normalised
  /** The current master WAV path — saved unchanged by "Export As-is". */
  masterOutputPath: string | null;
  onRendered: (previewPath: string, integratedLufs?: number) => void;
  /** Preset id stamped onto a created revision. */
  presetId?: string;
  /** A new full master (revision) finished — append it to the group. */
  onRevisionCreated: (input: RevisionInput) => void;
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
  // Revision creation state (M3-REVISION-WORKFLOW)
  const [creatingRevision, setCreatingRevision] = useState(false);
  const [createRevisionError, setCreateRevisionError] = useState<string | null>(null);
  const onRevisionCreatedRef = useRef(onRevisionCreated);
  onRevisionCreatedRef.current = onRevisionCreated;

  const summary = useMemo(
    () => summarizePending(state, lastRenderedOverride, baseOptions),
    [state, lastRenderedOverride, baseOptions],
  );

  // Export override = renderable audio params + export quality (SR/bitDepth).
  const exportOverride = useMemo(
    () => buildExportOverride(summary, state.export.parameters, baseOptions),
    [summary, state, baseOptions],
  );

  // Export container + quality (M3-P-NEXT-5D-2-d).
  const exportFormat   = (state.export.parameters['format'] as ExportFormat | undefined) ?? 'wav';
  const exportDither   = (state.export.parameters['dither'] as ExportDither | undefined) ?? 'none';
  const exportSampleRate = Number(state.export.parameters['sampleRate'] ?? baseOptions.sampleRate);
  const exportBitDepth   = Number(state.export.parameters['bitDepth']   ?? baseOptions.bitDepth);
  const isLossy = exportFormat === 'mp3' || exportFormat === 'ogg';
  const ditherIgnored = isLossy || exportBitDepth === 32;
  const transcodeRequired = exportFormat !== 'wav';

  // Quality label for the export panel (e.g. "FLAC · 48 kHz · 24-bit").
  const qualityLabel = useMemo(() => {
    const fmt = exportFormat.toUpperCase();
    const srLabel = Number.isFinite(exportSampleRate)
      ? `${(exportSampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz` : '—';
    return isLossy ? `${fmt} · ${srLabel}` : `${fmt} · ${srLabel} · ${exportBitDepth}-bit`;
  }, [exportFormat, exportSampleRate, exportBitDepth, isLossy]);

  // Suggested export filename base from the source.
  const suggestedName = useMemo(() => {
    const base = sourceAudioPath.split(/[\\/]/).pop() ?? 'master';
    return base.replace(/\.[^.]+$/, '');
  }, [sourceAudioPath]);

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
      onSuccess: (previewPath, _durationMs, metrics) => {
        onRenderedRef.current(previewPath, metrics?.integratedLufs);
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
    const options = mergeOptions(baseOptions, exportOverride.optionsOverride);
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
        // WAV → proven file:save-wav.  Other formats → file:save-audio
        // (transcode).  The re-mastered WAV is already at target SR/bitDepth.
        if (exportFormat === 'wav') {
          const saved = await api.invoke('file:save-wav', outputPath) as string | null;
          if (saved) { setLastExportPath(saved); setExportPhase('done'); }
          else setExportPhase('idle');
        } else {
          const req: SaveAudioRequest = {
            sourcePath: outputPath,
            format: exportFormat,
            sampleRate: exportSampleRate,
            bitDepth: exportBitDepth,
            dither: exportDither,
            suggestedName,
          };
          const resp = await api.invoke('file:save-audio', req) as SaveAudioResponse;
          if (resp.error) { setExportPhase('error'); setExportError(resp.error); return; }
          if (resp.savedPath) { setLastExportPath(resp.savedPath); setExportPhase('done'); }
          else setExportPhase('idle');
        }
      } catch (err) {
        setExportPhase('error');
        setExportError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [exportOverride, baseOptions, sourceAudioPath, exportFormat, exportSampleRate, exportBitDepth, exportDither, suggestedName]);

  // Export As-is — saves the current master WAV.  WAV keeps the proven
  // file:save-wav path; a non-WAV format transcodes the current master
  // (container change only — quality stays at the master's SR/bitDepth).
  const onExportAsIs = useCallback(() => {
    const api = window.electronAPI;
    if (!api) { setExportAsIsPhase('error'); setExportAsIsError('electronAPI unavailable'); return; }
    if (!masterOutputPath) { setExportAsIsPhase('error'); setExportAsIsError('no master to export'); return; }
    setExportAsIsPhase('exporting');
    setExportAsIsError(null);
    void (async () => {
      try {
        if (exportFormat === 'wav') {
          const saved = await api.invoke('file:save-wav', masterOutputPath) as string | null;
          if (saved) { setLastExportAsIsPath(saved); setExportAsIsPhase('done'); }
          else setExportAsIsPhase('idle');
        } else {
          // Container change only — preserve the master's quality.
          const req: SaveAudioRequest = {
            sourcePath: masterOutputPath,
            format: exportFormat,
            sampleRate: baseOptions.sampleRate,
            bitDepth: baseOptions.bitDepth,
            dither: 'none',
            suggestedName,
          };
          const resp = await api.invoke('file:save-audio', req) as SaveAudioResponse;
          if (resp.error) { setExportAsIsPhase('error'); setExportAsIsError(resp.error); return; }
          if (resp.savedPath) { setLastExportAsIsPath(resp.savedPath); setExportAsIsPhase('done'); }
          else setExportAsIsPhase('idle');
        }
      } catch (err) {
        setExportAsIsPhase('error');
        setExportAsIsError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [masterOutputPath, exportFormat, baseOptions, suggestedName]);

  // Create a new revision — full master with the current edit settings.
  // Flag OFF (default): the proven Python `audio:master`.
  // Flag ON: the experimental Rust offline render (same chain as preview),
  // which the main process falls back to Python on any failure.
  const onCreateRevision = useCallback(() => {
    const api = window.electronAPI;
    if (!api) { setCreateRevisionError('electronAPI unavailable'); return; }
    const options = mergeOptions(baseOptions, exportOverride.optionsOverride);
    const sourceFileName = sourceAudioPath.split(/[\\/]/).pop() ?? 'master';
    const useRust = isRustOfflineRenderEnabled();
    setCreatingRevision(true);
    setCreateRevisionError(null);
    const t0 = Date.now();
    void (async () => {
      try {
        let outputPath: string | undefined;
        let previewPath: string | undefined;
        let integratedLufs = options.targetLufs;
        let truePeakDbtp = options.targetTp;
        let backend: 'rust' | 'python' = 'python';
        let fallbackUsed = false;

        if (useRust) {
          const resp = await api.invoke('audio:master-rust-experimental', {
            sourcePath: sourceAudioPath,
            chainConfig: stateToChainConfig(state),
            options,
          }) as {
            ok: boolean; backend?: 'rust' | 'python'; fallbackUsed?: boolean;
            outputPath?: string; previewPath?: string; error?: string;
            metrics?: {
              integratedLufs?: number; truePeakDbtp?: number; samplePeakDb?: number;
              finalLufs?: number; finalTruePeakDb?: number;
            };
          } | undefined;
          if (!resp?.ok || !resp.outputPath || !resp.previewPath) {
            setCreateRevisionError(resp?.error ?? 'rust render produced no output');
            return;
          }
          outputPath = resp.outputPath; previewPath = resp.previewPath;
          backend = resp.backend ?? 'rust';
          fallbackUsed = Boolean(resp.fallbackUsed);
          // Two-pass render measures real integrated LUFS + true peak.
          const m = resp.metrics ?? {};
          integratedLufs = Number(m.finalLufs ?? m.integratedLufs ?? options.targetLufs);
          truePeakDbtp = Number(m.finalTruePeakDb ?? m.truePeakDbtp ?? m.samplePeakDb ?? options.targetTp);
        } else {
          const result = await api.invoke('audio:master', sourceAudioPath, '', options) as {
            outputPath?: string; previewPath?: string;
            loudnessAfter?: { integratedLufs?: number; truePeakDbtp?: number; lra?: number };
          } | undefined;
          outputPath = result?.outputPath; previewPath = result?.previewPath;
          integratedLufs = Number(result?.loudnessAfter?.integratedLufs ?? options.targetLufs);
          truePeakDbtp = Number(result?.loudnessAfter?.truePeakDbtp ?? options.targetTp);
        }

        if (!outputPath || !previewPath) { setCreateRevisionError('master produced no output'); return; }
        const backendTag = backend === 'rust' ? ' · Rust (exp)' : (useRust && fallbackUsed ? ' · Python (fallback)' : '');
        onRevisionCreatedRef.current({
          sourceFilePath: sourceAudioPath,
          sourceFileName,
          optionsSnapshot: options as unknown as StoreMasteringOptions,
          ...(presetId ? { presetId } : {}),
          outputPath,
          previewPath,
          metrics: { integratedLufs, truePeakDbtp },
          formatSummary: `${(options.sampleRate / 1000)} kHz · ${options.bitDepth}-bit${backendTag}`,
          renderDurationMs: Date.now() - t0,
        });
      } catch (err) {
        setCreateRevisionError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreatingRevision(false);
      }
    })();
  }, [baseOptions, exportOverride, sourceAudioPath, presetId, state]);

  const bridge: PreviewBridge = {
    summary, phase, lastRenderedAt, error, onUpdate,
    exportPhase, exportError, lastExportPath, hasUnpreviewedChanges, onReMasterExport,
    exportAsIsAvailable: Boolean(masterOutputPath),
    exportAsIsPhase, exportAsIsError, lastExportAsIsPath, onExportAsIs,
    exportOverride, qualityLabel,
    exportFormat, transcodeRequired, ditherIgnored,
    creatingRevision, createRevisionError, onCreateRevision,
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

// ── Revision (version) stack slot (M3-REVISION-WORKFLOW) ───────────────
//
// Reads the bridge (create) + store (group + actions).  Rendered inside
// the preview provider so it can trigger a full re-master.
function RevisionStackHost(props: {
  presetId?: string;
  onLoadSettings: (revisionId: string) => void;
}) {
  const bridge = usePreviewBridge();
  const group = useAudioStore((s) => s.revisionGroup);
  const setActive = useAudioStore((s) => s.setActiveRevision);
  const remove = useAudioStore((s) => s.removeRevision);
  const rename = useAudioStore((s) => s.renameRevision);
  const toggleFav = useAudioStore((s) => s.toggleRevisionFavorite);
  if (!bridge) return null;

  const saveCopy = (srcPath: string) => { void window.electronAPI?.invoke('file:save-wav', srcPath); };
  const revFor = (id: string) => group?.revisions.find((r) => r.id === id);

  // No group yet = source-preview mode → empty stack with the create CTA.
  return (
    <LouiRevisionStack
      revisions={group?.revisions ?? []}
      activeId={group?.activeRevisionId ?? ''}
      creating={bridge.creatingRevision}
      createError={bridge.createRevisionError}
      experimental={isRustOfflineRenderEnabled()}
      presetNameFor={(id) => getPreset(id)?.displayName ?? id}
      onCreateRevision={bridge.onCreateRevision}
      onSelect={setActive}
      onSaveWav={(id) => { const r = revFor(id); if (r) saveCopy(r.outputPath); }}
      onSaveFormat={(id) => { const r = revFor(id); if (r) saveCopy(r.previewPath); }}
      onRename={rename}
      onDelete={remove}
      onToggleFavorite={toggleFav}
      onLoadSettings={props.onLoadSettings}
    />
  );
}

// ── A/B compare slot (M3-O-NEXT-7) ─────────────────────────────────────

interface ABSlotProps {
  mode: ABMode;
  available: boolean;
  onToggle: (mode: ABMode) => void;
  compensated: boolean;
  onToggleCompensation: (on: boolean) => void;
  loudnessDeltaLu: number | null;
}

/** Wires the global "B" shortcut + renders the A/B toggle. */
function ABCompareSlot(props: ABSlotProps) {
  useABShortcut(props.mode, props.available, props.onToggle);
  return (
    <LouiABCompare
      mode={props.mode}
      available={props.available}
      onToggle={props.onToggle}
      compensated={props.compensated}
      onToggleCompensation={props.onToggleCompensation}
      loudnessDeltaLu={props.loudnessDeltaLu}
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
  // Revision workflow (M3-REVISION-WORKFLOW)
  const revisionGroup   = useAudioStore((s) => s.revisionGroup);
  const addRevision     = useAudioStore((s) => s.addRevision);
  const setActiveRevision = useAudioStore((s) => s.setActiveRevision);
  const clearRevisions = useAudioStore((s) => s.clearRevisions);

  // Keep the revision group bound to the CURRENT source — clear stale
  // revisions when the user opens a different file (source-preview / tweak).
  React.useEffect(() => {
    const g = useAudioStore.getState().revisionGroup;
    if (g && sourceAudioPath && g.sourceFilePath !== sourceAudioPath) clearRevisions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAudioPath]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [meterReady, setMeterReady] = useState(false);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [selectedModule, setSelectedModule] = useState<ModuleCardDef['id'] | undefined>(undefined);
  // Preview source override — set when a re-render swaps the preview file.
  const [previewSrcOverride, setPreviewSrcOverride] = useState<string | null>(null);
  // Before/After compare (M3-O-NEXT-7) — real preview source swap.
  const [abMode, setAbMode] = useState<ABMode>('after');
  const [reRenderedLufs, setReRenderedLufs] = useState<number | null>(null);
  const [compensated, setCompensated] = useState(true);
  const dispatcher = useMemo(() => new PresetPatchDispatcher(ALL_MODULE_PARAMETER_DEFS), []);

  // Normalise the store options + seed the parameter state from the base
  // master so renderable params start matching the preview (no false
  // pending at load).
  const normalisedBase = useMemo(() => normaliseOptions(baseOptions), [baseOptions]);
  const initialParamState = useMemo(
    () => initialStateFromBaseOptions(normalisedBase),
    [normalisedBase],
  );

  // ── Revision-aware preview sources ───────────────────────────────────
  // Revision 1 (baseline) is "A"; the active revision is "B".  When the
  // user runs a quick "Update Preview", that override transiently becomes
  // "B" for the edited settings.  Falls back to the single masteringResult
  // when no revision group exists yet (pre-seed / storybook).
  const activeRevision   = getActiveRevision(revisionGroup);
  const baselineRevision = getBaselineRevision(revisionGroup);
  const baselinePreview = baselineRevision?.previewPath ?? masteringResult?.previewPath ?? '';
  const activePreview   = activeRevision?.previewPath ?? masteringResult?.previewPath ?? '';

  // Source-preview mode (UX-FLOW-NEXT-1): with no master result yet, play
  // the ORIGINAL file so the user can listen + tweak before rendering.
  const sourcePreviewSrc = sourceAudioPath ? toFileUrl(sourceAudioPath) : '';
  const hasResult = Boolean(baselineRevision) || Boolean(masteringResult?.outputPath);

  const basePreviewSrc = baselinePreview ? toFileUrl(baselinePreview) : sourcePreviewSrc;
  const activeIsNotBaseline = Boolean(activeRevision && baselineRevision && activeRevision.id !== baselineRevision.id);
  // "B" = a fresh quick-render override if present, else the active
  // revision's preview when it differs from the baseline.
  const reRenderedSrc = previewSrcOverride
    ?? (activeIsNotBaseline ? toFileUrl(activePreview) : null);
  const effectiveSrc = abMode === 'before' ? basePreviewSrc : (reRenderedSrc ?? basePreviewSrc);
  const abAvailable = Boolean(reRenderedSrc);

  const baseLufs = baselineRevision?.metrics.integratedLufs
    ?? (typeof masteringResult?.loudnessAfter?.integratedLufs === 'number' ? masteringResult.loudnessAfter.integratedLufs : null);
  // "After" loudness: the quick-render value when overriding, else the
  // active revision's measured loudness.
  const afterLufs = previewSrcOverride !== null
    ? reRenderedLufs
    : (activeIsNotBaseline ? activeRevision!.metrics.integratedLufs : null);
  const loudnessDeltaLu = (afterLufs !== null && baseLufs !== null) ? afterLufs - baseLufs : null;

  // Export As-is target — the active revision's master WAV.
  const activeOutputPath = activeRevision?.outputPath ?? masteringResult?.outputPath ?? null;

  // Seed Revision 1 from the initial master once it's available for this
  // source (migrates the legacy single masteringResult into the group).
  const seededRef = useRef<string | null>(null);
  React.useEffect(() => {
    if (!masteringResult?.outputPath || !masteringResult.previewPath || !sourceAudioPath) return;
    const key = `${sourceAudioPath}::${masteringResult.outputPath}`;
    if (seededRef.current === key) return;
    const alreadyInGroup = revisionGroup
      && revisionGroup.sourceFilePath === sourceAudioPath
      && revisionGroup.revisions.some((r) => r.outputPath === masteringResult.outputPath);
    if (alreadyInGroup) { seededRef.current = key; return; }
    if (revisionGroup && revisionGroup.sourceFilePath === sourceAudioPath) { seededRef.current = key; return; }
    seededRef.current = key;
    const after = masteringResult.loudnessAfter;
    addRevision({
      sourceFilePath: sourceAudioPath,
      sourceFileName: sourceAudioPath.split(/[\\/]/).pop() ?? 'master',
      optionsSnapshot: normalisedBase as unknown as StoreMasteringOptions,
      ...(presetId ? { presetId } : {}),
      outputPath: masteringResult.outputPath,
      previewPath: masteringResult.previewPath,
      metrics: {
        integratedLufs: Number(after?.integratedLufs ?? normalisedBase.targetLufs),
        truePeakDbtp: Number(after?.truePeakDbtp ?? normalisedBase.targetTp),
        ...(typeof after?.lra === 'number' ? { lra: after.lra } : {}),
      },
      formatSummary: `${normalisedBase.sampleRate / 1000} kHz · ${normalisedBase.bitDepth}-bit`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masteringResult, sourceAudioPath]);

  // When the active revision changes, hear it cleanly: drop any stale
  // quick-preview override and show it as "After".
  const activeRevId = activeRevision?.id;
  const prevActiveRef = useRef<string | undefined>(activeRevId);
  React.useEffect(() => {
    if (prevActiveRef.current === activeRevId) return;
    prevActiveRef.current = activeRevId;
    restorePositionOnLoad();
    setPreviewSrcOverride(null);
    setAbMode('after');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRevId]);
  const meta = masteringResult?.analysisReport?.mastering;
  const targetLufs = typeof meta?.targetLufs === 'number' ? meta.targetLufs : -14;
  const targetTp   = typeof meta?.targetTruePeak === 'number' ? meta.targetTruePeak : -1;

  // Capture playback position + play state, restore after the next
  // `loadedmetadata` (used after every src change so swaps are seamless).
  const restorePositionOnLoad = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.currentTime;
    const wasPlaying = !a.paused;
    const restore = () => {
      try { a.currentTime = t; } catch { /* duration may differ slightly */ }
      if (wasPlaying) void a.play();
      a.removeEventListener('loadedmetadata', restore);
    };
    a.addEventListener('loadedmetadata', restore);
  }, []);

  // A re-render produced a new preview — swap to it (After) + capture its
  // measured loudness for A/B compensation.
  const onPreviewRendered = useCallback((newPreviewPath: string, integratedLufs?: number) => {
    restorePositionOnLoad();
    if (typeof integratedLufs === 'number') setReRenderedLufs(integratedLufs);
    setPreviewSrcOverride(toFileUrl(newPreviewPath));
    setAbMode('after');
  }, [restorePositionOnLoad]);

  // Before/After toggle — flips the effective source (real swap).
  const onABToggle = useCallback((mode: ABMode) => {
    restorePositionOnLoad();
    setAbMode(mode);
  }, [restorePositionOnLoad]);

  // Loudness-compensated comparison — trim the louder side down to the
  // quieter reference so A/B reflects TONE, not loudness.
  React.useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!compensated || afterLufs === null || baseLufs === null) { a.volume = 1; return; }
    const ref = Math.min(baseLufs, afterLufs);
    const cur = abMode === 'before' ? baseLufs : afterLufs;
    const trimDb = Math.max(0, cur - ref);
    a.volume = Math.pow(10, -trimDb / 20);
  }, [compensated, abMode, afterLufs, baseLufs]);

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
  // Back to the start screen — keeps queue + revisions (no clear).
  const onBack = useCallback(() => { setPage('home'); }, [setPage]);
  const onExport = useCallback(async () => {
    if (!activeOutputPath) return;
    await window.electronAPI?.invoke('file:save-wav', activeOutputPath);
  }, [activeOutputPath]);
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
        src={effectiveSrc || undefined}
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
          onBack={onBack}
          onImport={onImport}
          onExport={onExport}
          onSettings={onSettings}
          ab={{
            mode: abMode,
            available: abAvailable,
            onToggle: onABToggle,
            compensated,
            onToggleCompensation: setCompensated,
            loudnessDeltaLu,
          }}
          {...(sourceAudioPath ? {
            preview: {
              sourceAudioPath,
              baseOptions: normalisedBase,
              masterOutputPath: activeOutputPath,
              onRendered: onPreviewRendered,
              ...(presetId ? { presetId } : {}),
              onRevisionCreated: addRevision,
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
  onBack?: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  ab: ABSlotProps;
  preview?: {
    sourceAudioPath: string;
    baseOptions: MasteringOptions;
    masterOutputPath: string | null;
    onRendered: (previewPath: string, integratedLufs?: number) => void;
    presetId?: string;
    onRevisionCreated: (input: RevisionInput) => void;
  };
}) {
  const session = useWasmAnalyzerSession();
  // Realtime mastering preview — flag-gated + readiness-gated.  No-op
  // (and renders nothing) when the flag is OFF, which is the default.
  const realtime = useRealtimeMasteringGraph(session, { sampleRate: 48000, channels: 2 });

  // Realtime gain reduction (Limiter/Maximizer) — REAL limiterGrDb from the
  // worklet metrics, with a decaying peak hold.  Available only while the
  // realtime preview is active; otherwise "unavailable" (never faked).
  const grAvailable = realtime.enabled && realtime.active;
  const grDb = grAvailable ? Math.max(0, realtime.metrics.limiterGrDb) : 0;
  const [grPeak, setGrPeak] = useState(0);
  React.useEffect(() => {
    if (!grAvailable) { setGrPeak(0); return; }
    // Decays per metrics frame (data-driven; no free-running RAF).
    setGrPeak((prev) => decayPeak(prev, grDb, 0.4));
  }, [grDb, grAvailable]);
  const grValue = useMemo(
    () => ({ grDb, peakDb: grPeak, available: grAvailable, source: grAvailable ? ('realtime' as const) : ('unavailable' as const) }),
    [grDb, grPeak, grAvailable],
  );
  // Realtime preview status for module badges ("Heard live" vs "Staged").
  const realtimePreviewValue = useMemo(
    () => ({ enabled: realtime.enabled, active: realtime.active }),
    [realtime.enabled, realtime.active],
  );

  // Preset selection → apply the preset's full DSP tuning to the central
  // parameter state.  This updates the realtime preview config (no graph
  // rebuild — the same worklet node receives a new config) and stages the
  // renderable params for export, keeping preview/export consistent.
  const applyPreset = useApplyPreset();
  const [presetBrowserOpen, setPresetBrowserOpen] = useState(false);
  const [previousPresetId, setPreviousPresetId] = useState<string | undefined>(undefined);
  // Last-used is a badge hint only — it does NOT auto-apply on load (the
  // master is already rendered); the user re-applies by selecting.
  const [lastUsedId] = useState<string | undefined>(() => getLastUsedPreset() ?? undefined);

  const handlePreset = useCallback((id: string) => {
    setPreviousPresetId(props.presetId);
    props.onPresetChange(id);
    const preset = getPreset(id);
    if (!preset) return;
    applyPreset(presetApplyPlan(preset), { presetId: id, presetName: preset.displayName });
    setLastUsedPreset(id);
  }, [applyPreset, props]);

  // Load a revision's settings back into the editor (then the user can
  // tweak + make a new version).  Restores the master options; if the
  // revision carried a preset, re-applies it to the parameter state.
  const updateOptions = useAudioStore((s) => s.updateOptions);
  const revisionGroup = useAudioStore((s) => s.revisionGroup);
  const onLoadRevisionSettings = useCallback((revisionId: string) => {
    const rev = revisionGroup?.revisions.find((r) => r.id === revisionId);
    if (!rev) return;
    updateOptions(rev.optionsSnapshot);
    if (rev.presetId) {
      const preset = getPreset(rev.presetId);
      if (preset) {
        props.onPresetChange(rev.presetId);
        applyPreset(presetApplyPlan(preset), { presetId: rev.presetId, presetName: preset.displayName });
      }
    }
  }, [revisionGroup, updateOptions, applyPreset, props]);

  const layout = (
    <ProductLayoutInner
      session={session}
      active={props.isPlaying}
      sampleRate={48000}
      channels={2}
      targetLufs={props.targetLufs}
      targetTp={props.targetTp}
      {...(props.presetId ? { presetId: props.presetId } : {})}
      onPresetChange={handlePreset}
      onBrowsePresets={() => setPresetBrowserOpen(true)}
      {...(props.selectedModule ? { selectedModule: props.selectedModule } : {})}
      onSelectModule={props.onSelectModule}
      isPlaying={props.isPlaying}
      onPlayPause={props.onPlayPause}
      progress={props.progress}
      currentTimeLabel={props.currentTimeLabel}
      durationLabel={props.durationLabel}
      onSeek={props.onSeek}
      {...(props.onBack ? { onBack: props.onBack } : {})}
      onImport={props.onImport}
      onExport={props.onExport}
      onSettings={props.onSettings}
      abControl={<ABCompareSlot {...props.ab} />}
      {...(props.preview ? { previewSlot: <PreviewSlotFromBridge /> } : {})}
      {...(props.preview ? { revisionSlot: <RevisionStackHost {...(props.presetId ? { presetId: props.presetId } : {})} onLoadSettings={onLoadRevisionSettings} /> } : {})}
      moduleSuiteSlot={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <LouiRealtimeStatus
              status={realtime.uiStatus}
              enabled={realtime.enabled}
              active={realtime.active}
              readinessLabel={realtime.readinessLabel}
            />
            <LouiRealtimeToggle
              enabled={realtime.enabled}
              ready={realtime.readiness.ready}
              readinessLabel={realtime.readinessLabel}
              onToggle={(next) => {
                setRealtimePreviewEnabled(next);
                if (typeof window !== 'undefined') window.location.reload();
              }}
            />
          </div>
          <LouiModuleChain
            moduleIds={CHAIN_MODULE_IDS as string[]}
            {...(props.selectedModule ? { activeId: props.selectedModule } : {})}
            onSelect={(id) => {
              const mod = getModule(id);
              // Live/preview modules with a real panel open it; planned are inert.
              if (mod?.paramModuleId && mod.status !== 'planned') props.onSelectModule(mod.paramModuleId);
            }}
          />
        </div>
      }
    />
  );
  // Dev/QA realtime-preview health overlay — only when the flag is ON.
  const debugOverlay = realtime.enabled ? (
    <div style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 9999 }}>
      <LouiRealtimeDebugPanel
        active={realtime.active}
        uiStatus={realtime.uiStatus}
        readiness={realtime.readinessLabel}
        metrics={realtime.metrics}
        configUpdates={realtime.configUpdates}
        lastConfigAt={realtime.lastConfigAt}
        {...(realtime.config ? { config: {
          imgWidthPct: realtime.config.imgWidthPct,
          eqPresenceDb: realtime.config.eqPresenceDb,
          eqAirDb: realtime.config.eqAirDb,
          dynThresholdDb: realtime.config.dynThresholdDb,
          dynRatio: realtime.config.dynRatio,
        } } : {})}
        {...(realtime.graphState?.fallbackReason ? { fallbackReason: realtime.graphState.fallbackReason } : {})}
        {...(session?.audioContext()?.state ? { contextState: session.audioContext()!.state } : {})}
        sampleRate={48000}
        bufferSize={128}
        wasmLoad={realtime.graphState?.load}
      />
    </div>
  ) : null;

  const presetBrowser = (
    <LouiPresetSlideOver
      open={presetBrowserOpen}
      onClose={() => setPresetBrowserOpen(false)}
      recommendedId={DEFAULT_PRESET_ID}
      {...(props.presetId ? { activeId: props.presetId } : {})}
      {...(previousPresetId ? { previousId: previousPresetId } : {})}
      {...(lastUsedId ? { lastUsedId } : {})}
      onSelect={handlePreset}
    />
  );

  if (!props.preview) {
    return (
      <RealtimePreviewProvider value={realtimePreviewValue}>
        <RealtimeGrProvider value={grValue}>{layout}{debugOverlay}{presetBrowser}</RealtimeGrProvider>
      </RealtimePreviewProvider>
    );
  }
  return (
    <RealtimePreviewProvider value={realtimePreviewValue}>
      <RealtimeGrProvider value={grValue}>
        <ProductionPreviewProvider
          sourceAudioPath={props.preview.sourceAudioPath}
          baseOptions={props.preview.baseOptions}
          masterOutputPath={props.preview.masterOutputPath}
          onRendered={props.preview.onRendered}
          {...(props.preview.presetId ? { presetId: props.preview.presetId } : {})}
          onRevisionCreated={props.preview.onRevisionCreated}
        >
          {layout}
          {debugOverlay}
          {presetBrowser}
        </ProductionPreviewProvider>
      </RealtimeGrProvider>
    </RealtimePreviewProvider>
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
