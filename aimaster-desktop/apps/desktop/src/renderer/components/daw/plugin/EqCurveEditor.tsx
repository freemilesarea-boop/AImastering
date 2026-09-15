// The EQ you grab instead of the EQ you dial.
//
// A parametric EQ's whole claim is freedom: any band, any frequency, any
// width.  A grid of fifteen knobs has all of that freedom and none of the
// access to it — you cannot see that band 2 is sitting on top of band 1, and
// finding 3.2 kHz means turning a knob and reading a number instead of
// pointing at the place the problem is.
//
// So this draws the response the engine is actually producing (the same
// cookbook maths `BiquadFilterNode` implements) and puts a handle on every
// band.  Drag sideways for frequency, up and down for gain, wheel for width,
// double-click to put a band back where it started.  The knobs stay below for
// when a number is what you want; this is for when the sound is.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  biquadMagnitudeDb, freqToX, logFrequencies, xToFreq,
} from '../../../daw/model/plugin-curves.js';
import {
  eqNodes, nodeAt, nodeDragEdits, nodeQEdit, type EqNode, type NodeEdit, type ParamRange,
} from '../../../daw/model/eq-nodes.js';
import { premium } from '../../../theme/premium.js';

export interface EqCurveEditorProps {
  pluginId: string;
  params: Record<string, number>;
  /** The device's own limits, so a handle stops where the device stops. */
  ranges: Readonly<Record<string, ParamRange>>;
  /** Where a band goes back to on double-click. */
  defaults: Readonly<Record<string, number>>;
  bypassed: boolean;
  width: number;
  height: number;
  /** Applied as the pointer moves — one edit per parameter the drag touched. */
  onEdit: (edits: readonly NodeEdit[]) => void;
  /** Pointer up: the drag was one undo step, not forty. */
  onCommit: () => void;
}

/** ±dB the picture spans.  Wider than any single band so a stack still fits. */
const RANGE_DB = 24;
const PAD_TOP = 10;
const PAD_BOTTOM = 16;

const GRID = 'rgba(255,255,255,0.06)';
const GRID_STRONG = 'rgba(255,255,255,0.12)';
const LABEL = 'rgba(160,160,175,0.9)';

const FREQ_TICKS: ReadonlyArray<[number, string]> = [
  [50, '50'], [100, '100'], [200, '200'], [500, '500'],
  [1000, '1k'], [2000, '2k'], [5000, '5k'], [10_000, '10k'],
];

function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}

export default function EqCurveEditor({
  pluginId, params, ranges, defaults, bypassed, width, height, onEdit, onCommit,
}: EqCurveEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /**
   * Where inside the handle it was grabbed.
   *
   * Without this, clicking 5 px off a handle's centre snaps the band 5 px —
   * a click that was meant to select a band silently retunes it, and the
   * pointer-down alone would be an undo step.  The band moves only by how far
   * the pointer moves.
   */
  const grabOffset = useRef({ x: 0, y: 0 });

  const nodes = useMemo(() => eqNodes(pluginId, params), [pluginId, params]);

  const plotTop = PAD_TOP;
  const plotBottom = height - PAD_BOTTOM;
  const plotH = Math.max(1, plotBottom - plotTop);

  const yForDb = useCallback(
    (db: number): number =>
      plotTop + plotH / 2 - (Math.max(-RANGE_DB, Math.min(RANGE_DB, db)) / RANGE_DB) * (plotH / 2),
    [plotTop, plotH],
  );
  const dbForY = useCallback(
    (y: number): number => ((plotTop + plotH / 2 - y) / (plotH / 2)) * RANGE_DB,
    [plotTop, plotH],
  );

  /**
   * A node's handle position.
   *
   * A cut has no gain to plot, so its handle rides the curve it produces —
   * which is where the eye expects a high-pass corner to be, and means
   * dragging it feels like dragging the corner rather than a floating dot.
   */
  const points = useMemo(() => nodes.map((node) => {
    const x = freqToX(node.freq) * width;
    const db = node.gainParam === null
      ? biquadMagnitudeDb({ type: node.type, freq: node.freq, gain: 0, q: node.q }, node.freq)
      : node.gainDb;
    return { id: node.id, x, y: yForDb(db), node };
  }), [nodes, width, yForDb]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Grid.
    ctx.font = '8px ui-monospace, monospace';
    for (const [hz, label] of FREQ_TICKS) {
      const x = Math.round(freqToX(hz) * width) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, plotBottom); ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(label, x + 2, height - 5);
    }
    for (const db of [-18, -12, -6, 6, 12, 18]) {
      const y = Math.round(yForDb(db)) + 0.5;
      ctx.strokeStyle = db % 12 === 0 ? GRID_STRONG : GRID;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      if (db % 12 === 0) { ctx.fillStyle = LABEL; ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 2, y - 2); }
    }
    const zero = Math.round(yForDb(0)) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.moveTo(0, zero); ctx.lineTo(width, zero); ctx.stroke();

    const freqs = logFrequencies(width);

    // Each band on its own, faintly — this is what shows a bell sitting under
    // a shelf, which is the thing the knob grid could never show.
    for (const node of nodes) {
      if (node.gainParam !== null && Math.abs(node.gainDb) < 0.05) continue;
      ctx.beginPath();
      freqs.forEach((hz, i) => {
        const db = biquadMagnitudeDb({ type: node.type, freq: node.freq, gain: node.gainDb, q: node.q }, hz);
        const y = yForDb(db);
        if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y);
      });
      ctx.strokeStyle = node.id === (dragging ?? hover)
        ? 'rgba(126,200,255,0.55)'
        : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // The sum — the thing being heard.
    ctx.beginPath();
    freqs.forEach((hz, i) => {
      let db = 0;
      for (const node of nodes) {
        db += biquadMagnitudeDb({ type: node.type, freq: node.freq, gain: node.gainDb, q: node.q }, hz);
      }
      const y = yForDb(db);
      if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y);
    });
    ctx.strokeStyle = bypassed ? 'rgba(140,140,160,0.5)' : premium.accent.base;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(width, zero);
    ctx.lineTo(0, zero);
    ctx.closePath();
    ctx.fillStyle = bypassed ? 'rgba(140,140,160,0.06)' : 'rgba(230,210,160,0.09)';
    ctx.fill();

    // Handles.
    for (const point of points) {
      const active = point.id === dragging || point.id === hover;
      ctx.beginPath();
      ctx.arc(point.x, point.y, active ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = bypassed
        ? 'rgba(140,140,160,0.5)'
        : active ? 'rgba(126,200,255,0.95)' : 'rgba(230,210,160,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(12,12,16,0.95)';
      ctx.font = 'bold 7px ui-monospace, monospace';
      const label = point.node.label;
      ctx.fillText(label, point.x - ctx.measureText(label).width / 2, point.y + 2.5);
    }
  }, [nodes, points, width, height, bypassed, dragging, hover, plotTop, plotBottom, yForDb]);

  const local = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const nodeById = (id: string | null): EqNode | undefined =>
    nodes.find((n) => n.id === id);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(e);
    const id = nodeAt(points, x, y);
    if (!id) return;
    const point = points.find((p) => p.id === id);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
    grabOffset.current = { x: x - (point?.x ?? x), y: y - (point?.y ?? y) };
    setDragging(id);
    // No edit here: a click that does not move must not change the sound.
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(e);
    if (!dragging) { setHover(nodeAt(points, x, y)); return; }
    const node = nodeById(dragging);
    if (!node) return;
    const gx = x - grabOffset.current.x;
    const gy = y - grabOffset.current.y;
    onEdit(nodeDragEdits(node, xToFreq(gx / width), dbForY(gy), ranges));
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(null);
    onCommit();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(e);
    const node = nodeById(nodeAt(points, x, y));
    if (!node?.qParam) return;
    // Nothing else in the window scrolls, so the wheel belongs to the band
    // under the pointer; letting it bubble would scroll the rack behind.
    e.stopPropagation();
    const edit = nodeQEdit(node, e.deltaY > 0 ? -1 : 1, ranges);
    if (edit) { onEdit([edit]); onCommit(); }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(e);
    const node = nodeById(nodeAt(points, x, y));
    if (!node) return;
    e.stopPropagation();
    const edits: NodeEdit[] = [];
    for (const id of [node.freqParam, node.gainParam, node.qParam]) {
      const fallback = id === null ? undefined : defaults[id];
      if (id !== null && typeof fallback === 'number') edits.push({ paramId: id, value: fallback });
    }
    if (edits.length > 0) { onEdit(edits); onCommit(); }
  };

  const shown = nodeById(dragging ?? hover);

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={canvasRef}
        className="block rounded-md touch-none"
        style={{
          background: 'rgba(0,0,0,0.28)',
          cursor: dragging ? 'grabbing' : hover ? 'grab' : 'default',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { if (!dragging) setHover(null); }}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      />
      <div className="flex items-center justify-between text-[9px]" style={{ color: premium.text.faint }}>
        {shown ? (
          <span style={{ color: premium.text.primary }}>
            {shown.label} · {fmtHz(shown.freq)}
            {shown.gainParam !== null && ` · ${shown.gainDb >= 0 ? '+' : ''}${shown.gainDb.toFixed(1)} dB`}
            {shown.qParam !== null && ` · Q ${shown.q.toFixed(2)}`}
          </span>
        ) : (
          <span>점을 끌어 조절 · 휠로 폭 · 더블클릭으로 초기화</span>
        )}
        <span>20 Hz – 20 kHz · ±{RANGE_DB} dB</span>
      </div>
    </div>
  );
}
