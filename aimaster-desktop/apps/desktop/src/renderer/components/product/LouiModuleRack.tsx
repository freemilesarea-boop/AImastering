// LouiModuleRack — the signal chain, top to bottom.
//
// The five-card strip worked when there were five modules.  Twenty do not
// fit in a strip, and cramming them in would lose the one thing a mastering
// rack has to communicate: WHAT ORDER THINGS HAPPEN IN.  So the rack is a
// vertical list in chain order, grouped by stage.
//
// Every row answers three questions without a click:
//
//   1. Is it doing anything?  — an engaged module carries an accent rail;
//      an untouched one is quiet; a bypassed one is struck through.
//   2. How much?               — the live readout column shows the module's
//      own metric (gain reduction, applied move, notch depth).
//   3. Can I trust it?         — modules with no DSP are badged, never
//      dressed up to look like the ones that work.
//
// Restraint is deliberate. Twenty rows of colour is noise, so colour is
// spent only on the engaged rail and on the readout when a module is
// actually moving the signal. Everything else is greyscale.

import React, { useMemo } from 'react';
import {
  LOUI_MODULES,
  CHAIN_MODULE_IDS,
  MODULE_CATEGORY_LABEL,
  MODULE_STATUS_LABEL,
  getModule,
  type LouiModule,
  type ModuleCategory,
} from '../../audio/modules/loui-module-suite.js';
import type { ModuleId } from '../../audio/parameters/index.js';
import { surface, text, typography, space, radius, meter } from '../../theme/loui-theme.js';

/** Live readout for one module, supplied by the caller's metering. */
export interface ModuleReadout {
  /** Short value string — "−3.2 dB", "+1.8 dB", "18 dB". */
  value: string;
  /** True when the module is currently moving the signal. */
  active: boolean;
}

export interface LouiModuleRackProps {
  /** Which module's panel is open. */
  selectedId?: string;
  /** Modules the engine config actually carries right now. */
  engagedIds?: readonly string[];
  /** Per-module bypass, keyed by parameter module id. */
  bypassById?: Partial<Record<ModuleId, boolean>>;
  /** Live metering per module id. */
  readouts?: Partial<Record<string, ModuleReadout>>;
  /** Total chain latency in samples, shown in the footer when non-zero. */
  latencySamples?: number;
  /** Sample rate, so latency can be shown in milliseconds. */
  sampleRate?: number;
  onSelect?: (id: string) => void;
  onToggleBypass?: (paramModuleId: ModuleId, bypass: boolean) => void;
}

/** Stage headings, in chain order. */
const STAGES: { key: string; label: string; categories: ModuleCategory[] }[] = [
  { key: 'restore',   label: 'Restoration', categories: ['restoration'] },
  { key: 'tone',      label: 'Tone',        categories: ['tone', 'reference'] },
  { key: 'dynamics',  label: 'Dynamics',    categories: ['dynamics', 'lowend'] },
  { key: 'character', label: 'Character',   categories: ['character'] },
  { key: 'output',    label: 'Output',      categories: ['stereo', 'output'] },
];

function stageFor(m: LouiModule): string {
  return STAGES.find((s) => s.categories.includes(m.category))?.key ?? 'output';
}

/** Chain-ordered modules, grouped into stages. */
function useChainStages() {
  return useMemo(() => {
    const ordered = CHAIN_MODULE_IDS
      .map((id) => getModule(id))
      .filter((m): m is LouiModule => !!m);
    return STAGES.map((stage) => ({
      ...stage,
      modules: ordered.filter((m) => stageFor(m) === stage.key),
    })).filter((s) => s.modules.length > 0);
  }, []);
}

// ── Row ──────────────────────────────────────────────────────────────────

interface RowProps {
  module: LouiModule;
  selected: boolean;
  engaged: boolean;
  bypassed: boolean;
  readout?: ModuleReadout;
  onSelect?: (id: string) => void;
  onToggleBypass?: (paramModuleId: ModuleId, bypass: boolean) => void;
}

function ModuleRow(props: RowProps) {
  const { module: m } = props;
  const [hover, setHover] = React.useState(false);
  const planned = m.status === 'planned';
  const canBypass = !!m.paramModuleId && !planned;

  // Colour is spent only where it carries meaning: the engaged rail, and a
  // readout that is actually moving.
  const railColor = props.bypassed
    ? 'transparent'
    : props.engaged
      ? meter.accent.foreground
      : 'transparent';

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '3px 1fr auto auto',
        alignItems: 'center',
        gap: space['3'],
        paddingInline: space['3'],
        paddingBlock: space['2'],
        borderRadius: radius.chip,
        background: props.selected ? surface.overlay : hover ? surface.well : 'transparent',
        transition: 'background 120ms ease-out',
        opacity: planned ? 0.45 : 1,
      }}
    >
      <div style={{
        alignSelf: 'stretch',
        borderRadius: radius.bar,
        background: railColor,
        transition: 'background 160ms ease-out',
      }} />

      <button
        type="button"
        disabled={planned}
        aria-pressed={props.selected}
        onClick={() => props.onSelect?.(m.id)}
        style={{
          appearance: 'none',
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: planned ? 'default' : 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          minWidth: 0,
        }}
      >
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.medium,
          color: props.bypassed ? text.muted : text.primary,
          textDecoration: props.bypassed ? 'line-through' : 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {m.displayName}
        </span>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {m.algorithmName ?? MODULE_CATEGORY_LABEL[m.category]}
        </span>
      </button>

      {/* Readout — a module that is not moving the signal shows nothing
          rather than a row of zeros. */}
      <span style={{
        fontFamily: typography.family.mono,
        fontSize: typography.size.xs,
        color: props.readout?.active ? meter.accent.foreground : text.muted,
        minWidth: 64,
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {planned ? MODULE_STATUS_LABEL[m.status] : (props.readout?.value ?? '')}
      </span>

      {canBypass ? (
        <button
          type="button"
          role="switch"
          aria-checked={!props.bypassed}
          aria-label={`${m.displayName} ${props.bypassed ? 'off' : 'on'}`}
          onClick={() => props.onToggleBypass?.(m.paramModuleId!, !props.bypassed)}
          style={{
            appearance: 'none',
            cursor: 'pointer',
            width: 30,
            height: 16,
            borderRadius: 999,
            border: `1px solid ${props.bypassed ? surface.border : 'rgba(167,139,250,0.5)'}`,
            background: props.bypassed ? surface.well : 'rgba(167,139,250,0.22)',
            position: 'relative',
            transition: 'background 120ms ease-out, border-color 120ms ease-out',
          }}
        >
          <span style={{
            position: 'absolute',
            top: 2,
            left: props.bypassed ? 2 : 15,
            width: 10,
            height: 10,
            borderRadius: 999,
            background: props.bypassed ? text.muted : meter.accent.foreground,
            transition: 'left 140ms ease-out, background 120ms ease-out',
          }} />
        </button>
      ) : (
        <span style={{ width: 30 }} />
      )}
    </div>
  );
}

// ── Rack ─────────────────────────────────────────────────────────────────

export function LouiModuleRack(props: LouiModuleRackProps) {
  const stages = useChainStages();
  const engaged = useMemo(() => new Set(props.engagedIds ?? []), [props.engagedIds]);

  const engagedCount = useMemo(
    () => LOUI_MODULES.filter((m) => engaged.has(m.id)).length,
    [engaged],
  );

  const latencyMs =
    props.latencySamples && props.sampleRate
      ? (props.latencySamples / props.sampleRate) * 1000
      : 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      overflow: 'hidden',
      minHeight: 0,
    }}>
      <header style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingInline: space['4'],
        paddingBlock: space['3'],
        borderBottom: `1px solid ${surface.border}`,
        background: surface.well,
      }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          color: text.muted,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}>
          Signal chain
        </span>
        <span style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: engagedCount > 0 ? meter.accent.foreground : text.muted,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {engagedCount} active
        </span>
      </header>

      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: space['2'],
        display: 'flex',
        flexDirection: 'column',
        gap: space['3'],
      }}>
        {stages.map((stage) => (
          <section key={stage.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{
              paddingInline: space['3'],
              paddingBlock: space['1'],
              fontFamily: typography.family.sans,
              fontSize: typography.size.xs,
              color: text.disabled,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}>
              {stage.label}
            </span>
            {stage.modules.map((m) => (
              <ModuleRow
                key={m.id}
                module={m}
                selected={props.selectedId === m.id}
                engaged={engaged.has(m.id)}
                bypassed={!!(m.paramModuleId && props.bypassById?.[m.paramModuleId])}
                {...(props.readouts?.[m.id] ? { readout: props.readouts[m.id]! } : {})}
                {...(props.onSelect ? { onSelect: props.onSelect } : {})}
                {...(props.onToggleBypass ? { onToggleBypass: props.onToggleBypass } : {})}
              />
            ))}
          </section>
        ))}
      </div>

      {/* Latency is a fact the user needs when monitoring live, and the
          spectral modules add a lot of it — so it is stated, not hidden. */}
      {latencyMs > 0 && (
        <footer style={{
          paddingInline: space['4'],
          paddingBlock: space['2'],
          borderTop: `1px solid ${surface.border}`,
          background: surface.well,
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: text.muted,
          fontVariantNumeric: 'tabular-nums',
        }}>
          Latency {latencyMs.toFixed(1)} ms · {props.latencySamples} samples
        </footer>
      )}
    </div>
  );
}
