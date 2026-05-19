// LouiKnob — circular parameter knob primitive.
//
// Visual: 64×64 SVG, arc 270° (from -135° to +135°), indicator line
// from centre to arc edge.  Track is dimmed; filled arc uses
// `meter.accent`.
//
// Interaction (UI shell, no DSP write):
//   • Pointer drag — vertical drag changes value
//     (drag up = increase, sensitivity 1 unit per 2 px)
//   • Keyboard — when focused, ArrowUp/ArrowDown +/- step,
//     PageUp/PageDown +/- step×10, Home/End to min/max
//   • Wheel — scroll up/down for +/- step
//
// Value model:
//   • Controlled component — caller owns `value`, listens to `onChange`
//   • Bounded to [min, max] with optional `step` quantisation
//
// TODO(M3-P-NEXT-5 binding): replace `onChange` callers with engine
// parameter writes once the Rust mastering chain bridge lands.

import React from 'react';
import { surface, text, typography, meter } from '../../../theme/loui-theme.js';

export interface LouiKnobProps {
  value: number;
  min:   number;
  max:   number;
  step?: number;
  /** Display label drawn under the knob. */
  label?: string;
  /** Display unit drawn after the value (e.g. "dB", "ms"). */
  unit?: string;
  /** Optional formatter for the centre readout.  Default `value.toFixed(1)`. */
  format?: (v: number) => string;
  /** Diameter in px.  Default 64. */
  size?: number;
  /** Disabled — no interaction, dimmed. */
  disabled?: boolean;
  onChange?: (v: number) => void;
}

const ANGLE_START = -135; // degrees, 6 o'clock open
const ANGLE_END   =  135;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function quantise(v: number, step: number): number {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}

export function LouiKnob(props: LouiKnobProps) {
  const size = props.size ?? 64;
  const step = props.step ?? (props.max - props.min) / 100;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  // Normalised position 0..1
  const norm = clamp((props.value - props.min) / (props.max - props.min), 0, 1);
  const angle = ANGLE_START + (ANGLE_END - ANGLE_START) * norm;
  const rad = (angle - 90) * Math.PI / 180; // SVG: 0° = right; we want 0° = top

  const indicatorX = cx + Math.cos(rad) * (r - 2);
  const indicatorY = cy + Math.sin(rad) * (r - 2);

  // Arc path — describeArc(cx, cy, r, startAngle, endAngle)
  const arcPath = describeArc(cx, cy, r, ANGLE_START, angle);

  const buttonRef = React.useRef<HTMLButtonElement | null>(null);

  const change = React.useCallback((next: number) => {
    if (!props.onChange) return;
    const quant = quantise(clamp(next, props.min, props.max), step);
    if (quant !== props.value) props.onChange(quant);
  }, [props, step]);

  // Pointer drag — vertical change
  const pointerStart = React.useRef<{ y: number; v: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (props.disabled) return;
    pointerStart.current = { y: e.clientY, v: props.value };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointerStart.current) return;
    const dy = pointerStart.current.y - e.clientY;
    const range = props.max - props.min;
    // 200 px of drag covers the full range
    const next = pointerStart.current.v + (dy / 200) * range;
    change(next);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointerStart.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // Keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (props.disabled) return;
    let next = props.value;
    switch (e.key) {
      case 'ArrowUp':   case 'ArrowRight': next = props.value + step;     break;
      case 'ArrowDown': case 'ArrowLeft':  next = props.value - step;     break;
      case 'PageUp':                       next = props.value + step * 10; break;
      case 'PageDown':                     next = props.value - step * 10; break;
      case 'Home':                         next = props.min;              break;
      case 'End':                          next = props.max;              break;
      default: return;
    }
    e.preventDefault();
    change(next);
  };

  // Wheel
  const onWheel = (e: React.WheelEvent) => {
    if (props.disabled) return;
    e.preventDefault();
    change(props.value + (e.deltaY > 0 ? -step : step));
  };

  const fmt = props.format ?? ((v: number) => v.toFixed(1));

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      opacity: props.disabled ? 0.45 : 1,
    }}>
      <button
        ref={buttonRef}
        type="button"
        role="slider"
        aria-label={props.label}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        aria-orientation="vertical"
        aria-disabled={props.disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        style={{
          width: size,
          height: size,
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: props.disabled ? 'not-allowed' : 'ns-resize',
          touchAction: 'none',
          borderRadius: '50%',
          outline: 'none',
        }}
        onFocus={(e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${meter.accent.foreground}`; }}
        onBlur={(e)  => { e.currentTarget.style.boxShadow = 'none'; }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Background ring */}
          <circle
            cx={cx} cy={cy} r={r}
            fill={surface.well}
            stroke={surface.border}
            strokeWidth={1}
          />
          {/* Track arc — full sweep, dimmed */}
          <path
            d={describeArc(cx, cy, r, ANGLE_START, ANGLE_END)}
            stroke={surface.border}
            strokeWidth={2.5}
            strokeLinecap="round"
            fill="none"
          />
          {/* Filled arc up to current value */}
          {norm > 0 && (
            <path
              d={arcPath}
              stroke={meter.accent.foreground}
              strokeWidth={2.5}
              strokeLinecap="round"
              fill="none"
            />
          )}
          {/* Indicator line */}
          <line
            x1={cx}
            y1={cy}
            x2={indicatorX}
            y2={indicatorY}
            stroke={text.primary}
            strokeWidth={2}
            strokeLinecap="round"
          />
          {/* Centre dot */}
          <circle cx={cx} cy={cy} r={2.5} fill={text.primary} />
        </svg>
      </button>

      {/* Value + unit */}
      <span style={{
        fontFamily: typography.family.mono,
        fontSize: typography.size.sm,
        color: text.primary,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
      }}>
        {fmt(props.value)}{props.unit && (
          <span style={{ color: text.muted, marginLeft: 3 }}>{props.unit}</span>
        )}
      </span>

      {/* Label */}
      {props.label && (
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          lineHeight: 1,
        }}>
          {props.label}
        </span>
      )}
    </div>
  );
}

// ── SVG arc helper ───────────────────────────────────────────────────────

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end   = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

