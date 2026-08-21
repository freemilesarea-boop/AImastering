// One automation lane, drawn and edited.
//
// The lane is the honest picture of what the engine will do: the polyline is
// the breakpoints, interpolated exactly the way `pointValueAt` interpolates
// them, flat past both ends because that is what the player does past both
// ends.  Nothing here is decorative.
//
// Editing is the three gestures every DAW has and no others:
//
//   click empty       put a breakpoint there and start dragging it
//   drag a breakpoint move it, held between its neighbours
//   alt-click / right  delete it
//
// A whole drag is one undo step — it writes through `applyTransient` and
// commits when the pointer comes up — which is the same rule clip drags and
// plugin knobs follow.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAutomationStore } from '../../../stores/automationStore.js';
import {
  insertPoint, movePoint, nearestPoint, pointValueAt, removePointAt,
} from '../../../daw/model/automation.js';
import { updateLane } from '../../../daw/model/session-ops.js';
import {
  availableTargets, clampToRange, describeTarget, ensureLane, laneRange,
  setLaneVisible, type LaneRange,
} from '../../../daw/edit/automation-lanes.js';
import { laneKey, targetKey } from '../../../daw/model/automation.js';
import { premium } from '../../../theme/premium.js';
import type {
  AutomationLane as Lane, AutomationMode, Track,
} from '../../../daw/model/types.js';

/** Every lane is this tall.  Enough to aim at, small enough to stack five. */
export const AUTOMATION_LANE_HEIGHT = 56;

const PAD = 7;
/** How close the pointer has to be to grab a breakpoint. */
const GRAB_PX = 7;

const MODES: AutomationMode[] = ['off', 'read', 'touch', 'latch', 'write', 'trim'];

const MODE_COLOR: Record<AutomationMode, string> = {
  off:   premium.text.faint,
  read:  premium.accent.cool,
  touch: premium.accent.base,
  latch: premium.accent.base,
  write: premium.accent.danger,
  trim:  premium.accent.good,
};

function formatValue(range: LaneRange, value: number): string {
  if (range.unit === 'dB') return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
  if (range.min === -1 && range.max === 1) {
    if (Math.abs(value) < 0.005) return 'C';
    return value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`;
  }
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

// ── The header cell, in the track-header column ─────────────────────────────

export function AutomationLaneHeader({ track, lane }: { track: Track; lane: Lane }) {
  const apply = useDawStore((s) => s.apply);
  const recording = useAutomationStore(
    (s) => s.gestures[laneKey(track.id, lane.target)] !== undefined);
  const range = laneRange(track, lane.target);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const now = pointValueAt(lane.points, playheadSec, range.neutral);

  return (
    <div
      className="flex flex-col justify-center gap-1 pl-5 pr-1.5 border-b border-zinc-900"
      style={{ height: AUTOMATION_LANE_HEIGHT, background: premium.surface.well }}
    >
      <div className="flex items-center gap-1">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: recording ? premium.accent.danger : MODE_COLOR[lane.mode],
            boxShadow: recording ? `0 0 6px ${premium.accent.danger}` : 'none',
          }}
        />
        {/* The lane's title is also its target picker.  With a channel's
            plugin parameters now on the menu there are far too many for a
            "show all lanes" toggle, and switching a lane to another target is
            what a lane header does in every DAW — the lane being left keeps
            its breakpoints, it is only hidden. */}
        <select
          value={targetKey(lane.target)}
          onChange={(e) => {
            const next = availableTargets(track).find((t) => targetKey(t) === e.target.value);
            if (!next) return;
            apply((s) => {
              const hidden = setLaneVisible(s, track.id, lane.target, false);
              const { session } = ensureLane(hidden, track.id, next);
              return setLaneVisible(session, track.id, next, true);
            });
          }}
          className="text-[10px] truncate flex-1 h-4 bg-transparent border-none outline-none"
          style={{ color: premium.text.secondary, maxWidth: 118 }}
          title={describeTarget(track, lane.target)}
        >
          {availableTargets(track).map((t) => (
            <option key={targetKey(t)} value={targetKey(t)}>{describeTarget(track, t)}</option>
          ))}
          {/* A lane whose device has gone keeps its own entry, so the header
              still says what it is instead of showing someone else's name. */}
          {!availableTargets(track).some((t) => targetKey(t) === targetKey(lane.target)) && (
            <option value={targetKey(lane.target)}>{describeTarget(track, lane.target)}</option>
          )}
        </select>
        <span
          className="text-[9px] font-mono tabular-nums"
          style={{ color: recording ? premium.accent.danger : premium.text.muted }}
        >{formatValue(range, now)}</span>
      </div>
      <div className="flex items-center gap-1">
        <select
          value={lane.mode}
          onChange={(e) => apply((s) => updateLane(s, track.id, lane.id,
            (l) => ({ ...l, mode: e.target.value as AutomationMode })))}
          className="flex-1 h-4 rounded text-[8px] px-0.5 bg-transparent border"
          style={{ borderColor: 'rgba(255,255,255,0.12)', color: MODE_COLOR[lane.mode] }}
          title="오토메이션 모드"
        >
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button
          onClick={() => apply((s) => setLaneVisible(s, track.id, lane.target, false))}
          title="레인 접기 (오토메이션은 그대로 남습니다)"
          className="w-4 h-4 rounded text-[9px] leading-none border"
          style={{ borderColor: 'rgba(255,255,255,0.12)', color: premium.text.muted }}
        >×</button>
      </div>
    </div>
  );
}

// ── The lane itself ─────────────────────────────────────────────────────────

interface Viewport { scrollSec: number; pxPerSec: number; width: number; height: number }

export default function AutomationLaneCanvas({
  track, lane, viewport,
}: { track: Track; lane: Lane; viewport: Viewport }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit = useDawStore((s) => s.commitEdit);
  const apply = useDawStore((s) => s.apply);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const recording = useAutomationStore(
    (s) => s.gestures[laneKey(track.id, lane.target)] !== undefined);
  // Redraw while a pass is being written, even though `lane` has not changed
  // yet — the points only land when the pass ends.
  const tick = useAutomationStore((s) => s.tick);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const { scrollSec, pxPerSec, width } = viewport;
  const height = AUTOMATION_LANE_HEIGHT;
  const range = laneRange(track, lane.target);

  const toX = useCallback(
    (sec: number) => (sec - scrollSec) * pxPerSec, [scrollSec, pxPerSec]);
  const toY = useCallback((value: number) => {
    const t = (value - range.min) / Math.max(1e-9, range.max - range.min);
    return height - PAD - t * (height - PAD * 2);
  }, [range.min, range.max, height]);
  const secAt = useCallback((clientX: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    return Math.max(0, scrollSec + ((clientX - (rect?.left ?? 0)) / pxPerSec));
  }, [scrollSec, pxPerSec]);
  const valueAtY = useCallback((clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    const y = clientY - (rect?.top ?? 0);
    const t = 1 - (y - PAD) / Math.max(1, height - PAD * 2);
    return clampToRange(range, range.min + t * (range.max - range.min));
  }, [range, height]);

  // ── Draw ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Ground and the line the value means nothing at.
    ctx.fillStyle = premium.surface.well;
    ctx.fillRect(0, 0, width, height);
    const neutralY = toY(range.neutral);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(neutralY) + 0.5);
    ctx.lineTo(width, Math.round(neutralY) + 0.5);
    ctx.stroke();

    const points = lane.points;
    const off = lane.mode === 'off';
    const stroke = off ? 'rgba(140,140,160,0.4)'
      : recording ? premium.accent.danger : premium.accent.base;

    // The polyline, extended flat to both edges exactly as the engine reads it.
    ctx.beginPath();
    if (points.length === 0) {
      const y = toY(range.neutral);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    } else {
      ctx.moveTo(0, toY(pointValueAt(points, scrollSec, range.neutral)));
      for (const p of points) {
        const x = toX(p.timeSec);
        if (x < -2 || x > width + 2) continue;
        ctx.lineTo(x, toY(p.value));
      }
      ctx.lineTo(width, toY(pointValueAt(points, scrollSec + width / pxPerSec, range.neutral)));
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill down to the neutral line: which side of nothing this sits on is
    // the thing you read at a glance.
    ctx.lineTo(width, neutralY);
    ctx.lineTo(0, neutralY);
    ctx.closePath();
    ctx.fillStyle = off ? 'rgba(140,140,160,0.06)' : 'rgba(198,167,104,0.10)';
    ctx.fill();

    // Breakpoints.
    for (const p of points) {
      const x = toX(p.timeSec);
      if (x < -4 || x > width + 4) continue;
      const y = toY(p.value);
      ctx.fillStyle = stroke;
      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    }

    // What the lane reads at the playhead.
    const px = toX(playheadSec);
    if (px >= 0 && px <= width && points.length > 0) {
      const y = toY(pointValueAt(points, playheadSec, range.neutral));
      ctx.beginPath();
      ctx.arc(px, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = recording ? premium.accent.danger : premium.accent.light;
      ctx.fill();
    }

    if (recording) {
      ctx.strokeStyle = 'rgba(212,106,106,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    }
  }, [lane, width, height, scrollSec, pxPerSec, playheadSec, recording, tick,
      range, toX, toY]);

  // ── Edit ────────────────────────────────────────────────────────────────

  const grabTolerances = useCallback(() => ({
    timeTol: GRAB_PX / pxPerSec,
    valueTol: (GRAB_PX / Math.max(1, height - PAD * 2)) * (range.max - range.min),
  }), [pxPerSec, height, range]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const timeSec = secAt(e.clientX);
    const value = valueAtY(e.clientY);
    const { timeTol, valueTol } = grabTolerances();
    const hit = nearestPoint(lane.points, timeSec, value, timeTol, valueTol);

    // Alt or right button removes; there is no other way to lose a point.
    if (hit >= 0 && (e.altKey || e.button === 2)) {
      apply((s) => updateLane(s, track.id, lane.id, (l) => removePointAt(l, hit)));
      return;
    }
    if (e.button !== 0) return;

    if (hit >= 0) {
      setDragIndex(hit);
      return;
    }
    // Empty lane: drop a breakpoint and keep hold of it.
    applyTransient((s) => updateLane(s, track.id, lane.id,
      (l) => insertPoint(l, { timeSec, value })));
    const next = useDawStore.getState().session.tracks
      .find((t) => t.id === track.id)?.automation.find((l) => l.id === lane.id);
    const index = next?.points.findIndex((p) => Math.abs(p.timeSec - timeSec) < 1e-6) ?? -1;
    setDragIndex(index >= 0 ? index : null);
  }, [lane, track.id, secAt, valueAtY, grabTolerances, apply, applyTransient]);

  useEffect(() => {
    if (dragIndex === null) return;
    const onMove = (e: PointerEvent): void => {
      applyTransient((s) => updateLane(s, track.id, lane.id,
        (l) => movePoint(l, dragIndex, secAt(e.clientX), valueAtY(e.clientY))));
    };
    const onUp = (): void => { setDragIndex(null); commitEdit(); };
    globalThis.addEventListener('pointermove', onMove);
    globalThis.addEventListener('pointerup', onUp);
    return () => {
      globalThis.removeEventListener('pointermove', onMove);
      globalThis.removeEventListener('pointerup', onUp);
    };
  }, [dragIndex, track.id, lane.id, secAt, valueAtY, applyTransient, commitEdit]);

  return (
    <div
      ref={boxRef}
      className="relative border-b border-zinc-900"
      style={{ height, cursor: dragIndex === null ? 'crosshair' : 'grabbing' }}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="block absolute inset-0" />
    </div>
  );
}
