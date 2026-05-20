// LouiModuleStrip — bottom-row module cards (UI shell only).
//
// Five cards arranged in a horizontal strip, matching the bottom row of
// an Ozone-style mastering rack:
//
//   ┌──── EQ ────┬── Dynamics ──┬── Imager ──┬── Limiter ──┬── Export ──┐
//   │ (active)   │ (active)     │ (bypass)   │ (active)    │ (locked)   │
//   └────────────┴──────────────┴────────────┴─────────────┴────────────┘
//
// NO REAL DSP — these cards are visual shells that:
//   • Indicate which modules are wired in the Python pipeline today
//     ("active" = produces a real effect; "bypass" = present but neutral)
//   • Communicate what is coming ("coming-soon", "locked")
//   • Expose a `onSelect(id)` click for future parameter-panel routing
//
// The cards consume Loui theme tokens directly — no Tailwind classes —
// so the visual identity stays consistent with the rest of the product
// layout.

import React from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';

export type ModuleState = 'active' | 'bypass' | 'locked' | 'coming-soon';

export interface ModuleCardDef {
  id: 'eq' | 'dynamics' | 'imager' | 'limiter' | 'export';
  label: string;
  state: ModuleState;
  /** Editorial subtitle — single line under the title. */
  subtitle: string;
  /** Optional readout for the right side (e.g. "−0.8 dB", "12 kHz"). */
  readout?: string;
}

export const LOUI_DEFAULT_MODULES: ModuleCardDef[] = [
  { id: 'eq',       label: 'EQ',          state: 'active',      subtitle: '7-band · adaptive', readout: '±2.4 dB' },
  { id: 'dynamics', label: 'Dynamics',    state: 'active',      subtitle: 'Glue Comp',         readout: '−2.1 dB' },
  { id: 'imager',   label: 'Imager',      state: 'bypass',      subtitle: 'Stereo width',      readout: '+0' },
  { id: 'limiter',  label: 'Limiter',     state: 'active',      subtitle: 'True-peak guard',   readout: '−1.0 dBTP' },
  { id: 'export',   label: 'Export',      state: 'coming-soon', subtitle: 'WAV · MP3 · Report' },
];

export interface LouiModuleStripProps {
  /** Override the default 5-module list. */
  modules?: ModuleCardDef[];
  /** Active card highlight (for future param-panel routing). */
  selectedId?: string;
  /** Click handler — surfaces the card id; no DSP side effects in this milestone. */
  onSelect?: (id: ModuleCardDef['id']) => void;
  /**
   * Per-module pending indicator (M3-P-NEXT-5D-1):
   *   'renderable' — has changes that will reflect on the next preview update
   *   'staged'     — has changes that can't reach the preview yet
   *   null/absent  — no pending changes
   */
  pendingByModule?: Partial<Record<ModuleCardDef['id'], 'renderable' | 'staged' | null>>;
}

// ── State styling ────────────────────────────────────────────────────────

interface ModuleVisual {
  pillColour:     string;
  pillBackground: string;
  pillLabel:      string;
  cardOpacity:    number;
  cardBorder:     string;
}

function visualForState(state: ModuleState, selected: boolean): ModuleVisual {
  switch (state) {
    case 'active':
      return {
        pillColour:     meter.safe.foreground,
        pillBackground: meter.safe.background,
        pillLabel:      'On',
        cardOpacity:    1,
        cardBorder:     selected ? meter.accent.foreground : surface.border,
      };
    case 'bypass':
      return {
        pillColour:     text.muted,
        pillBackground: 'rgba(113,113,122,0.18)',
        pillLabel:      'Bypass',
        cardOpacity:    0.78,
        cardBorder:     surface.border,
      };
    case 'locked':
      return {
        pillColour:     meter.warn.foreground,
        pillBackground: meter.warn.background,
        pillLabel:      'Locked',
        cardOpacity:    0.78,
        cardBorder:     surface.border,
      };
    case 'coming-soon':
      return {
        pillColour:     meter.accent.foreground,
        pillBackground: 'rgba(167,139,250,0.16)',
        pillLabel:      'Soon',
        cardOpacity:    0.72,
        cardBorder:     surface.border,
      };
  }
}

// ── Mini visuals — schematic indicators per module type ─────────────────

function MiniEq() {
  // Three soft bumps representing low / mid / high bands.
  return (
    <svg width={64} height={20} viewBox="0 0 64 20" fill="none">
      <path d="M0 16 Q 8 4, 16 12 T 32 12 T 48 8 T 64 14" stroke={meter.accent.foreground} strokeWidth="1.5" />
    </svg>
  );
}
function MiniComp() {
  // Linear in → knee → flatten — compressor curve.
  return (
    <svg width={64} height={20} viewBox="0 0 64 20" fill="none">
      <path d="M2 18 L 22 18 L 32 10 L 62 8" stroke={meter.safe.foreground} strokeWidth="1.5" />
    </svg>
  );
}
function MiniImager() {
  // Two arrows pointing outward (stereo widening).
  return (
    <svg width={64} height={20} viewBox="0 0 64 20" fill="none" stroke={text.tertiary} strokeWidth="1.4" strokeLinecap="round">
      <path d="M28 10 L 8 10 M 14 4 L 8 10 L 14 16" />
      <path d="M36 10 L 56 10 M 50 4 L 56 10 L 50 16" />
    </svg>
  );
}
function MiniLimiter() {
  // Triangle wave clipping against a ceiling.
  return (
    <svg width={64} height={20} viewBox="0 0 64 20" fill="none">
      <line x1="0" y1="6" x2="64" y2="6" stroke={meter.danger.foreground} strokeWidth="1" strokeDasharray="3 2" />
      <path d="M0 14 L 10 6 L 20 14 L 30 6 L 40 14 L 50 6 L 60 14" stroke={meter.warn.foreground} strokeWidth="1.5" />
    </svg>
  );
}
function MiniExport() {
  return (
    <svg width={64} height={20} viewBox="0 0 64 20" fill="none" stroke={text.tertiary} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="20" height="12" rx="1.5" />
      <path d="M32 10 H 52 M 46 5 L 52 10 L 46 15" />
    </svg>
  );
}

function visualForModule(id: ModuleCardDef['id']): React.ReactNode {
  switch (id) {
    case 'eq':       return <MiniEq />;
    case 'dynamics': return <MiniComp />;
    case 'imager':   return <MiniImager />;
    case 'limiter':  return <MiniLimiter />;
    case 'export':   return <MiniExport />;
  }
}

// ── Card ─────────────────────────────────────────────────────────────────

function ModuleCard({
  def,
  selected,
  onClick,
  pending,
}: {
  def: ModuleCardDef;
  selected: boolean;
  onClick?: () => void;
  pending?: 'renderable' | 'staged' | null;
}) {
  const [hover, setHover] = React.useState(false);
  const v = visualForState(def.state, selected);
  const pendingColour = pending === 'renderable'
    ? meter.accent.foreground
    : pending === 'staged' ? text.muted : null;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        minWidth: 168,
        display: 'flex',
        flexDirection: 'column',
        gap: space['2'],
        padding: space['3'],
        height: 124,
        background: hover ? surface.well : surface.panel,
        border: `1px solid ${v.cardBorder}`,
        borderRadius: radius.panel,
        opacity: v.cardOpacity,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 120ms ease-out, border-color 120ms ease-out, opacity 120ms ease-out',
      }}
    >
      {/* Top row: title + state pill */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: typography.family.sans,
          fontSize: typography.size.md,
          fontWeight: typography.weight.semi,
          color: text.primary,
          letterSpacing: '-0.005em',
        }}>
          {pendingColour && (
            <span
              title={pending === 'renderable' ? 'Pending — will reflect on next preview update' : 'Changed — staged only (not in preview yet)'}
              style={{
                width: 7, height: 7, borderRadius: 999,
                background: pendingColour,
                boxShadow: pending === 'renderable' ? `0 0 5px ${pendingColour}` : 'none',
              }}
            />
          )}
          {def.label}
        </span>
        <span style={{
          height: 18,
          paddingInline: 8,
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: 999,
          color: v.pillColour,
          background: v.pillBackground,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {v.pillLabel}
        </span>
      </div>

      {/* Subtitle */}
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.sm,
        color: text.tertiary,
        lineHeight: 1.25,
      }}>
        {def.subtitle}
      </span>

      {/* Visual + readout */}
      <div style={{
        marginTop: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        {visualForModule(def.id)}
        {def.readout && (
          <span style={{
            fontFamily: typography.family.mono,
            fontSize: typography.size.sm,
            color: text.secondary,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {def.readout}
          </span>
        )}
      </div>
    </button>
  );
}

export function LouiModuleStrip(props: LouiModuleStripProps) {
  const modules = props.modules ?? LOUI_DEFAULT_MODULES;
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: space['2'],
      paddingInline: space['4'],
      paddingBlock: space['3'],
      background: surface.background,
      borderTop: `1px solid ${surface.border}`,
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingInline: 2,
      }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: text.muted,
        }}>
          Module Chain
        </span>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
        }}>
          Click a module to open its parameters (coming soon)
        </span>
      </div>
      <div style={{
        display: 'flex',
        gap: space['3'],
      }}>
        {modules.map((m) => (
          <ModuleCard
            key={m.id}
            def={m}
            selected={m.id === props.selectedId}
            {...(props.pendingByModule?.[m.id] ? { pending: props.pendingByModule[m.id] } : {})}
            {...(props.onSelect ? { onClick: () => props.onSelect!(m.id) } : {})}
          />
        ))}
      </div>
    </div>
  );
}
