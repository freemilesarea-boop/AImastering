// The tempo track — the song's own tempo, drawn and edited.
//
// One lane above every other, because everything below it is positioned by
// what this lane says.  Two rows in one:
//
//   the curve    tempo against time, with an event at every change
//   the meters   time-signature changes, on the bar they start at
//
// The curve is drawn from `tempoAtBeat` sampled across the visible window
// rather than by joining the events with straight lines, and those are not the
// same picture: a ramp is linear in BPM against BEATS, and beats are not
// evenly spaced in time while the tempo is moving.  Drawing it the easy way
// would show a straight line where the music makes a curve.
//
// Editing is the same three gestures as an automation lane, so there is
// nothing new to learn:
//
//   double-click empty    a tempo change here, at the tempo already in force
//   drag an event         up and down for BPM, sideways along the beat grid
//   alt-click / right     delete it (except the one at the start)
//
// A drag is one undo step.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import {
  MAX_BPM, MIN_BPM, addMeterEvent, addTempoEvent, barBeatAt, barStartBeat,
  beatToSec, clampBpm, compileTempoMap, gridLines, meterAtBar, removeMeterEvent,
  removeTempoEvent, secToBeat, tempoAtBeat, tempoMapOf, updateMeterEvent,
  updateTempoEvent, withTempoMap,
} from '../../../daw/model/tempo-map.js';
import { premium } from '../../../theme/premium.js';
import type { DawSession, TempoEvent } from '../../../daw/model/types.js';

/** Curve row plus the signature strip under it. */
export const TEMPO_TRACK_HEIGHT = 62;
const METER_ROW = 16;
const CURVE_ROW = TEMPO_TRACK_HEIGHT - METER_ROW;
const PAD = 6;
const GRAB_PX = 8;

/** How far above and below the song's own range the curve is drawn. */
function curveRange(bpms: readonly number[]): { lo: number; hi: number } {
  const lo = Math.min(...bpms);
  const hi = Math.max(...bpms);
  if (hi - lo < 12) {
    const mid = (hi + lo) / 2;
    return { lo: Math.max(MIN_BPM, mid - 20), hi: Math.min(MAX_BPM, mid + 20) };
  }
  const pad = (hi - lo) * 0.25;
  return { lo: Math.max(MIN_BPM, lo - pad), hi: Math.min(MAX_BPM, hi + pad) };
}

const fmtBpm = (v: number): string => (Math.abs(v - Math.round(v)) < 0.05
  ? String(Math.round(v)) : v.toFixed(1));

// ── Header cell ─────────────────────────────────────────────────────────────

export function TempoTrackHeader({ session }: { session: DawSession }) {
  const apply = useDawStore((s) => s.apply);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const map = tempoMapOf(session);
  const beat = secToBeat(map, playheadSec);
  const here = barBeatAt(map, beat);
  const meter = meterAtBar(map, here.bar);
  const bpm = tempoAtBeat(map, beat);

  return (
    <div
      className="flex flex-col justify-center gap-1 px-2 border-b border-zinc-900"
      style={{ height: TEMPO_TRACK_HEIGHT, background: premium.surface.frame }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="text-[10px] tracking-wide"
          style={{ fontFamily: premium.type.display, color: premium.accent.light }}
        >TEMPO</span>
        <span className="text-[11px] font-mono tabular-nums flex-1 text-right"
              style={{ color: premium.accent.base }}>{fmtBpm(bpm)}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] font-mono tabular-nums flex-1"
              style={{ color: premium.text.muted }}>
          {here.bar}|{here.beat} · {meter.numerator}/{meter.denominator}
        </span>
        <button
          onClick={() => apply((s) => withTempoMap(s,
            addTempoEvent(tempoMapOf(s), secToBeat(tempoMapOf(s), useDawStore.getState().playheadSec),
              tempoAtBeat(tempoMapOf(s), secToBeat(tempoMapOf(s), useDawStore.getState().playheadSec)))))}
          title="재생 위치에 템포 변화 추가"
          className="w-4 h-4 rounded text-[10px] leading-none border"
          style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
        >+</button>
        <button
          onClick={() => {
            const current = tempoMapOf(session);
            const bar = barBeatAt(current, secToBeat(current, useDawStore.getState().playheadSec)).bar;
            const at = meterAtBar(current, bar);
            apply((s) => withTempoMap(s,
              addMeterEvent(tempoMapOf(s), bar, at.numerator, at.denominator)));
          }}
          title="재생 위치의 마디에 박자 변화 추가"
          className="w-6 h-4 rounded text-[8px] leading-none border"
          style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
        >박자</button>
      </div>
    </div>
  );
}

// ── The track ───────────────────────────────────────────────────────────────

interface Viewport { scrollSec: number; pxPerSec: number; width: number }

export default function TempoTrack({
  session, viewport,
}: { session: DawSession; viewport: Viewport }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const apply = useDawStore((s) => s.apply);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit = useDawStore((s) => s.commitEdit);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const gridDivision = useDawStore((s) => s.gridDivision);

  const [dragId, setDragId] = useState<string | null>(null);
  const { scrollSec, pxPerSec, width } = viewport;
  const map = tempoMapOf(session);
  const compiled = compileTempoMap(map);
  const range = curveRange(compiled.bpms);
  const viewEndSec = scrollSec + width / Math.max(1, pxPerSec);

  const toX = useCallback(
    (sec: number) => (sec - scrollSec) * pxPerSec, [scrollSec, pxPerSec]);
  const toY = useCallback((bpm: number) => {
    const t = (bpm - range.lo) / Math.max(1e-6, range.hi - range.lo);
    return CURVE_ROW - PAD - t * (CURVE_ROW - PAD * 2);
  }, [range.lo, range.hi]);
  const secAt = useCallback((clientX: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    return Math.max(0, scrollSec + ((clientX - (rect?.left ?? 0)) / pxPerSec));
  }, [scrollSec, pxPerSec]);
  const bpmAtY = useCallback((clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    const y = clientY - (rect?.top ?? 0);
    const t = 1 - (y - PAD) / Math.max(1, CURVE_ROW - PAD * 2);
    return clampBpm(range.lo + t * (range.hi - range.lo));
  }, [range]);

  // ── Draw ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(TEMPO_TRACK_HEIGHT * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${TEMPO_TRACK_HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, TEMPO_TRACK_HEIGHT);

    ctx.fillStyle = premium.surface.well;
    ctx.fillRect(0, 0, width, TEMPO_TRACK_HEIGHT);

    // Bar lines, so an event can be read against the music it changes.
    const bars = gridLines(map, scrollSec, viewEndSec, { maxLines: 300 });
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (const line of bars) {
      const x = Math.round(toX(line.sec)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CURVE_ROW);
      ctx.stroke();
    }

    // The curve, sampled in TIME.  A ramp is linear in BPM against beats, and
    // beats are not evenly spaced in time while the tempo moves — joining the
    // events with straight lines would draw a shape the music does not make.
    ctx.beginPath();
    const steps = Math.max(2, Math.min(width, 480));
    for (let i = 0; i <= steps; i++) {
      const sec = scrollSec + ((viewEndSec - scrollSec) * i) / steps;
      const y = toY(tempoAtBeat(map, secToBeat(map, sec)));
      if (i === 0) ctx.moveTo(0, y); else ctx.lineTo((i / steps) * width, y);
    }
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(width, CURVE_ROW);
    ctx.lineTo(0, CURVE_ROW);
    ctx.closePath();
    ctx.fillStyle = 'rgba(198,167,104,0.09)';
    ctx.fill();

    // Events.
    ctx.font = '9px ui-monospace, monospace';
    for (const event of compiled.map.tempos) {
      const sec = beatToSec(map, event.beat);
      const x = toX(sec);
      if (x < -30 || x > width + 30) continue;
      const y = toY(event.bpm);
      ctx.fillStyle = event.curve === 'ramp' ? premium.accent.cool : premium.accent.light;
      ctx.beginPath();
      if (event.curve === 'ramp') {
        // A triangle points where a ramp is going; a square just sits there.
        ctx.moveTo(x - 4, y + 3.5);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x - 4, y - 3.5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      ctx.fillStyle = premium.text.secondary;
      ctx.fillText(fmtBpm(event.bpm), x + 6, y - 4);
    }

    // Signature strip.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, CURVE_ROW, width, METER_ROW);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(0, CURVE_ROW + 0.5);
    ctx.lineTo(width, CURVE_ROW + 0.5);
    ctx.stroke();
    for (const meter of compiled.map.meters) {
      const x = toX(beatToSec(map, barStartBeat(map, meter.bar)));
      if (x < -40 || x > width + 40) continue;
      ctx.fillStyle = premium.accent.deep;
      ctx.fillRect(x, CURVE_ROW + 2, 2, METER_ROW - 4);
      ctx.fillStyle = premium.accent.light;
      ctx.fillText(`${meter.numerator}/${meter.denominator}`, x + 5, CURVE_ROW + 11);
    }

    const px = toX(playheadSec);
    if (px >= 0 && px <= width) {
      ctx.strokeStyle = 'rgba(248,113,113,0.8)';
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, TEMPO_TRACK_HEIGHT);
      ctx.stroke();
    }
  }, [map, compiled, width, scrollSec, pxPerSec, viewEndSec, playheadSec, toX, toY, range]);

  // ── Edit ────────────────────────────────────────────────────────────────

  const hitEvent = useCallback((clientX: number, clientY: number): TempoEvent | null => {
    const rect = boxRef.current?.getBoundingClientRect();
    const y = clientY - (rect?.top ?? 0);
    if (y > CURVE_ROW) return null;
    const x = clientX - (rect?.left ?? 0);
    let best: TempoEvent | null = null;
    let bestDist = GRAB_PX;
    for (const event of compiled.map.tempos) {
      const ex = toX(beatToSec(map, event.beat));
      const ey = toY(event.bpm);
      const dist = Math.hypot(ex - x, ey - y);
      if (dist < bestDist) { bestDist = dist; best = event; }
    }
    return best;
  }, [compiled, map, toX, toY]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const rect = boxRef.current?.getBoundingClientRect();
    const localY = e.clientY - (rect?.top ?? 0);

    // The signature strip: click a marker to cycle it, alt-click to remove.
    if (localY > CURVE_ROW) {
      const sec = secAt(e.clientX);
      const bar = barBeatAt(map, secToBeat(map, sec)).bar;
      const onBar = compiled.map.meters.find((m) => m.bar === bar);
      if (onBar && (e.altKey || e.button === 2)) {
        apply((s) => withTempoMap(s, removeMeterEvent(tempoMapOf(s), onBar.id)));
        return;
      }
      if (onBar) {
        // 4/4 → 3/4 → 6/8 → 5/4 → 7/8 → 4/4.  The signatures anybody
        // actually reaches for, in one control.
        const cycle: Array<[number, number]> = [[4, 4], [3, 4], [6, 8], [5, 4], [7, 8]];
        const index = cycle.findIndex(
          ([n, d]) => n === onBar.numerator && d === onBar.denominator);
        const next = cycle[(index + 1) % cycle.length]!;
        apply((s) => withTempoMap(s, updateMeterEvent(tempoMapOf(s), onBar.id,
          { numerator: next[0], denominator: next[1] })));
        return;
      }
      const at = meterAtBar(map, bar);
      apply((s) => withTempoMap(s,
        addMeterEvent(tempoMapOf(s), bar, at.numerator, at.denominator)));
      return;
    }

    const hit = hitEvent(e.clientX, e.clientY);
    if (hit && (e.altKey || e.button === 2)) {
      apply((s) => withTempoMap(s, removeTempoEvent(tempoMapOf(s), hit.id)));
      return;
    }
    if (e.button !== 0) return;
    if (hit) { setDragId(hit.id); return; }
  }, [map, compiled, apply, secAt, hitEvent]);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if ((e.clientY - (rect?.top ?? 0)) > CURVE_ROW) return;
    // A new change starts at the tempo already in force, so double-clicking
    // does not move the music — it gives you a handle to move it with.
    const beat = Math.round(secToBeat(map, secAt(e.clientX)) / gridDivision) * gridDivision;
    apply((s) => {
      const current = tempoMapOf(s);
      return withTempoMap(s, addTempoEvent(current, beat, tempoAtBeat(current, beat)));
    });
  }, [map, apply, secAt, gridDivision]);

  useEffect(() => {
    if (dragId === null) return;
    const onMove = (e: PointerEvent): void => {
      applyTransient((s) => {
        const current = tempoMapOf(s);
        const event = current.tempos.find((t) => t.id === dragId);
        if (!event) return s;
        // The first event stays at the start: something has to say what the
        // tempo is at bar 1.  Its BPM still follows the drag.
        const beat = event.beat <= 1e-9
          ? 0
          : Math.max(0, Math.round(secToBeat(current, secAt(e.clientX)) / gridDivision) * gridDivision);
        return withTempoMap(s, updateTempoEvent(current, dragId, {
          beat, bpm: bpmAtY(e.clientY),
        }));
      });
    };
    const onUp = (): void => { setDragId(null); commitEdit(); };
    globalThis.addEventListener('pointermove', onMove);
    globalThis.addEventListener('pointerup', onUp);
    return () => {
      globalThis.removeEventListener('pointermove', onMove);
      globalThis.removeEventListener('pointerup', onUp);
    };
  }, [dragId, applyTransient, commitEdit, secAt, bpmAtY, gridDivision]);

  const dragged = dragId
    ? compiled.map.tempos.find((t) => t.id === dragId) : undefined;

  return (
    <div
      ref={boxRef}
      className="relative border-b"
      style={{
        height: TEMPO_TRACK_HEIGHT,
        borderBottomColor: premium.surface.engrave,
        cursor: dragId ? 'grabbing' : 'crosshair',
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      title="더블클릭 = 템포 변화 추가 · 드래그 = 이동 · Alt 클릭 = 삭제 · 아래 줄은 박자"
    >
      <canvas ref={canvasRef} className="block absolute inset-0" />
      {dragged && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => apply((s) => withTempoMap(s, updateTempoEvent(tempoMapOf(s), dragged.id,
            { curve: dragged.curve === 'ramp' ? 'jump' : 'ramp' })))}
          className="absolute top-1 right-1 h-4 px-1.5 rounded text-[8px] border"
          style={{
            borderColor: premium.accent.deep,
            color: dragged.curve === 'ramp' ? premium.accent.cool : premium.text.muted,
            background: premium.surface.panel,
          }}
        >{dragged.curve === 'ramp' ? 'RAMP' : 'JUMP'}</button>
      )}
    </div>
  );
}
