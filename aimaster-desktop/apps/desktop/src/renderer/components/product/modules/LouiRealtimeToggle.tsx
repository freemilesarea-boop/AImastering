// LouiRealtimeToggle — dev/QA switch to turn the realtime preview chain on
// or off (REALTIME-SOUND-CHANGE).
//
// The realtime flag is read once per renderer mount, so flipping it
// persists to localStorage and reloads the renderer.  Honest about why
// realtime can't run (readiness reason) and never claims it is live when
// it isn't — it only flips the flag; the status chip reports the result.

import React from 'react';
import { surface, text, typography, radius, meter } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';

export interface LouiRealtimeToggleProps {
  /** The realtime flag is currently ON. */
  enabled: boolean;
  /** Environment can run realtime (AudioContext + AudioWorklet + WASM). */
  ready: boolean;
  /** Readiness reason shown when not ready (e.g. the unavailable detail). */
  readinessLabel?: string;
  /** Flip the flag (persist + reload).  Receives the next desired state. */
  onToggle: (next: boolean) => void;
}

export function LouiRealtimeToggle(props: LouiRealtimeToggleProps) {
  const { enabled, ready } = props;
  const blocked = !enabled && !ready;
  const next = !enabled;
  const label = enabled ? 'Disable Realtime Preview' : 'Enable Realtime Preview';
  const color = enabled ? meter.safe.foreground : blocked ? text.muted : loui.softLavender;
  const border = enabled ? 'rgba(16,185,129,0.45)' : blocked ? surface.border : 'rgba(167,139,250,0.45)';
  const title = blocked
    ? `Realtime unavailable: ${props.readinessLabel ?? 'environment not ready'}`
    : enabled
      ? 'Turn the realtime WASM preview off and reload'
      : 'Turn the realtime WASM preview on and reload (dev/QA)';

  return (
    <button
      type="button"
      className="no-drag"
      title={title}
      onClick={() => props.onToggle(next)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: radius.chip,
        border: `1px solid ${border}`, background: surface.panel,
        color, cursor: 'pointer',
        fontFamily: typography.family.sans, fontSize: typography.size.xs,
        fontWeight: typography.weight.medium,
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: 999,
        background: enabled ? meter.safe.foreground : surface.overlay,
        boxShadow: enabled ? `0 0 6px ${meter.safe.foreground}` : 'none',
      }} />
      {label}
    </button>
  );
}
