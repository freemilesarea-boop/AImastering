// A knob you can mix with.
//
// Three things separate a control an engineer will use from one they will
// fight:
//
//   • Vertical drag, unbounded.  Rotary drag (following the pointer around the
//     knob) jumps when the pointer crosses the centre, which is exactly where
//     it is when you start.
//   • Shift for fine.  The last dB is where the decisions are.
//   • Double-click for the default.  Undoing an experiment has to be free, or
//     nobody experiments.
//
// The value stream is transient while dragging and committed on release, so a
// two-second sweep is ONE undo step rather than four hundred.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { premium } from '../../../theme/premium.js';

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  unit: string;
  /** Live, on every movement — feed this straight to the graph. */
  onChange: (value: number) => void;
  /** Once, on release — the point at which one undo step is recorded. */
  onCommit: () => void;
  size?: number;
  /** Frequencies and times feel wrong on a linear knob. */
  curve?: 'linear' | 'log';
}

/** Full-scale travel, in pixels.  Shift divides the sensitivity by this. */
const TRAVEL_PX = 180;
const FINE_DIVISOR = 6;
/** Knob sweep, in degrees: 7 o'clock to 5 o'clock. */
const SWEEP_DEG = 280;

function toNormalized(value: number, min: number, max: number, curve: 'linear' | 'log'): number {
  if (max <= min) return 0;
  if (curve === 'log' && min > 0) {
    return Math.log(Math.max(min, value) / min) / Math.log(max / min);
  }
  return (value - min) / (max - min);
}

function fromNormalized(t: number, min: number, max: number, curve: 'linear' | 'log'): number {
  const clamped = Math.max(0, Math.min(1, t));
  if (curve === 'log' && min > 0) return min * Math.pow(max / min, clamped);
  return min + clamped * (max - min);
}

/** Values people read at a glance: no "1000.0 Hz", no "0.10000000000000009". */
export function formatValue(value: number, unit: string): string {
  const abs = Math.abs(value);
  if (unit === 'Hz' && abs >= 1000) return `${(value / 1000).toFixed(2)} kHz`;
  if (unit === 'Hz') return `${Math.round(value)} Hz`;
  if (unit === ':1') return `${value.toFixed(1)}:1`;
  if (unit === '%') return `${Math.round(value)} %`;
  if (unit === 'ms') return abs >= 100 ? `${Math.round(value)} ms` : `${value.toFixed(1)} ms`;
  if (unit === 'dB') return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export default function Knob({
  label, value, min, max, defaultValue, unit, onChange, onCommit,
  size = 46, curve = 'linear',
}: KnobProps) {
  const [dragging, setDragging] = useState(false);
  // Read from a ref inside the move handler: the listener is installed once,
  // and a stale closure would snap the knob back to where the drag started.
  const drag = useRef<{ startY: number; startValue: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startY: e.clientY, startValue: value };
    setDragging(true);
  }, [value]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent): void => {
      const state = drag.current;
      if (!state) return;
      const sensitivity = e.shiftKey ? TRAVEL_PX * FINE_DIVISOR : TRAVEL_PX;
      const delta = (state.startY - e.clientY) / sensitivity;
      const next = fromNormalized(
        toNormalized(state.startValue, min, max, curve) + delta, min, max, curve,
      );
      onChange(Math.max(min, Math.min(max, next)));
    };

    const onUp = (): void => {
      drag.current = null;
      setDragging(false);
      onCommit();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, min, max, curve, onChange, onCommit]);

  const t = toNormalized(value, min, max, curve);
  const angle = -SWEEP_DEG / 2 + t * SWEEP_DEG;
  const radius = size / 2;
  const track = radius - 4;

  // Arc from the knob's rest position to the current value, so a cut and a
  // boost read differently at a glance.
  const restT = toNormalized(defaultValue, min, max, curve);
  const arcFrom = -SWEEP_DEG / 2 + Math.min(restT, t) * SWEEP_DEG;
  const arcTo = -SWEEP_DEG / 2 + Math.max(restT, t) * SWEEP_DEG;

  const polar = (deg: number, r: number): [number, number] => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [radius + r * Math.cos(rad), radius + r * Math.sin(rad)];
  };
  const [ax, ay] = polar(arcFrom, track);
  const [bx, by] = polar(arcTo, track);
  const largeArc = arcTo - arcFrom > 180 ? 1 : 0;
  const [px, py] = polar(angle, track - 3);

  return (
    <div
      className="flex flex-col items-center gap-1 select-none"
      style={{ width: size + 18 }}
      title={`${label} — 드래그로 조절 · Shift 미세 · 더블클릭 기본값`}
    >
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onDoubleClick={(e) => { e.stopPropagation(); onChange(defaultValue); onCommit(); }}
        style={{ cursor: dragging ? 'ns-resize' : 'pointer', touchAction: 'none' }}
      >
        <circle
          cx={radius} cy={radius} r={track}
          fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={3}
        />
        {Math.abs(t - restT) > 0.002 && (
          <path
            d={`M ${ax} ${ay} A ${track} ${track} 0 ${largeArc} 1 ${bx} ${by}`}
            fill="none"
            stroke={premium.accent.base}
            strokeWidth={3}
            strokeLinecap="round"
          />
        )}
        <circle
          cx={radius} cy={radius} r={track - 6}
          fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)"
        />
        <line
          x1={radius} y1={radius} x2={px} y2={py}
          stroke={dragging ? premium.accent.light : 'rgba(235,235,245,0.85)'}
          strokeWidth={2} strokeLinecap="round"
        />
      </svg>
      <span
        className="text-[9px] uppercase tracking-wider truncate w-full text-center"
        style={{ color: premium.text.muted }}
      >{label}</span>
      <span
        className="text-[10px] font-mono tabular-nums"
        style={{ color: dragging ? premium.accent.light : 'rgb(212,212,216)' }}
      >{formatValue(value, unit)}</span>
    </div>
  );
}
