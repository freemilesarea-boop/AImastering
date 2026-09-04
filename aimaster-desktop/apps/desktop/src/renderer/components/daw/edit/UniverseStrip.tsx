// UniverseStrip — the whole song in one band, and the window you drag over it.
//
// Canvas for the blocks, because a five-minute session with forty tracks is
// hundreds of little rectangles and a DOM node each is a scroll that stutters.
// The rectangle on top is a DOM element, because it is the thing you grab and
// it wants a cursor, a hit area and edges that are easy to catch.
//
// Every number here comes from `model/universe.ts`.  The component owns the
// pixels it paints; that module owns what the pixels should be.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import {
  MIN_VIEW_PX, describeUniverse, fitWholeSong, rowHeightPx, scrollForStripClick,
  scrollForStripX, secToStripPx, universeRows, universeSpan, viewRect,
  zoomForStripEdge,
} from '../../../daw/model/universe.js';
import { premium } from '../../../theme/premium.js';

/** Enough for forty tracks to each be a readable stripe, and no taller. */
const STRIP_HEIGHT = 64;
/** The grab zone on each side of the window rectangle. */
const EDGE_PX = 5;

type Drag =
  | { kind: 'move'; grabOffsetPx: number }
  | { kind: 'edge'; edge: 'left' | 'right' };

export default function UniverseStrip({ laneWidth }: { laneWidth: number }) {
  const session = useDawStore((s) => s.session);
  const pxPerSec = useDawStore((s) => s.pxPerSec);
  const scrollSec = useDawStore((s) => s.scrollSec);
  const setScrollSec = useDawStore((s) => s.setScrollSec);
  const setPxPerSec = useDawStore((s) => s.setPxPerSec);
  const playheadSec = useDawStore((s) => s.playheadSec);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [drag, setDrag] = useState<Drag | null>(null);

  const span = useMemo(() => universeSpan(session), [session]);
  const rows = useMemo(() => universeRows(session, width), [session, width]);
  const view = useMemo(
    () => ({ scrollSec, pxPerSec, widthPx: Math.max(1, laneWidth) }),
    [scrollSec, pxPerSec, laneWidth]);
  const rect = useMemo(() => viewRect(view, span, width), [view, span, width]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setWidth(Math.max(80, r.width));
    });
    ro.observe(el);
    setWidth(Math.max(80, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // ── Paint ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(STRIP_HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${STRIP_HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, STRIP_HEIGHT);

    const rowH = rowHeightPx(rows.length, STRIP_HEIGHT);
    rows.forEach((row, i) => {
      const y = i * rowH;
      // A faint stripe per track, so an EMPTY track still reads as a track
      // rather than as a gap between two others.
      ctx.fillStyle = i % 2 === 1 ? 'rgba(255,255,255,0.025)' : 'transparent';
      if (i % 2 === 1) ctx.fillRect(0, y, width, rowH);

      for (const block of row.blocks) {
        ctx.fillStyle = block.muted ? 'rgba(140,140,160,0.35)' : row.color;
        ctx.globalAlpha = block.muted ? 0.5 : 0.85;
        // At least a pixel tall as well as wide: forty tracks in sixty-four
        // pixels is a pixel and a half each, and a block rounded to nothing
        // is a song that looks emptier than it is.
        ctx.fillRect(block.x, y + 0.5, block.width, Math.max(1, rowH - 1));
        ctx.globalAlpha = 1;
      }
    });

    // The play head, so the strip answers "where am I" as well as "what is
    // there" — which is half of why anybody looks at it.
    const headX = secToStripPx(span, width, playheadSec);
    if (headX >= 0 && headX <= width) {
      ctx.strokeStyle = 'rgba(235,90,90,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(headX) + 0.5, 0);
      ctx.lineTo(Math.round(headX) + 0.5, STRIP_HEIGHT);
      ctx.stroke();
    }
  }, [rows, width, span, playheadSec]);

  // ── Gestures ────────────────────────────────────────────────────────────
  const localX = useCallback((clientX: number): number => {
    const box = areaRef.current?.getBoundingClientRect();
    return box ? clientX - box.left : 0;
  }, []);

  const onDown = useCallback((e: React.MouseEvent) => {
    const x = localX(e.clientX);
    if (Math.abs(x - rect.x) <= EDGE_PX) { setDrag({ kind: 'edge', edge: 'left' }); return; }
    if (Math.abs(x - (rect.x + rect.width)) <= EDGE_PX) {
      setDrag({ kind: 'edge', edge: 'right' }); return;
    }
    if (x >= rect.x && x <= rect.x + rect.width) {
      // Grabbed inside: keep the point under the cursor under the cursor,
      // rather than snapping the rectangle's left edge to it.
      setDrag({ kind: 'move', grabOffsetPx: x - rect.x });
      return;
    }
    // Clicked the bare strip — jump there, centred.
    setScrollSec(scrollForStripClick(view, span, width, x));
  }, [localX, rect, view, span, width, setScrollSec]);

  const onMove = useCallback((e: React.MouseEvent) => {
    if (!drag) return;
    const x = localX(e.clientX);
    if (drag.kind === 'move') {
      setScrollSec(scrollForStripX(view, span, width, x - drag.grabOffsetPx));
      return;
    }
    const change = zoomForStripEdge(view, span, width, drag.edge, x);
    if (!change) return;
    setPxPerSec(change.pxPerSec);
    setScrollSec(change.scrollSec);
  }, [drag, localX, view, span, width, setScrollSec, setPxPerSec]);

  const endDrag = useCallback(() => setDrag(null), []);

  const cursorFor = (x: number): string => {
    if (Math.abs(x - rect.x) <= EDGE_PX || Math.abs(x - (rect.x + rect.width)) <= EDGE_PX) {
      return 'ew-resize';
    }
    return x >= rect.x && x <= rect.x + rect.width ? 'grab' : 'pointer';
  };
  const [cursor, setCursor] = useState('pointer');

  return (
    <div className="flex items-stretch border-b border-zinc-800 bg-[#0c0c12]"
         style={{ height: STRIP_HEIGHT }}>
      <div className="shrink-0 border-r border-zinc-800 px-2 py-1 flex flex-col justify-between"
           style={{ width: 148 }}>
        <span className="text-[9px]" style={{ color: premium.text.faint }}>UNIVERSE</span>
        <span className="text-[8.5px] leading-tight" style={{ color: premium.text.faint }}>
          {describeUniverse(session, view)}
        </span>
        <button
          onClick={() => {
            const change = fitWholeSong(view, span);
            if (!change) return;
            setPxPerSec(change.pxPerSec);
            setScrollSec(change.scrollSec);
          }}
          title="곡 전체가 보이도록 — 엔진의 최소 줌까지"
          className="h-4 rounded text-[8.5px] bg-zinc-900 border border-zinc-700 text-zinc-400"
        >전체 보기</button>
      </div>

      <div
        ref={areaRef}
        className="relative flex-1 overflow-hidden select-none"
        style={{ cursor: drag ? (drag.kind === 'edge' ? 'ew-resize' : 'grabbing') : cursor }}
        onMouseDown={onDown}
        onMouseMove={(e) => { setCursor(cursorFor(localX(e.clientX))); onMove(e); }}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <canvas ref={canvasRef} className="absolute inset-0" />
        {/* The window.  Drawn over the blocks rather than under them, so it is
            legible on a busy song; the fill is faint enough to read through. */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: rect.x,
            width: Math.max(MIN_VIEW_PX, rect.width),
            background: rect.coversAll ? 'transparent' : 'rgba(120,150,255,0.13)',
            border: `1px solid ${rect.coversAll ? 'rgba(120,150,255,0.35)' : 'rgba(150,180,255,0.75)'}`,
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
}
