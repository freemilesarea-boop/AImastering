// LouiABCompare — Before / After instant compare (M3-O-NEXT-7).
//
// A two-state toggle (A = Before / B = After) with a keyboard shortcut
// (B) for instant comparison.  The actual audio source swap is owned by
// the parent (ProductPage) — this component is the affordance + state
// surface, so the comparison is a REAL preview source swap, never a fake
// bypass.
//
// Optional loudness compensation: when the before/after loudness differs
// (e.g. the user changed Target LUFS), the parent applies a volume trim
// so the comparison reflects TONE, not loudness.  This component just
// reflects whether compensation is on.

import React from 'react';
import { surface, text, typography, meter, space, radius } from '../../theme/loui-theme.js';

export type ABMode = 'before' | 'after';

export interface LouiABCompareProps {
  /** Current comparison side. */
  mode: ABMode;
  /** Whether a distinct "before" (original master) is available to compare. */
  available: boolean;
  /** Toggle handler — parent performs the real source swap. */
  onToggle: (mode: ABMode) => void;
  /** Loudness compensation enabled (parent applies the volume trim). */
  compensated?: boolean;
  /** Toggle loudness compensation. */
  onToggleCompensation?: (on: boolean) => void;
  /** Loudness delta (After − Before) in LU, for the compensation label. */
  loudnessDeltaLu?: number | null;
}

/**
 * Register the global "B" shortcut to flip the A/B mode while mounted.
 * Ignores the key when focus is in a text input.
 */
export function useABShortcut(mode: ABMode, available: boolean, onToggle: (m: ABMode) => void): void {
  React.useEffect(() => {
    if (!available) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'b' && e.key !== 'B') return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      onToggle(mode === 'before' ? 'after' : 'before');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, available, onToggle]);
}

function Segment({
  label, sub, active, accent, disabled, onClick,
}: {
  label: string; sub: string; active: boolean; accent: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        minWidth: 56,
        height: 28,
        paddingInline: space['3'],
        borderRadius: radius.chip,
        border: `1px solid ${active ? accent : 'transparent'}`,
        background: active ? 'rgba(167,139,250,0.14)' : 'transparent',
        color: disabled ? text.disabled : active ? text.primary : text.tertiary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: typography.family.sans,
        transition: 'background 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out',
      }}
    >
      <span style={{ fontSize: typography.size.sm, fontWeight: typography.weight.semi, lineHeight: 1 }}>{label}</span>
      <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.8 }}>{sub}</span>
    </button>
  );
}

export function LouiABCompare(props: LouiABCompareProps) {
  const accent = meter.accent.foreground;
  const delta = props.loudnessDeltaLu;
  return (
    <div
      className="no-drag"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: space['2'],
      }}
    >
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: 2,
        gap: 2,
        background: surface.well,
        border: `1px solid ${surface.border}`,
        borderRadius: radius.chip,
      }}>
        <Segment label="A" sub="Before" active={props.mode === 'before'} accent={accent}
                 disabled={!props.available} onClick={() => props.onToggle('before')} />
        <Segment label="B" sub="After" active={props.mode === 'after'} accent={accent}
                 onClick={() => props.onToggle('after')} />
      </div>

      {/* Keyboard hint */}
      <span style={{
        fontFamily: typography.family.mono,
        fontSize: 9,
        color: text.muted,
        letterSpacing: '0.06em',
        border: `1px solid ${surface.border}`,
        borderRadius: 4,
        padding: '1px 4px',
      }}>
        B
      </span>

      {/* Loudness compensation toggle */}
      {props.onToggleCompensation && (
        <button
          type="button"
          onClick={() => props.onToggleCompensation!(!props.compensated)}
          aria-pressed={props.compensated}
          title={typeof delta === 'number'
            ? `Loudness match (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} LU)`
            : 'Loudness match'}
          style={{
            height: 22,
            paddingInline: 8,
            borderRadius: radius.chip,
            border: `1px solid ${props.compensated ? meter.safe.foreground : surface.border}`,
            background: props.compensated ? meter.safe.background : 'transparent',
            color: props.compensated ? meter.safe.foreground : text.muted,
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          LU match{typeof delta === 'number' && delta !== 0 ? ` ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` : ''}
        </button>
      )}
    </div>
  );
}
