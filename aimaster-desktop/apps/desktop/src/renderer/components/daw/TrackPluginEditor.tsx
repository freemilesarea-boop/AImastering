// TrackPluginEditor — a plugin on a track, drawn rather than listed.
//
// The DAW's insert panel used to render `ModuleParameterPanel` alone: a
// column of sliders, correct and unreadable. You cannot see a compressor's
// knee on a number, you cannot find the hum you are notching by reading
// "120 Hz", and you cannot tell whether the de-noiser is about to eat the
// reverb tail without seeing where the profile sits against the signal.
//
// Every one of those pictures already exists in this codebase — the Studio
// has drawn them for the mastering chain all along. This is the piece that
// was missing: the mapping from a module to its view, in one place, so the
// DAW and the Studio show the same plugin the same way and neither can
// quietly drift into being the "real" editor.
//
// # The numbers stay
//
// The graph is the fast way to work and typing is the exact one, so the
// parameter panel is always rendered underneath. They edit the same values,
// so they cannot disagree — a drag moves the sliders and a typed number
// moves the curve.
//
// # What "live" means here
//
// The meters are fed from the metrics that track's own chain posts from the
// audio thread, ten times a second, through `track-metrics-store`. Nothing
// is sampled per block and nothing is invented: a track whose chain is not
// running gets `EMPTY_METRICS`, and the views draw their idle state rather
// than a confident zero.

import React, { useMemo } from 'react';
import type { ModuleId, ParameterValue } from '../../audio/parameters/index.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../audio/parameters/index.js';
import { ModuleParameterPanel } from '../product/panels/ModuleParameterPanel.js';
import { LouiEqGraph } from '../product/modules/LouiEqGraph.js';
import { LouiDynamicsGraph } from '../product/modules/LouiDynamicsGraph.js';
import { LouiFreeEqBandList } from '../product/modules/LouiFreeEqBandList.js';
import { RestorationView, RESTORATION_VIEW_MODULES } from '../product/modules/LouiRestorationViews.js';
import { ToneDynamicsView, TONE_DYN_VIEW_MODULES } from '../product/modules/LouiToneDynamicsViews.js';
import { CharacterView, CHARACTER_VIEW_MODULES } from '../product/modules/LouiCharacterViews.js';
import { buildDynamicsGraph, compressorStartingPoint } from '../../audio/modules/dynamics-graph-model.js';
import {
  buildGraphBands, bandEdits, freeBandsToGraph, makeFreeBand,
  FREE_KIND_CYCLE,
  type FreeEqBand, type GraphBand,
} from '../../audio/modules/eq-graph-model.js';
import { MAX_PARAMETRIC_BANDS } from '../../audio/chain-config.js';
import { EMPTY_METRICS, type RealtimePreviewMetrics } from '../../audio/track-metrics-store.js';

export interface TrackPluginEditorProps {
  moduleId: ModuleId;
  values: Record<string, ParameterValue>;
  bypass: boolean;
  /** This track's chain telemetry. `EMPTY_METRICS` when it is not running. */
  metrics?: RealtimePreviewMetrics;
  /** Post-plugin spectrum tap, for the trace behind an EQ curve. */
  analyser?: AudioNode | null;
  sampleRate?: number;
  /** The free EQ's bands. Only the parametric EQ uses them. */
  freeBands?: readonly FreeEqBand[];
  /** One or more parameters changed together — a drag writes several axes. */
  onChange: (patch: Record<string, ParameterValue>) => void;
  /** The free EQ's band list changed. */
  onFreeBands?: (next: FreeEqBand[]) => void;
}

/**
 * Which modules this editor can draw.
 *
 * Exported so a test can assert the DAW's picker offers nothing that would
 * land on a bare slider stack — the mapping is the deliverable, and a
 * module quietly missing from it is exactly the regression to catch.
 */
export function hasVisualEditor(moduleId: string, freeBandsAvailable = true): boolean {
  if (moduleId === 'parametric-eq') return freeBandsAvailable;
  if (buildGraphBands(moduleId, {}) !== null) return true;
  if (buildDynamicsGraph(moduleId, {}) !== null) return true;
  return RESTORATION_VIEW_MODULES.has(moduleId)
    || TONE_DYN_VIEW_MODULES.has(moduleId)
    || CHARACTER_VIEW_MODULES.has(moduleId);
}

export function TrackPluginEditor(props: TrackPluginEditorProps): React.ReactElement {
  const {
    moduleId, values, bypass, onChange, onFreeBands,
  } = props;
  const metrics = props.metrics ?? EMPTY_METRICS;
  const freeBands = props.freeBands ?? [];
  const isFreeEq = moduleId === 'parametric-eq';

  // ── EQ ──────────────────────────────────────────────────────────────────
  const graphBands: GraphBand[] | null = isFreeEq
    ? freeBandsToGraph(freeBands)
    : buildGraphBands(moduleId, values);

  const handleBandChange = React.useCallback((
    band: GraphBand,
    next: { hz?: number; gainDb?: number; q?: number },
  ) => {
    if (band.free) {
      if (!onFreeBands) return;
      onFreeBands(freeBands.map((b) => (b.id !== band.id ? b : {
        ...b,
        ...(next.hz !== undefined ? { frequencyHz: clamp(next.hz, 20, 20_000) } : {}),
        ...(next.gainDb !== undefined ? { gainDb: clamp(next.gainDb, -30, 30) } : {}),
        ...(next.q !== undefined ? { q: clamp(next.q, 0.1, 18) } : {}),
      })));
      return;
    }
    // A fixed module's node is a set of parameters. They are written
    // together: a drag moves frequency and gain in the same gesture, and
    // saving them one at a time would make the second write overwrite a
    // stale copy of the first.
    const patch: Record<string, ParameterValue> = {};
    for (const [param, v] of bandEdits(band, next)) patch[param] = v;
    if (Object.keys(patch).length > 0) onChange(patch);
  }, [onChange, onFreeBands, freeBands]);

  const freeGestures = useMemo(() => (onFreeBands ? {
    onAdd: (hz: number, gainDb: number) => {
      if (freeBands.length >= MAX_PARAMETRIC_BANDS) return;
      onFreeBands([...freeBands, makeFreeBand(hz, gainDb)]);
    },
    onRemove: (id: string) => onFreeBands(freeBands.filter((b) => b.id !== id)),
    onCycleType: (id: string) => onFreeBands(freeBands.map((b) => {
      if (b.id !== id) return b;
      const i = FREE_KIND_CYCLE.indexOf(b.kind as (typeof FREE_KIND_CYCLE)[number]);
      return { ...b, kind: FREE_KIND_CYCLE[(i + 1) % FREE_KIND_CYCLE.length]! };
    })),
    atCapacity: freeBands.length >= MAX_PARAMETRIC_BANDS,
  } : undefined), [onFreeBands, freeBands]);

  const patchFreeBand = React.useCallback((id: string, patch: Partial<FreeEqBand>) => {
    if (!onFreeBands) return;
    onFreeBands(freeBands.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, [onFreeBands, freeBands]);

  // ── Dynamics ────────────────────────────────────────────────────────────
  const dynamicsSpec = buildDynamicsGraph(moduleId, values);
  const reductionDb = useMemo(() => {
    if (!dynamicsSpec) return [];
    if (dynamicsSpec.kind === 'multiband') return metrics.multibandGrDb;
    // The vari-mu has no meter of its own in the chain, and printing "0.0"
    // would be a claim rather than a reading.
    if (dynamicsSpec.kind === 'vintage-comp') return [0];
    return [metrics.dynamicsGrDb];
  }, [dynamicsSpec, metrics]);

  const visual = renderVisual();

  function renderVisual(): React.ReactNode {
    if (graphBands) {
      return (
        <div className="flex flex-col gap-2">
          <LouiEqGraph
            bands={graphBands}
            disabled={bypass}
            onBandChange={handleBandChange}
            analyser={(props.analyser as AnalyserNode | null | undefined) ?? null}
            {...(props.sampleRate !== undefined ? { sampleRate: props.sampleRate } : {})}
            {...(isFreeEq && freeGestures ? { free: freeGestures } : {})}
          />
          {isFreeEq && freeGestures && (
            <LouiFreeEqBandList
              bands={freeBands}
              disabled={bypass}
              onChange={patchFreeBand}
              onRemove={freeGestures.onRemove}
              onAdd={() => freeGestures.onAdd(1000, 0)}
              atCapacity={freeGestures.atCapacity}
            />
          )}
        </div>
      );
    }
    if (dynamicsSpec) {
      return (
        <LouiDynamicsGraph
          spec={dynamicsSpec}
          reductionDb={reductionDb}
          live={metrics.running && !metrics.bypass}
          disabled={bypass}
          onSetUp={() => {
            const patch: Record<string, ParameterValue> = {};
            for (const [param, v] of compressorStartingPoint(moduleId)) patch[param] = v;
            onChange(patch);
          }}
        />
      );
    }
    if (RESTORATION_VIEW_MODULES.has(moduleId)) {
      return <RestorationView moduleId={moduleId} values={values} metrics={metrics} disabled={bypass} />;
    }
    if (TONE_DYN_VIEW_MODULES.has(moduleId)) {
      return <ToneDynamicsView moduleId={moduleId} values={values} metrics={metrics} disabled={bypass} />;
    }
    if (CHARACTER_VIEW_MODULES.has(moduleId)) {
      return <CharacterView moduleId={moduleId} values={values} metrics={metrics} disabled={bypass} />;
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-3" data-plugin-editor={moduleId}>
      {visual && <div data-plugin-visual={moduleId}>{visual}</div>}
      {STFT_MODULES.has(moduleId) && (
        <p className="text-[10px] leading-relaxed text-amber-500/80">
          이 모듈은 STFT 기반이라 켜면 지연이 추가됩니다 (2048 샘플 ≈ 43 ms @ 48 kHz).
          믹스다운에서는 자동 보정되지만 실시간 모니터링에서는 그만큼 늦게 들립니다.
        </p>
      )}
      <ModuleParameterPanel
        moduleId={moduleId}
        def={ALL_MODULE_PARAMETER_DEFS[moduleId]}
        values={values}
        bypass={bypass}
        onChange={(pid, v) => onChange({ [pid]: v })}
      />
    </div>
  );
}

/** Modules whose latency the user has to be told about before they wonder. */
const STFT_MODULES = new Set<string>([
  'denoise', 'match-eq', 'spectral-shaper', 'hiss-gate', 'stabilizer', 'top-rebuild',
]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}
