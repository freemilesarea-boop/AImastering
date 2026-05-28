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
import { DualSpectrumBody } from './modules/DualSpectrumBody.js';
import { DraggableParametricEqEditor } from './modules/DraggableParametricEqEditor.js';
import type { ParametricEqBand } from '../../audio/modules/parametric-eq-model.js';
import { sharedContextState } from '../../audio/shared-audio-graph.js';

export interface LouiAnalyzerCanvasProps {
  /** Live analyzer session — passed through to SpectrumAnalyzerPanel. */
  session?: AnalyzerSession | null;
  /** Whether the engine is actively producing frames (drives the pulse dot). */
  active?: boolean;
  /** A/B compare mode — when set, the spectrum shows a ghost of the other side. */
  abMode?: 'before' | 'after';
  /**
   * When set, render two stacked spectrum canvases (PRE on top, POST on bottom).
   * `secondaryAnalyser` is the AnalyserNode for the PRE side (typically the
   * source file via a muted hidden audio element).  null = no analyser yet.
   */
  duoMode?: boolean;
  duoSecondaryAnalyser?: AnalyserNode | null;
  duoSecondaryStatus?: 'idle' | 'connected' | 'error';
  /** Optional toggle handler — when provided, renders a "PRE/POST" button in the header. */
  onToggleDuoMode?: () => void;
  /**
   * Free parametric EQ overlay (Phase 1).  When set, renders an interactive
   * curve + draggable dots over the spectrum.  Audio adoption arrives in
   * Phase 2 — this overlay is currently preview-only.
   */
  freeEqBands?: ParametricEqBand[];
  onFreeEqChange?: (bands: ParametricEqBand[]) => void;
  freeEqEnabled?: boolean;
  onToggleFreeEq?: () => void;
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
  const abMode = props.abMode;
  const duoMode = props.duoMode === true;
  const freeEqEnabled = props.freeEqEnabled === true;
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {props.onToggleFreeEq && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); props.onToggleFreeEq?.(); }}
              title={freeEqEnabled
                ? '자유 파라메트릭 EQ 끄기'
                : '자유 파라메트릭 EQ — 스펙트럼 위에 노드를 추가/드래그/삭제 (Phase 1: 미리보기만, 오디오 미적용)'}
              className="no-drag"
              style={{
                fontFamily: typography.family.mono, fontSize: 9, letterSpacing: '0.06em',
                border: `1px solid ${freeEqEnabled ? meter.warn.foreground : surface.border}`,
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                background: freeEqEnabled ? meter.warn.background : 'transparent',
                color: freeEqEnabled ? meter.warn.foreground : text.muted,
              }}
            >
              FREE EQ
            </button>
          )}
          {props.onToggleDuoMode && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); props.onToggleDuoMode?.(); }}
              title={duoMode
                ? 'Pre/Post 듀얼 스펙트럼 끄기'
                : 'Pre/Post 듀얼 스펙트럼 — 원본(PRE)과 마스터(POST)를 위/아래로 동시에 표시'}
              className="no-drag"
              style={{
                fontFamily: typography.family.mono, fontSize: 9, letterSpacing: '0.06em',
                border: `1px solid ${duoMode ? meter.safe.foreground : surface.border}`,
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                background: duoMode ? meter.safe.background : 'transparent',
                color: duoMode ? meter.safe.foreground : text.muted,
              }}
            >
              PRE/POST
            </button>
          )}
          {abMode !== undefined && !duoMode && (
            <span
              title={abMode === 'after'
                ? 'A/B 비교: 지금 After(B) 재생 중 — 노란 그래프가 Before(A) 기준'
                : 'A/B 비교: 지금 Before(A) 재생 중 — 초록 그래프가 After(B) 결과'}
              style={{
                fontFamily: typography.family.mono, fontSize: 9, letterSpacing: '0.06em',
                border: `1px solid ${surface.border}`, borderRadius: 4, padding: '2px 6px',
                userSelect: 'none',
              }}
            >
              <span style={{ color: abMode === 'before' ? text.primary : text.muted }}>A</span>
              <span style={{ color: text.muted, margin: '0 1px' }}>/</span>
              <span style={{ color: abMode === 'after' ? text.primary : text.muted }}>B</span>
            </span>
          )}
          <LivePulse active={active} />
        </div>
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
        {duoMode ? (
          <DualSpectrumBody
            preAnalyser={props.duoSecondaryAnalyser ?? null}
            postAnalyser={native.analysers?.main ?? null}
            {...(props.duoSecondaryStatus ? { preStatus: props.duoSecondaryStatus } : {})}
          />
        ) : (
          <VisualizerBoundary fallback={<NativeSpectrumBody native={native} {...(abMode !== undefined ? { abMode } : {})} />}>
            {isLiveVisualizerEnabled()
              ? <LiveSpectrumBody session={props.session ?? null} native={native} {...(abMode !== undefined ? { abMode } : {})} />
              : <NativeSpectrumBody native={native} {...(abMode !== undefined ? { abMode } : {})} />}
          </VisualizerBoundary>
        )}
        {/* Free parametric EQ overlay (Phase 1: visualization only). */}
        {freeEqEnabled && !duoMode && props.freeEqBands && props.onFreeEqChange && (
          <FreeEqOverlay
            bands={props.freeEqBands}
            onChange={props.onFreeEqChange}
          />
        )}
      </div>
      {/* Free EQ status banner — Phase 3b complete: bands are baked into
          Rust offline render (when the rust backend is selected).  The
          banner now confirms which export path includes the EQ. */}
      {freeEqEnabled && !duoMode && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingInline: space['4'],
          paddingBlock: 4,
          background: meter.safe.background,
          borderTop: `1px solid ${meter.safe.foreground}`,
          fontFamily: typography.family.mono,
          fontSize: 9,
          color: meter.safe.foreground,
          letterSpacing: '0.04em',
        }}>
          FREE EQ — 실시간 프리뷰 + Rust offline render 익스포트에 모두 반영됩니다.
        </div>
      )}

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

/** Free parametric EQ overlay — measures its parent body size + renders the
 *  draggable curve editor.  Phase 1: visualization only (no DSP wiring). */
function FreeEqOverlay({
  bands, onChange,
}: { bands: ParametricEqBand[]; onChange: (b: ParametricEqBand[]) => void }) {
  const [ref, size] = useSize();
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        inset: space['3'],   // matches the body's padding
        pointerEvents: 'none',
        // SVG inside re-enables pointer-events for its own elements.
      }}
    >
      {size.w > 0 && size.h > 0 && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
          <DraggableParametricEqEditor
            width={size.w}
            height={size.h}
            bands={bands}
            onChange={onChange}
          />
        </div>
      )}
    </div>
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
function NativeSpectrumBody({ native, abMode }: { native: NativeAnalyzerState; abMode?: 'before' | 'after' }) {
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden', background: surface.well }}>
      <NativeSpectrumCanvas analyser={native.analysers?.main ?? null} {...(abMode !== undefined ? { abMode } : {})} />
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

function LiveSpectrumBody({ session, native, abMode }: { session: AnalyzerSession | null; native: NativeAnalyzerState; abMode?: 'before' | 'after' }) {
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
      <NativeSpectrumCanvas analyser={native.analysers?.main ?? null} {...(abMode !== undefined ? { abMode } : {})} />
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
