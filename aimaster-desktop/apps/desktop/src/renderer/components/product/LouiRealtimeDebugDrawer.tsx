// LouiRealtimeDebugDrawer — collapsible, default-hidden container for the
// dev/QA realtime metrics panel (REALTIME-SOUND-CHANGE UX cleanup).
//
// The detail panel used to float over the Loudness / Limiter / module UI.
// Now only a small status chip shows by default; "Details" opens the panel
// in a bottom-right drawer (capped height + scroll, ESC / × to close).  The
// open/closed state persists in localStorage so QA can keep it open.

import React from 'react';
import { surface, text, typography, radius, meter } from '../../theme/loui-theme.js';
import { loui } from '../../theme/loui-home.js';
import type { RealtimePreviewUiStatus } from '../../audio/realtime-ui-status.js';

const LS_KEY = 'loui.realtimeDebugOpen';

function readOpen(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) === 'true'; }
  catch { return false; }
}
function writeOpen(v: boolean): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, v ? 'true' : 'false'); }
  catch { /* ignore */ }
}

const STATUS_DOT: Record<RealtimePreviewUiStatus, string> = {
  active: meter.safe.foreground,
  passthrough: loui.warningAmber,
  starting: loui.warningAmber,
  waiting: loui.warningAmber,
  bypassed: loui.warningAmber,
  failed: meter.danger.foreground,
  unavailable: meter.danger.foreground,
  off: surface.overlay,
};

const STATUS_TEXT: Record<RealtimePreviewUiStatus, string> = {
  active: 'Realtime active',
  passthrough: 'Realtime starting',
  starting: 'Realtime starting',
  waiting: 'Realtime waiting',
  bypassed: 'Realtime bypassed',
  failed: 'Realtime failed',
  unavailable: 'Realtime unavailable',
  off: 'Realtime off',
};

export interface LouiRealtimeDebugDrawerProps {
  status: RealtimePreviewUiStatus;
  /** The detail panel to show when expanded. */
  children: React.ReactNode;
}

export function LouiRealtimeDebugDrawer({ status, children }: LouiRealtimeDebugDrawerProps) {
  const [open, setOpen] = React.useState<boolean>(readOpen);
  const close = React.useCallback(() => { setOpen(false); writeOpen(false); }, []);
  const toggle = React.useCallback(() => { setOpen((p) => { writeOpen(!p); return !p; }); }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const dot = STATUS_DOT[status];

  return (
    <div style={{ position: 'fixed', bottom: 14, right: 14, zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'none' }}>
      {open && (
        <div
          role="dialog"
          aria-label="Realtime preview details"
          style={{
            pointerEvents: 'auto',
            maxHeight: '60vh', overflowY: 'auto',
            borderRadius: radius.panel, border: `1px solid ${surface.border}`,
            background: surface.background, boxShadow: '0 12px 40px -8px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 10px', borderBottom: `1px solid ${surface.border}`,
            position: 'sticky', top: 0, background: surface.background,
          }}>
            <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, fontWeight: typography.weight.semi, letterSpacing: '0.1em', textTransform: 'uppercase', color: text.muted }}>
              Realtime details
            </span>
            <button
              type="button" aria-label="Close" onClick={close} className="no-drag"
              style={{ background: 'none', border: 'none', color: text.tertiary, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
            >×</button>
          </div>
          <div style={{ padding: 8 }}>{children}</div>
        </div>
      )}

      <button
        type="button" onClick={toggle} className="no-drag"
        aria-expanded={open}
        title="Toggle realtime preview details (dev/QA)"
        style={{
          pointerEvents: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '5px 11px', borderRadius: radius.chip,
          border: `1px solid ${surface.border}`, background: surface.panel,
          color: text.secondary, cursor: 'pointer',
          fontFamily: typography.family.sans, fontSize: typography.size.xs, fontWeight: typography.weight.medium,
          boxShadow: '0 4px 14px -6px rgba(0,0,0,0.5)',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, boxShadow: status === 'active' ? `0 0 6px ${dot}` : 'none' }} />
        {STATUS_TEXT[status]}
        <span style={{ color: text.muted }}>· {open ? 'Hide' : 'Details'}</span>
      </button>
    </div>
  );
}
