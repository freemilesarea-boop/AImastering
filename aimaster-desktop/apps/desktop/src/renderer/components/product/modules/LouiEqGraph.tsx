// LouiEqGraph — the EQ as a curve you drag, not a column of sliders.
//
// Reference behaviour is FabFilter Pro-Q: a log-frequency graph with the
// live spectrum behind it, one node per band, and the whole gesture
// vocabulary on the node itself — drag for frequency and gain, wheel for
// bandwidth, double-click to zero it out.
//
// Three things this had to get right:
//
//   • **The curve is computed from the same coefficients the DSP runs**
//     (see `eq-graph-model`), so what is drawn is what is heard.  The
//     analyser trace behind it is the real post-chain spectrum, not a
//     decoration — which means when the curve says +6 dB at 3 kHz, the
//     trace visibly rises there.
//
//   • **Dragging writes parameters, not local state.**  There is no
//     shadow copy of the band list here; a drag calls `onEdit` and the new
//     values arrive back as props on the next render, the same path a
//     slider takes.  That is why moving a node is audible immediately —
//     it feeds the same config push the rest of the Studio uses.
//
//   • **Pointer capture, so a fast drag does not fall off the node.**
//     Without it the gesture ends the moment the cursor outruns the
//     circle, which at the top of a steep bell is most of the time.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type GraphBand,
  bandGainDbAt,
  combinedGainDbAt,
} from '../../../audio/modules/eq-graph-model.js';
import { surface, text, typography, space, radius, meter } from '../../../theme/loui-theme.js';

export interface LouiEqGraphProps {
  bands: readonly GraphBand[];
  /**
   * A node moved.  Called continuously during a drag, with only the axes
   * that moved.  What a move *means* is the caller's business: a fixed
   * module turns it into parameter writes, the free EQ edits its band list.
   */
  onBandChange: (band: GraphBand, next: { hz?: number; gainDb?: number; q?: number }) => void;
  /**
   * Free-EQ gestures.  Supplying these turns on adding, deleting and
   * retyping bands; without them the graph edits a fixed set of nodes.
   */
  free?: {
    /** Double-click on empty canvas. */
    onAdd: (hz: number, gainDb: number) => void;
    /** Alt-click or right-click a node. */
    onRemove: (bandId: string) => void;
    /** Double-click a node — walks the filter shapes. */
    onCycleType: (bandId: string) => void;
    /** True when no more bands will fit; adding is refused and says so. */
    atCapacity?: boolean;
  };
  /**
   * Live analyser for the trace behind the curve.  Read on an animation
   * frame and drawn to a canvas — deliberately NOT React state, because a
   * spectrum that re-rendered the panel thirty times a second would drag
   * every curve recomputation along with it.
   */
  analyser?: AnalyserNode | null;
  /** Sample rate the spectrum bins map onto. */
  sampleRate?: number;
  height?: number;
  /** Dims and freezes the graph — used when the module is bypassed. */
  disabled?: boolean;
}

const MIN_HZ = 20;
const MAX_HZ = 20_000;
const DB_RANGE = 18;
const CURVE_POINTS = 320;

/**
 * The frequency ruler.
 *
 * Two tiers, the way every mastering EQ draws them. The MAJOR decade and
 * half-decade points carry a brighter line and a number; the MINOR points
 * in between carry a faint line only. Three labels across ten octaves — the
 * first attempt — leaves you counting gridlines to find 200 Hz, which is
 * exactly the frequency you are usually looking for.
 */
const MAJOR_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];
const MINOR_HZ = [
  30, 40, 60, 70, 80, 90,
  300, 400, 600, 700, 800, 900,
  3000, 4000, 6000, 7000, 8000, 9000,
  15_000,
];
/** dB gridlines, labelled every 6 dB down the right margin. */
const GRID_DB = [-18, -12, -6, 0, 6, 12, 18];
const LABEL_DB = new Set([-12, -6, 6, 12]);

// `right` leaves room for the dB ruler; `bottom` for the frequency one.
const PAD = { left: 10, right: 30, top: 12, bottom: 20 };

function hzToX(hz: number, w: number): number {
  const t = Math.log(Math.max(hz, MIN_HZ) / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
  return PAD.left + t * (w - PAD.left - PAD.right);
}
function xToHz(x: number, w: number): number {
  const t = (x - PAD.left) / Math.max(1, w - PAD.left - PAD.right);
  return MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, Math.min(1, Math.max(0, t)));
}
function dbToY(db: number, h: number): number {
  const t = (DB_RANGE - db) / (2 * DB_RANGE);
  return PAD.top + t * (h - PAD.top - PAD.bottom);
}
function yToDb(y: number, h: number): number {
  const t = (y - PAD.top) / Math.max(1, h - PAD.top - PAD.bottom);
  return DB_RANGE - Math.min(1, Math.max(0, t)) * 2 * DB_RANGE;
}

/** Readout formatting — keeps a decimal, because 1.2k and 1.9k differ. */
function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}

/** Ruler formatting — terse, because the tick already says where it is. */
function fmtAxisHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

/** Sample the summed response across the visible range. */
function curvePath(bands: readonly GraphBand[], w: number, h: number, sr: number): string {
  let d = '';
  for (let i = 0; i <= CURVE_POINTS; i++) {
    const x = PAD.left + (i / CURVE_POINTS) * (w - PAD.left - PAD.right);
    const db = combinedGainDbAt(bands, xToHz(x, w), sr);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${dbToY(db, h).toFixed(1)}`;
  }
  return d;
}

/** One band's own response, closed back to the 0 dB line so it can fill. */
function bandPath(band: GraphBand, w: number, h: number, sr: number): string {
  const zero = dbToY(0, h);
  let d = `M${PAD.left},${zero.toFixed(1)}`;
  for (let i = 0; i <= CURVE_POINTS; i++) {
    const x = PAD.left + (i / CURVE_POINTS) * (w - PAD.left - PAD.right);
    const db = bandGainDbAt(band, xToHz(x, w), sr);
    d += `L${x.toFixed(1)},${dbToY(db, h).toFixed(1)}`;
  }
  return `${d}L${(w - PAD.right).toFixed(1)},${zero.toFixed(1)}Z`;
}

/** Floor of the analyser trace, in dBFS. */
const SPECTRUM_FLOOR_DB = -96;

/**
 * Draw one analyser frame onto the backing canvas.
 *
 * The trace is a LEVEL display (dBFS) sharing a panel with a GAIN display
 * (dB of EQ), which are not the same scale — so it is drawn faint, filled,
 * and behind, as context rather than something to read values off.
 */
function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  spec: Float32Array,
  w: number,
  h: number,
  sr: number,
): void {
  ctx.clearRect(0, 0, w, h);
  const bins = spec.length;
  if (bins < 4) return;
  const binHz = sr / 2 / bins;
  const base = h - PAD.bottom;
  const yFor = (dbfs: number): number => {
    const t = Math.min(1, Math.max(0, (dbfs - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB));
    return PAD.top + (1 - t) * (h - PAD.top - PAD.bottom);
  };

  ctx.beginPath();
  ctx.moveTo(PAD.left, base);
  let lastX = -1;
  for (let i = 1; i < bins; i++) {
    const hz = i * binHz;
    if (hz < MIN_HZ) continue;
    if (hz > MAX_HZ) break;
    const x = hzToX(hz, w);
    // One point per pixel: above a few kHz many bins land in one column,
    // and drawing them all costs time without adding anything visible.
    if (x - lastX < 1) continue;
    lastX = x;
    const v = spec[i];
    ctx.lineTo(x, yFor(typeof v === 'number' && Number.isFinite(v) ? v : SPECTRUM_FLOOR_DB));
  }
  ctx.lineTo(w - PAD.right, base);
  ctx.closePath();
  ctx.fillStyle = 'rgba(148,163,184,0.13)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,184,0.30)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

type DragKind = 'move' | 'q';

interface DragState {
  bandId: string;
  kind: DragKind;
  startY: number;
  startQ: number;
}

export function LouiEqGraph(props: LouiEqGraphProps) {
  const height = props.height ?? 260;
  const sr = props.sampleRate ?? 48_000;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(720);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Track the container width so the graph fills the panel at any size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr && cr.width > 0) setWidth(cr.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth || 720);
    return () => ro.disconnect();
  }, []);

  const { onBandChange, disabled, free } = props;
  const bands = props.bands;

  const bandById = useCallback(
    (id: string) => bands.find((b) => b.id === id) ?? null,
    [bands],
  );

  const applyPointer = useCallback((band: GraphBand, clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const next: { hz?: number; gainDb?: number } = {};
    if (band.freq) next.hz = xToHz(x, rect.width);
    if (band.gain) next.gainDb = yToDb(y, height);
    onBandChange(band, next);
  }, [onBandChange, height]);

  const onNodeDown = useCallback((e: React.PointerEvent, band: GraphBand) => {
    if (disabled || band.readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(band.id);
    // Capture on the SVG ROOT, not on the circle.  Two reasons, and the
    // second one is a bug that cost a whole module:
    //   • the pointer routinely outruns a 7 px target during a fast drag;
    //   • the move and up handlers live on the root, so capturing on the
    //     circle and releasing on the root threw InvalidStateError on every
    //     mouse-up — which React surfaces as a render error, losing the
    //     edit that had just been made.  Capture and release must name the
    //     same element.
    svgRef.current?.setPointerCapture?.(e.pointerId);
    const qDrag = e.shiftKey && !!band.qAxis;
    dragRef.current = { bandId: band.id, kind: qDrag ? 'q' : 'move', startY: e.clientY, startQ: band.q };
    if (!qDrag) applyPointer(band, e.clientX, e.clientY);
  }, [disabled, applyPointer]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const band = bandById(drag.bandId);
    if (!band) return;
    if (drag.kind === 'q') {
      // Upward drag narrows, the way a bell gets pointier as it rises.
      const dy = drag.startY - e.clientY;
      onBandChange(band, { q: drag.startQ * Math.pow(2, dy / 80) });
      return;
    }
    applyPointer(band, e.clientX, e.clientY);
  }, [bandById, applyPointer, onBandChange]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const svg = svgRef.current;
    // Releasing a capture the element does not hold throws; the guard is
    // not defensive padding, it is the contract of the API.
    if (svg?.hasPointerCapture?.(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent, band: GraphBand) => {
    if (disabled || band.readOnly || !band.qAxis) return;
    e.preventDefault();
    e.stopPropagation();
    onBandChange(band, { q: band.q * Math.pow(2, -e.deltaY / 400) });
  }, [disabled, onBandChange]);

  /**
   * Double-click a node.  On the free EQ it walks the filter shapes (the
   * Pro-Q gesture); on a fixed module there is no shape to change, so it
   * flattens the band instead — the fastest way to undo a move.
   */
  const onNodeDoubleClick = useCallback((e: React.MouseEvent, band: GraphBand) => {
    if (disabled || band.readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    if (band.free && free) { free.onCycleType(band.id); return; }
    if (!band.gain) return;
    const flat = band.gain.min <= 0 && band.gain.max >= 0 ? 0 : band.gain.min;
    onBandChange(band, { gainDb: flat });
  }, [disabled, onBandChange, free]);

  /** Alt-click or right-click removes a free band. */
  const onNodeRemove = useCallback((e: React.MouseEvent, band: GraphBand) => {
    if (disabled || !band.free || !free) return;
    e.preventDefault();
    e.stopPropagation();
    free.onRemove(band.id);
  }, [disabled, free]);

  /** Double-click on empty canvas adds a band where the pointer is. */
  const onCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (disabled || !free || free.atCapacity) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    free.onAdd(xToHz(e.clientX - rect.left, rect.width), yToDb(e.clientY - rect.top, height));
  }, [disabled, free, height]);

  /** Arrow keys on a focused node, so the graph is not mouse-only. */
  const onNodeKeyDown = useCallback((e: React.KeyboardEvent, band: GraphBand) => {
    if (disabled || band.readOnly) return;
    const coarse = e.shiftKey ? 5 : 1;
    let next: { hz?: number; gainDb?: number; q?: number } | null = null;
    if (e.key === 'ArrowUp') next = { gainDb: band.gainDb + 0.5 * coarse };
    else if (e.key === 'ArrowDown') next = { gainDb: band.gainDb - 0.5 * coarse };
    else if (e.key === 'ArrowRight') next = { hz: band.hz * Math.pow(2, 0.05 * coarse) };
    else if (e.key === 'ArrowLeft') next = { hz: band.hz * Math.pow(2, -0.05 * coarse) };
    else if ((e.key === 'Delete' || e.key === 'Backspace') && band.free && free) {
      e.preventDefault();
      free.onRemove(band.id);
      return;
    }
    if (!next) return;
    e.preventDefault();
    onBandChange(band, next);
  }, [disabled, onBandChange, free]);

  const curve = useMemo(() => curvePath(bands, width, height, sr), [bands, width, height, sr]);

  // ── Analyser trace ─────────────────────────────────────────────────────
  // Its own animation frame, its own canvas, no React state.  The loop
  // depends only on the analyser node and the canvas size, so a parameter
  // change never restarts it and it never schedules a render.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyser = props.analyser ?? null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bins = new Float32Array(analyser.frequencyBinCount);
    let raf = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      try {
        analyser.getFloatFrequencyData(bins);
        drawSpectrum(ctx, bins, width, height, analyser.context.sampleRate);
      } catch {
        // The context can be torn down mid-frame; stop rather than spin.
        stopped = true;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, width, height);
    };
  }, [analyser, width, height]);

  const focus = bandById(hover ?? selected ?? '') ?? null;
  const zeroY = dbToY(0, height);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          width: '100%',
          height,
          background: surface.well,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.panel,
          overflow: 'hidden',
          opacity: disabled ? 0.45 : 1,
          touchAction: 'none',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            pointerEvents: 'none',
          }}
        />
        <svg
          ref={svgRef}
          width={width}
          height={height}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onCanvasDoubleClick}
          onContextMenu={(e) => { if (free) e.preventDefault(); }}
          style={{ position: 'relative', display: 'block', cursor: dragRef.current ? 'grabbing' : 'default' }}
        >
          {/* Grid + rulers */}
          <g>
            {MINOR_HZ.map((hz) => {
              const x = hzToX(hz, width);
              return (
                <line
                  key={`m${hz}`}
                  x1={x} x2={x} y1={PAD.top} y2={height - PAD.bottom}
                  stroke="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.04)" strokeWidth={1}
                />
              );
            })}
            {MAJOR_HZ.map((hz) => {
              const x = hzToX(hz, width);
              // The first and last labels would hang off the plot; anchor
              // them inwards instead of letting them clip.
              const anchor = hz === MIN_HZ ? 'start' : hz === MAX_HZ ? 'end' : 'middle';
              return (
                <g key={hz}>
                  <line
                    x1={x} x2={x} y1={PAD.top} y2={height - PAD.bottom}
                    stroke="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.10)" strokeWidth={1}
                  />
                  <text
                    x={x} y={height - 6} textAnchor={anchor}
                    fill="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.38)"
                    style={{ fontFamily: typography.family.mono, fontSize: 9 }}
                  >
                    {fmtAxisHz(hz)}
                  </text>
                </g>
              );
            })}
            {GRID_DB.map((db) => {
              const y = dbToY(db, height);
              return (
                <g key={db}>
                  <line
                    x1={PAD.left} x2={width - PAD.right} y1={y} y2={y}
                    stroke={db === 0 ? 'rgba(var(--loui-onsurface-rgb, 255,255,255), 0.18)' : 'rgba(var(--loui-onsurface-rgb, 255,255,255), 0.05)'}
                    strokeWidth={1}
                  />
                  {LABEL_DB.has(db) && (
                    <text
                      x={width - PAD.right + 4} y={y + 3}
                      fill="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.34)"
                      style={{ fontFamily: typography.family.mono, fontSize: 9 }}
                    >
                      {db > 0 ? `+${db}` : db}
                    </text>
                  )}
                </g>
              );
            })}
            {/* Scale marker — the range the vertical axis covers, so a
                curve is never read against an axis you have to guess. */}
            <text
              x={width - PAD.right + 4} y={PAD.top + 8}
              fill="rgba(var(--loui-onsurface-rgb, 255,255,255), 0.22)"
              style={{ fontFamily: typography.family.mono, fontSize: 8 }}
            >
              dB
            </text>
          </g>

          {/* Per-band regions — only for the band under the cursor, so the
              graph reads as one curve until you ask about a band. */}
          {focus && !focus.readOnly && focus.active && (
            <path d={bandPath(focus, width, height, sr)} fill={`${focus.color}22`} stroke="none" />
          )}

          {/* The response */}
          <path d={curve} fill="none" stroke="var(--loui-meter-accent, #A78BFA)" strokeWidth={2} strokeLinejoin="round" />

          {/* Nodes */}
          {bands.map((b) => {
            if (b.readOnly) return null;
            const x = hzToX(b.hz, width);
            const y = b.gain ? dbToY(b.gainDb, height) : zeroY;
            const on = selected === b.id || hover === b.id;
            return (
              <g key={b.id}>
                <circle
                  cx={x} cy={y} r={on ? 9 : 7}
                  fill={b.active ? b.color : 'rgba(120,120,140,0.5)'}
                  fillOpacity={on ? 0.95 : 0.75}
                  stroke="rgba(var(--loui-surface-rgb, 10,10,14), 0.85)" strokeWidth={2}
                  tabIndex={disabled ? -1 : 0}
                  role="slider"
                  aria-label={`${b.label} — ${fmtHz(b.hz)} Hz, ${b.gainDb.toFixed(1)} dB, Q ${b.q.toFixed(2)}`}
                  aria-valuemin={b.gain?.min ?? 0}
                  aria-valuemax={b.gain?.max ?? 0}
                  aria-valuenow={Number(b.gainDb.toFixed(1))}
                  onPointerDown={(e) => {
                    // Alt-click deletes rather than drags, so a removal
                    // cannot leave a half-applied move behind it.
                    if (b.free && free && (e.altKey || e.button === 2)) { onNodeRemove(e, b); return; }
                    onNodeDown(e, b);
                  }}
                  onContextMenu={(e) => onNodeRemove(e, b)}
                  onDoubleClick={(e) => onNodeDoubleClick(e, b)}
                  onWheel={(e) => onWheel(e, b)}
                  onPointerEnter={() => setHover(b.id)}
                  onPointerLeave={() => setHover(null)}
                  onKeyDown={(e) => onNodeKeyDown(e, b)}
                  style={{ cursor: disabled ? 'default' : 'grab', outline: 'none' }}
                />
                <text
                  x={x} y={y + 3} textAnchor="middle" pointerEvents="none"
                  fill="rgba(var(--loui-surface-rgb, 10,10,14), 0.9)"
                  style={{ fontFamily: typography.family.mono, fontSize: 8, fontWeight: 700 }}
                >
                  {b.short}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Readout + gesture hints.  A graph with hidden gestures is a graph
          nobody uses past dragging. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: space['3'], flexWrap: 'wrap',
      }}>
        <span style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: focus ? text.secondary : text.muted,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {focus
            ? `${focus.label} · ${fmtHz(focus.hz)} Hz · ${focus.gainDb >= 0 ? '+' : ''}${focus.gainDb.toFixed(1)} dB${focus.qAxis ? ` · Q ${focus.q.toFixed(2)}` : ''}`
            : free
              ? `밴드 ${bands.length}개 — 빈 곳 더블클릭으로 추가`
              : '노드를 드래그 — 좌우 주파수 · 상하 게인'}
        </span>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: free?.atCapacity ? meter.warn.foreground : text.muted,
        }}>
          {free
            ? free.atCapacity
              ? '밴드 한도에 도달 — 추가하려면 하나 삭제하세요'
              : '휠 = Q · 더블클릭(노드) = 필터 종류 · Alt+클릭 = 삭제'
            : '휠 = 대역폭 · Shift+드래그 = 대역폭 · 더블클릭 = 0 dB'}
        </span>
      </div>
    </div>
  );
}
