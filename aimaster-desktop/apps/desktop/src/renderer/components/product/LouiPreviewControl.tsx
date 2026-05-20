// LouiPreviewControl — "Update Preview" affordance for the product layout.
//
// Surfaces the staged-change → re-render loop to the user:
//   • pending-changes badge (count of renderable staged changes)
//   • "Update Preview" button (explicit trigger — render has a cost)
//   • rendering / updated / error state
//   • last-rendered timestamp
//
// Pure presentation — the parent (ProductPage) owns the controller and
// passes state + handlers down.

import React from 'react';
import { surface, text, typography, meter, space, radius } from '../../theme/loui-theme.js';

export type PreviewControlPhase = 'idle' | 'pending' | 'rendering' | 'updated' | 'error';

export interface LouiPreviewControlProps {
  /** Number of renderable staged changes awaiting a preview update. */
  pendingCount: number;
  /** Current render phase. */
  phase: PreviewControlPhase;
  /** Last successful render timestamp (epoch ms), or null. */
  lastRenderedAt?: number | null;
  /** Last error message (when phase === 'error'). */
  error?: string | null;
  /** Click → trigger a preview re-render. */
  onUpdate: () => void;
}

function formatClock(at: number): string {
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

export function LouiPreviewControl(props: LouiPreviewControlProps) {
  const rendering = props.phase === 'rendering';
  const hasPending = props.pendingCount > 0;
  const disabled = rendering || !hasPending;

  let statusNode: React.ReactNode = null;
  switch (props.phase) {
    case 'rendering':
      statusNode = <Status colour={meter.cool.foreground} dot>Re-rendering preview…</Status>;
      break;
    case 'updated':
      statusNode = (
        <Status colour={meter.safe.foreground}>
          Preview updated{props.lastRenderedAt ? ` · ${formatClock(props.lastRenderedAt)}` : ''}
        </Status>
      );
      break;
    case 'error':
      statusNode = <Status colour={meter.danger.foreground}>Render failed{props.error ? ` · ${props.error}` : ''}</Status>;
      break;
    case 'pending':
      statusNode = <Status colour={meter.warn.foreground}>Pending changes — update to hear them</Status>;
      break;
    case 'idle':
    default:
      statusNode = props.lastRenderedAt
        ? <Status colour={text.muted}>Preview current · {formatClock(props.lastRenderedAt)}</Status>
        : <Status colour={text.muted}>Preview reflects the original master</Status>;
      break;
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: space['3'],
      paddingInline: space['4'],
      paddingBlock: space['2'],
      background: surface.background,
      borderBottom: `1px solid ${surface.border}`,
      flexShrink: 0,
    }}>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.medium,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: text.muted,
      }}>
        Preview
      </span>

      {hasPending && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 20,
          paddingInline: 8,
          borderRadius: 999,
          background: 'rgba(167,139,250,0.16)',
          border: '1px solid rgba(167,139,250,0.45)',
          color: meter.accent.foreground,
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {props.pendingCount} pending
        </span>
      )}

      <div style={{ flex: 1 }}>{statusNode}</div>

      <button
        type="button"
        className="no-drag"
        onClick={props.onUpdate}
        disabled={disabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          paddingInline: space['3'],
          borderRadius: radius.chip,
          border: `1px solid ${disabled ? surface.border : 'rgba(167,139,250,0.45)'}`,
          background: disabled ? 'transparent' : 'rgba(167,139,250,0.18)',
          color: disabled ? text.disabled : text.primary,
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.medium,
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'background 120ms ease-out, border-color 120ms ease-out',
        }}
      >
        {rendering ? (
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" />
          </svg>
        ) : (
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8a6 6 0 0 1 10.5-4M14 8a6 6 0 0 1-10.5 4M12.5 1.5v3h-3M3.5 14.5v-3h3" />
          </svg>
        )}
        {rendering ? 'Rendering…' : 'Update Preview'}
      </button>
    </div>
  );
}

function Status({ colour, children, dot }: { colour: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: typography.family.sans,
      fontSize: typography.size.xs,
      color: colour,
    }}>
      {dot && (
        <span style={{
          width: 6, height: 6, borderRadius: 999, background: colour,
        }} />
      )}
      {children}
    </span>
  );
}
