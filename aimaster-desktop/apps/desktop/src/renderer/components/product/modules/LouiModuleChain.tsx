// LouiModuleChain — the modular signal-flow rail (OZONE-STYLE-MODULE-SUITE).
//
// Shows the chain order, each module's honest status, enable/bypass, and
// the active selection.  Planned modules are visible but clearly badged
// "Coming soon" and are not interactive beyond selection (no fake DSP).
// Pure presentational — selection / bypass are callbacks.

import React from 'react';
import { surface, text, typography, radius, space } from '../../../theme/loui-theme.js';
import { loui, louiAlpha } from '../../../theme/loui-home.js';
import { LouiModuleStatusBadge } from './LouiModuleStatusBadge.js';
import { LOUI_MODULES, type LouiModule } from '../../../audio/modules/loui-module-suite.js';

export interface LouiModuleChainProps {
  /** Module ids to show, in chain order.  Defaults to the full suite. */
  moduleIds?: string[];
  activeId?: string;
  /** Per-module bypass map (id → bypassed). */
  bypassed?: Record<string, boolean>;
  onSelect?: (id: string) => void;
  onToggleBypass?: (id: string) => void;
}

function ModuleCard({
  m, active, bypassed, onSelect, onToggleBypass,
}: {
  m: LouiModule; active: boolean; bypassed: boolean;
  onSelect?: (id: string) => void; onToggleBypass?: (id: string) => void;
}) {
  const planned = m.status === 'planned';
  const dimmed = planned || bypassed;
  return (
    <div
      onClick={() => onSelect?.(m.id)}
      style={{
        flexShrink: 0, width: 150, padding: space['3'], borderRadius: radius.panel, cursor: 'pointer',
        border: `1px solid ${active ? louiAlpha.lav(0.5) : surface.border}`,
        background: active ? `linear-gradient(160deg, ${louiAlpha.lav(0.10)}, ${surface.panel})` : surface.panel,
        boxShadow: active ? `0 0 14px -4px ${loui.glowLavender}` : 'none',
        opacity: dimmed ? 0.55 : 1,
        transition: 'opacity 120ms, border-color 120ms, box-shadow 120ms',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.sm, fontWeight: typography.weight.semi, color: active ? '#fff' : text.secondary }}>
          {m.displayName}
        </span>
        {!planned && m.paramModuleId && (
          <button
            type="button"
            aria-label="bypass"
            onClick={(e) => { e.stopPropagation(); onToggleBypass?.(m.id); }}
            className="no-drag"
            title={bypassed ? 'Enable' : 'Bypass'}
            style={{
              width: 26, height: 15, borderRadius: 999, flexShrink: 0, cursor: 'pointer',
              border: `1px solid ${bypassed ? surface.border : louiAlpha.lav(0.5)}`,
              background: bypassed ? surface.well : louiAlpha.lav(0.25),
              position: 'relative', transition: 'background 120ms, border-color 120ms',
            }}
          >
            <span style={{
              position: 'absolute', top: 1, left: bypassed ? 1 : 12, width: 11, height: 11, borderRadius: 999,
              background: bypassed ? text.muted : loui.primaryLavender, transition: 'left 120ms',
            }} />
          </button>
        )}
      </div>
      <LouiModuleStatusBadge status={m.status} size="xs" />
      {m.algorithmName && !planned && (
        <span style={{ fontFamily: typography.family.sans, fontSize: 9, color: loui.softLavender, letterSpacing: '0.04em' }}>{m.algorithmName}</span>
      )}
    </div>
  );
}

export function LouiModuleChain(props: LouiModuleChainProps) {
  const ids = props.moduleIds ?? LOUI_MODULES.map((m) => m.id);
  const mods = ids.map((id) => LOUI_MODULES.find((m) => m.id === id)).filter(Boolean) as LouiModule[];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
      <span style={{
        fontFamily: typography.family.sans, fontSize: typography.size.xs, fontWeight: typography.weight.medium,
        letterSpacing: '0.16em', textTransform: 'uppercase', color: loui.softLavender,
      }}>
        Module Chain
      </span>
      <div style={{ display: 'flex', gap: space['2'], overflowX: 'auto', paddingBottom: 4 }}>
        {mods.map((m, i) => (
          <React.Fragment key={m.id}>
            {i > 0 && (
              <span aria-hidden style={{ alignSelf: 'center', color: text.muted, flexShrink: 0 }}>→</span>
            )}
            <ModuleCard
              m={m}
              active={m.id === props.activeId}
              bypassed={Boolean(props.bypassed?.[m.id])}
              {...(props.onSelect ? { onSelect: props.onSelect } : {})}
              {...(props.onToggleBypass ? { onToggleBypass: props.onToggleBypass } : {})}
            />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
