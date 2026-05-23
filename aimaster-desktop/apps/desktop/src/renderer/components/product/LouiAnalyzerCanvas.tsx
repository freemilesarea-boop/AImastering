// LouiAnalyzerCanvas — main analyzer surface (spectrum centre-piece).
//
// Wraps `<SpectrumAnalyzerPanel>` in a Loui-themed panel chrome:
//   • Panel header with title and a "live" pulse indicator
//   • Inner padding sized to `loui-theme.space.3`
//   • Bottom legend strip with axis labels
//
// The wrapped panel still owns the canvas + RAF loop — we only style
// the chrome around it.

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';
import type { AnalyzerSession } from '@aimaster/shared-types/streaming';
import { isLiveVisualizerEnabled } from '../../audio/live-visualizer-flag.js';
import { useAnalyzerSubscriptions } from '../../hooks/useAnalyzerSubscriptions.js';
import { useFrameLiveness } from '../../hooks/useFrameLiveness.js';
import { fftFrameToSpectrum } from '../../audio/modules/analyzer-to-visualizer-adapter.js';
import { SpectrumWaveformCanvas } from './modules/SpectrumWaveformCanvas.js';
import { type EqBands } from './modules/EQCurveOverlay.js';
import { DraggableEQCurveEditor } from './modules/DraggableEQCurveEditor.js';
import { hasParameterStateProvider, useModuleParameters } from '../../audio/parameters/useModuleParameterState.js';
import { useMediaElement } from '../../audio/media-element-context.js';
import { useNativeAnalyzer, type NativeAnalyzerState } from '../../hooks/useNativeAnalyzer.js';
import { NativeSpectrumCanvas } from './modules/NativeSpectrumCanvas.js';
import { sharedContextState } from '../../audio/shared-audio-graph.js';

export interface LouiAnalyzerCanvasProps {
  /** Live analyzer session — passed through to SpectrumAnalyzerPanel. */
  session?: AnalyzerSession | null;
  /** Whether the engine is actively producing frames (drives the pulse dot). */
  active?: boolean;
}

function LivePulse({ active }: { active: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: active ? meter.safe.foreground : surface.overlay,
          boxShadow: active ? `0 0 6px ${meter.safe.foreground}` : 'none',
          transition: 'background 120ms ease-out, box-shadow 120ms ease-out',
        }}
      />
      <span
        style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: active ? meter.safe.foreground : text.muted,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {active ? 'live' : 'idle'}
      </span>
    </span>
  );
}

export function LouiAnalyzerCanvas(props: LouiAnalyzerCanvasProps) {
  // Native (WASM-free) analyzer — always available the moment an element is
  // mounted, so the spectrum is never blank.  Shared with the body below.
  const media = useMediaElement();
  const native = useNativeAnalyzer(media);
  // Honest LIVE: real FFT frame arrival (WASM) OR native audio movement.
  const liveness = useFrameLiveness(props.session ?? null);
  const nativeLive = native.lastFrameAt != null && (performance.now() - native.lastFrameAt) < 500;
  const active = liveness.live || nativeLive;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
        background: surface.panel,
        border: `1px solid ${surface.border}`,
        borderRadius: radius.panel,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        title="주파수 스펙트럼. 재생 중인 (처리 후) 신호의 저역·중역·고역 에너지를 실시간으로 표시합니다. 20Hz~20kHz 로그 스케일."
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: space['4'],
          paddingBlock: space['3'],
          borderBottom: `1px solid ${surface.border}`,
          cursor: 'help',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: space['3'] }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.md,
            fontWeight: typography.weight.semi,
            color: text.primary,
            letterSpacing: '-0.005em',
          }}>
            Spectrum
          </span>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            Live FFT · 1/3-oct
          </span>
        </div>
        <LivePulse active={active} />
      </div>

      {/* Canvas body — spectrum fills the remaining space.  The panel sets
          its own height via the canvas; we frame it with consistent padding.
          A subtle radial depth wash behind the trace gives the analyzer a
          centre-stage, product-grade feel (CSS only — no CPU cost). */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          padding: space['3'],
          display: 'flex',
          flexDirection: 'column',
          background: active
            ? 'radial-gradient(120% 90% at 50% 100%, rgba(167,139,250,0.06), transparent 70%)'
            : 'transparent',
          transition: 'background 200ms ease-out',
        }}
      >
        {/* The native spectrum is the always-on base layer (never blank).
            The richer WASM 1/3-oct trace + EQ overlay layer on top when the
            WASM analyzer is producing frames.  If the WASM layer throws, the
            boundary falls back to the native-only body. */}
        <VisualizerBoundary fallback={<NativeSpectrumBody native={native} />}>
          {isLiveVisualizerEnabled()
            ? <LiveSpectrumBody session={props.session ?? null} native={native} />
            : <NativeSpectrumBody native={native} />}
        </VisualizerBoundary>
      </div>

      {/* Footer legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: space['4'],
          paddingBlock: space['2'],
          borderTop: `1px solid ${surface.border}`,
          background: surface.well,
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.04em',
        }}
      >
        <span>20 Hz · 100 · 1 k · 10 k · 20 kHz</span>
        <span>−90 dB → 0 dB</span>
      </div>
    </div>
  );
}

// ── Live FFT visualizer body (OZONE-MODULE-NEXT-1) ─────────────────────

function useSize(): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Reads EQ parameter state → an approximate curve overlay.  Only rendered
 *  when a parameter-state provider is present (guards storybook usage). */
function EqOverlayFromState({ width, height }: { width: number; height: number }) {
  const eq = useModuleParameters('eq');
  const n = (id: string, d: number): number => {
    const v = eq.get(id);
    return typeof v === 'number' ? v : d;
  };
  const bands: EqBands = {
    lowCutHz: n('lowCutHz', 20),
    lowShelfDb: n('lowShelfDb', 0),
    presenceDb: n('presenceDb', 0),
    airDb: n('airDb', 0),
    outputGainDb: n('outputGainDb', 0),
  };
  // Draggable: writes go to the parameter state (clamped/quantised/logged),
  // which flows LIVE to the Rust chain via the rAF → updateConfig path.
  return (
    <DraggableEQCurveEditor
      width={width}
      height={height}
      bands={bands}
      {...(eq.bypass ? { bypassed: true } : {})}
      onChange={(paramId, value) => eq.setParam(paramId, value)}
    />
  );
}

/** Small honest status chip in the analyzer corner — always shows what is
 *  actually happening (analyzer source, context state, frame counts). */
function AnalyzerStatusChip({ native, wasmLive, wasmFrames }: {
  native: NativeAnalyzerState; wasmLive: boolean; wasmFrames: number;
}) {
  const ctxState = sharedContextState();
  const analyzerLabel = wasmLive ? 'WASM' : native.status === 'connected' ? 'NATIVE' : native.status === 'error' ? 'FAILED' : 'OFF';
  const tone = analyzerLabel === 'FAILED' ? meter.danger.foreground
    : analyzerLabel === 'OFF' ? text.muted : meter.safe.foreground;
  const ageMs = native.lastFrameAt != null ? Math.round(performance.now() - native.lastFrameAt) : null;
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8, zIndex: 3, pointerEvents: 'none',
      display: 'flex', gap: 8, flexWrap: 'wrap',
      fontFamily: typography.family.mono, fontSize: 10, lineHeight: '14px',
      color: text.muted, background: 'rgba(0,0,0,0.35)', border: `1px solid ${surface.border}`,
      borderRadius: 6, padding: '4px 7px', backdropFilter: 'blur(4px)',
    }}>
      <span style={{ color: tone, fontWeight: 600 }}>Analyzer: {analyzerLabel}</span>
      <span>Ctx: {ctxState}</span>
      <span>WASM frames: {wasmFrames}</span>
      <span>Native: {native.frameCount}{ageMs != null ? ` (${ageMs}ms)` : ''}</span>
      {native.error ? <span style={{ color: meter.danger.foreground }}>err: {native.error}</span> : null}
    </div>
  );
}

/** Native-only spectrum body (always-on fallback base). */
function NativeSpectrumBody({ native }: { native: NativeAnalyzerState }) {
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden', background: surface.well }}>
      <NativeSpectrumCanvas analyser={native.analysers?.main ?? null} />
      <AnalyzerStatusChip native={native} wasmLive={false} wasmFrames={0} />
      {native.status === 'no-element' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: text.muted, fontFamily: typography.family.sans, fontSize: typography.size.sm, pointerEvents: 'none',
        }}>
          음원을 불러오면 스펙트럼이 표시됩니다
        </div>
      )}
    </div>
  );
}

function LiveSpectrumBody({ session, native }: { session: AnalyzerSession | null; native: NativeAnalyzerState }) {
  const [ref, size] = useSize();
  // FFT frames arrive at the analyzer's cadence (≤30 Hz) — redraw is driven
  // by new frames only (no free-running RAF here).
  const subs = useAnalyzerSubscriptions(session, { enableFft: true });
  const spectrum = useMemo(() => fftFrameToSpectrum(subs.fft), [subs.fft]);
  const hasProvider = hasParameterStateProvider();
  const w = size.w, h = size.h;
  const wasmFrames = subs.fft?.samplesProcessed ?? 0;
  const wasmLive = !!spectrum;
  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden', background: surface.well }}>
      {/* Always-on native spectrum (base layer — guarantees visibility). */}
      <NativeSpectrumCanvas analyser={native.analysers?.main ?? null} />
      {/* WASM 1/3-oct trace overlays when frames are live. */}
      {w > 0 && h > 0 && spectrum && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <SpectrumWaveformCanvas
            width={w}
            height={h}
            binCentresHz={spectrum.binCentresHz}
            magnitudeDb={spectrum.magnitudeDb}
            {...(spectrum.peakHoldDb ? { peakHoldDb: spectrum.peakHoldDb } : {})}
          />
        </div>
      )}
      {w > 0 && h > 0 && hasProvider && <EqOverlayFromState width={w} height={h} />}
      <AnalyzerStatusChip native={native} wasmLive={wasmLive} wasmFrames={wasmFrames} />
    </div>
  );
}

/** If the live visualizer throws, fall back to the proven spectrum panel. */
class VisualizerBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) {
    // eslint-disable-next-line no-console
    console.warn('[live-visualizer] fell back to SpectrumAnalyzerPanel:', err);
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
