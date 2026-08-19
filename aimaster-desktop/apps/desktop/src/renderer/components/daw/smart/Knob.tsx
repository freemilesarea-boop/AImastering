// Knob — the control the whole Smart Control idea rests on.
//
// Behaviour copied from hardware and from every serious plug-in:
//   • drag vertically (or use the wheel) to change; the pointer is captured,
//     so the value keeps tracking when the cursor leaves the knob
//   • hold Shift for fine adjustment, Alt to snap to the detent
//   • double-click returns to the default
//   • arrow keys work, because a knob nobody can reach by keyboard is not a
//     control, it is a picture
//
// Drawn with SVG so it stays sharp at any zoom: an engraved ring of ticks, a
// brass value arc, and a metal cap with a pointer.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { premium } from '../../../theme/premium.js';

export interface KnobProps {
  value: number;
  min: number;
  max: number;
  /** Value the double-click resets to, and where the arc starts. */
  defaultValue?: number;
  /** Bipolar knobs draw their arc outward from the centre. */
  bipolar?: boolean;
  size?: number;
  label?: string;
  /** Formatted value shown under the knob. */
  display?: string;
  disabled?: boolean;
  /** Marks the value as manually overridden — drawn cool instead of brass. */
  overridden?: boolean;
  onChange: (value: number) => void;
  onCommit?: () => void;
  title?: string;
}

const START_ANGLE = -135;
const END_ANGLE = 135;
const SWEEP = END_ANGLE - START_ANGLE;

function polar(cx: number, cy: number, radius: number, degrees: number): [number, number] {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, radius: number, from: number, to: number): string {
  const [x0, y0] = polar(cx, cy, radius, from);
  const [x1, y1] = polar(cx, cy, radius, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export default function Knob({
  value, min, max, defaultValue, bipolar = false, size = 58,
  label, display, disabled = false, overridden = false, onChange, onCommit, title,
}: KnobProps) {
  const gradientId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const [active, setActive] = useState(false);

  const span = max - min || 1;
  const ratio = Math.max(0, Math.min(1, (value - min) / span));
  const angle = START_ANGLE + ratio * SWEEP;
  const neutral = defaultValue ?? (bipolar ? (min + max) / 2 : min);
  const neutralRatio = Math.max(0, Math.min(1, (neutral - min) / span));
  const neutralAngle = START_ANGLE + neutralRatio * SWEEP;

  const cx = size / 2;
  const cy = size / 2;
  const trackRadius = size / 2 - 3;
  const capRadius = size / 2 - 10;

  const apply = useCallback((next: number) => {
    if (disabled) return;
    onChange(Math.max(min, Math.min(max, next)));
  }, [disabled, min, max, onChange]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startValue: value };
    setActive(true);
  }, [disabled, value]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 180 px of travel covers the whole range; Shift makes it 5× finer.
    const sensitivity = (e.shiftKey ? 0.2 : 1) * (span / 180);
    let next = drag.startValue + (drag.startY - e.clientY) * sensitivity;
    if (e.altKey) next = neutral;
    apply(next);
  }, [apply, span, neutral]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setActive(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    onCommit?.();
  }, [onCommit]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (disabled) return;
    const step = (e.shiftKey ? 0.002 : 0.02) * span;
    apply(value + (e.deltaY < 0 ? step : -step));
  }, [apply, disabled, span, value]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;
    const step = (e.shiftKey ? 0.002 : 0.02) * span;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { apply(value + step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { apply(value - step); e.preventDefault(); }
    if (e.key === 'Home') { apply(neutral); e.preventDefault(); }
  }, [apply, disabled, span, value, neutral]);

  // Release the capture if the component unmounts mid-drag.
  useEffect(() => () => { dragRef.current = null; }, []);

  const arcColor = overridden ? premium.accent.cool : premium.accent.base;
  const arcFrom = bipolar ? neutralAngle : START_ANGLE;
  const showArc = Math.abs(angle - arcFrom) > 0.5;

  return (
    <div className="flex flex-col items-center gap-1 select-none" ref={ref}>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label ?? title ?? 'control'}
        aria-disabled={disabled}
        title={title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onDoubleClick={() => { apply(neutral); onCommit?.(); }}
        style={{
          width: size,
          height: size,
          cursor: disabled ? 'not-allowed' : 'ns-resize',
          opacity: disabled ? 0.45 : 1,
          borderRadius: '50%',
          outline: 'none',
          boxShadow: active ? premium.shadow.focus : undefined,
          transition: `box-shadow ${premium.motion.fast} ${premium.motion.snap}`,
        }}
        className="focus-visible:shadow-[0_0_0_1px_#C6A768]"
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <defs>
            <radialGradient id={`${gradientId}-cap`} cx="50%" cy="28%" r="78%">
              <stop offset="0%"   stopColor="#4A4A58" />
              <stop offset="55%"  stopColor="#2A2A36" />
              <stop offset="100%" stopColor="#14141C" />
            </radialGradient>
            <linearGradient id={`${gradientId}-rim`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="rgba(255,255,255,0.20)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
            </linearGradient>
          </defs>

          {/* Engraved tick ring */}
          {Array.from({ length: 11 }, (_, i) => {
            const tickAngle = START_ANGLE + (i / 10) * SWEEP;
            const [x0, y0] = polar(cx, cy, trackRadius - 1, tickAngle);
            const [x1, y1] = polar(cx, cy, trackRadius - 5, tickAngle);
            return (
              <line key={i} x1={x0} y1={y0} x2={x1} y2={y1}
                stroke={premium.surface.hairlineStrong} strokeWidth={1} strokeLinecap="round" />
            );
          })}

          {/* Track + value arc */}
          <path d={arcPath(cx, cy, trackRadius - 3, START_ANGLE, END_ANGLE)}
            fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={2.5} strokeLinecap="round" />
          {showArc && (
            <path d={arcPath(cx, cy, trackRadius - 3, arcFrom, angle)}
              fill="none" stroke={arcColor} strokeWidth={2.5} strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 4px ${premium.accent.glow})` }} />
          )}

          {/* Cap */}
          <circle cx={cx} cy={cy} r={capRadius} fill={`url(#${gradientId}-cap)`} />
          <circle cx={cx} cy={cy} r={capRadius} fill="none"
            stroke={`url(#${gradientId}-rim)`} strokeWidth={1.4} />

          {/* Pointer */}
          {(() => {
            const [px, py] = polar(cx, cy, capRadius - 4, angle);
            const [ix, iy] = polar(cx, cy, capRadius * 0.32, angle);
            return (
              <line x1={ix} y1={iy} x2={px} y2={py}
                stroke={arcColor} strokeWidth={2} strokeLinecap="round" />
            );
          })()}
          <circle cx={cx} cy={cy} r={1.6} fill="rgba(255,255,255,0.35)" />
        </svg>
      </div>

      {label && (
        <span style={{
          fontFamily: premium.type.sans,
          fontSize: 9,
          letterSpacing: '0.16em',
          color: premium.text.muted,
          textTransform: 'uppercase',
        }}>{label}</span>
      )}
      {display !== undefined && (
        <span style={{
          fontFamily: premium.type.mono,
          fontSize: 10,
          color: overridden ? premium.accent.cool : premium.text.secondary,
          fontVariantNumeric: 'tabular-nums',
        }}>{display}</span>
      )}
    </div>
  );
}
