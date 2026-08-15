// ModuleParameterPanel — one panel renderer for every module in the suite.
//
// The suite has twenty modules and ~150 parameters.  Hand-writing a panel
// per module would mean twenty places for the layout to drift, twenty
// places to forget a hint, and twenty files to touch when a control gets
// better.  Instead this renders directly from `module-parameter-definitions`
// — so every module gets the same spacing, the same control choices and the
// same keyboard behaviour, and adding a module is a definitions change.
//
// The one thing a generic renderer has to get right is GROUPING.  A flat
// list of 39 controls is not a panel, it is a spreadsheet.  Two rules do
// most of the work:
//
//   • Parameters named `bandN…` are collected into a "Band N" section, in
//     band order.  That turns the multiband and dynamic-EQ modules into
//     one section per band instead of one wall of sliders.
//   • Everything else lands in a leading section, optionally split by an
//     explicit `sections` prop when a module wants a specific story
//     (e.g. Vintage EQ's low and high halves).
//
// Control choice follows the parameter kind: booleans become toggle pills,
// enums become chip rows, numbers become slider rows.  Knobs are reserved
// for the hand-built panels where a knob genuinely reads better.

import React, { useMemo } from 'react';
import type {
  ModuleId,
  ModuleParameterDefinitions,
  ParameterDef,
  ParameterValue,
} from '../../../audio/parameters/index.js';
import { LouiSectionCard } from '../controls/LouiSectionCard.js';
import { LouiSliderRow } from '../controls/LouiSliderRow.js';
import { LouiTogglePill } from '../controls/LouiTogglePill.js';
import { surface, text, typography, space, radius } from '../../../theme/loui-theme.js';

// ── Chip row (enum control) ──────────────────────────────────────────────

interface ChipRowProps {
  label: string;
  hint?: string;
  values: readonly string[];
  labels?: Readonly<Record<string, string>>;
  hints?: Readonly<Record<string, string>>;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}

function ChipRow(props: ChipRowProps) {
  const activeHint = props.hints?.[props.value];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'], opacity: props.disabled ? 0.45 : 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          color: text.secondary,
          fontWeight: typography.weight.medium,
        }}>
          {props.label}
        </span>
        {props.hint && (
          <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>
            {props.hint}
          </span>
        )}
      </div>
      <div role="radiogroup" aria-label={props.label} style={{ display: 'flex', flexWrap: 'wrap', gap: space['1'] }}>
        {props.values.map((v) => {
          const on = v === props.value;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={props.disabled}
              onClick={() => props.onChange(v)}
              style={{
                appearance: 'none',
                cursor: props.disabled ? 'default' : 'pointer',
                paddingInline: space['3'],
                paddingBlock: space['1'],
                borderRadius: radius.chip,
                border: `1px solid ${on ? 'rgba(167,139,250,0.55)' : surface.border}`,
                background: on ? 'rgba(167,139,250,0.16)' : surface.well,
                color: on ? text.primary : text.tertiary,
                fontFamily: typography.family.sans,
                fontSize: typography.size.xs,
                fontWeight: typography.weight.medium,
                transition: 'background 120ms ease-out, border-color 120ms ease-out',
              }}
            >
              {props.labels?.[v] ?? v}
            </button>
          );
        })}
      </div>
      {/* Per-value hint — the character selectors carry a line each, and
          showing only the active one keeps the panel from ballooning. */}
      {activeHint && (
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          lineHeight: 1.4,
        }}>
          {activeHint}
        </span>
      )}
    </div>
  );
}

// ── Grouping ─────────────────────────────────────────────────────────────

interface Section {
  title: string;
  params: ParameterDef[];
}

const BAND_PREFIX = /^band(\d+)([A-Z].*)?$/;

/** Split a module's parameters into sections — see the file header. */
export function groupParameters(
  def: ModuleParameterDefinitions,
  bandLabels?: readonly string[],
): Section[] {
  const general: ParameterDef[] = [];
  const bands = new Map<number, ParameterDef[]>();

  for (const p of def.parameters) {
    const m = BAND_PREFIX.exec(p.id);
    // A `bandN` id with no suffix (Impact's `band0Pct` has one; a bare
    // `band0` would not) still belongs to that band's section.
    if (m) {
      const idx = Number(m[1]);
      const list = bands.get(idx) ?? [];
      list.push(p);
      bands.set(idx, list);
    } else {
      general.push(p);
    }
  }

  const sections: Section[] = [];
  if (general.length > 0) {
    sections.push({ title: bands.size > 0 ? 'Module' : 'Parameters', params: general });
  }
  for (const idx of [...bands.keys()].sort((a, b) => a - b)) {
    sections.push({
      title: bandLabels?.[idx] ?? `Band ${idx + 1}`,
      params: bands.get(idx)!,
    });
  }
  return sections;
}

/**
 * Modules whose bands are frequency ranges rather than numbered slots.
 * Naming them "Low / Low mid / High mid / High" is the difference between
 * a panel you can read at a glance and one you have to decode.
 */
const FREQ_BAND_LABELS = ['Low', 'Low mid', 'High mid', 'High'] as const;
const FREQ_BAND_MODULES = new Set<ModuleId>(['multiband', 'impact', 'exciter']);

// ── Panel ────────────────────────────────────────────────────────────────

export interface ModuleParameterPanelProps {
  moduleId: ModuleId;
  def: ModuleParameterDefinitions;
  /** Current value for every parameter. */
  values: Record<string, ParameterValue>;
  /** Module bypass — dims the whole panel and disables its controls. */
  bypass?: boolean;
  onChange: (parameterId: string, value: ParameterValue) => void;
  /**
   * Optional note rendered above the sections — used for things the
   * parameters cannot say themselves, e.g. "adds 43 ms of latency".
   */
  note?: React.ReactNode;
}

export function ModuleParameterPanel(props: ModuleParameterPanelProps) {
  const sections = useMemo(
    () => groupParameters(
      props.def,
      FREQ_BAND_MODULES.has(props.moduleId) ? FREQ_BAND_LABELS : undefined,
    ),
    [props.def, props.moduleId],
  );

  const disabled = props.bypass === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['3'] }}>
      {props.note && (
        <div style={{
          background: surface.well,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.chip,
          padding: space['3'],
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.tertiary,
          lineHeight: 1.5,
        }}>
          {props.note}
        </div>
      )}

      {sections.map((section) => (
        <LouiSectionCard key={section.title} title={section.title} dimmed={disabled}>
          {section.params.map((p) => {
            const raw = props.values[p.id];

            if (p.kind === 'boolean') {
              return (
                <LouiTogglePill
                  key={p.id}
                  label={p.label}
                  {...(p.hint ? { hint: p.hint } : {})}
                  {...(p.offLabel ? { offLabel: p.offLabel } : {})}
                  {...(p.onLabel ? { onLabel: p.onLabel } : {})}
                  value={typeof raw === 'boolean' ? raw : p.default}
                  disabled={disabled}
                  onChange={(v) => props.onChange(p.id, v)}
                />
              );
            }

            if (p.kind === 'enum') {
              return (
                <ChipRow
                  key={p.id}
                  label={p.label}
                  {...(p.hint ? { hint: p.hint } : {})}
                  {...(p.labels ? { labels: p.labels } : {})}
                  {...(p.hints ? { hints: p.hints } : {})}
                  values={p.values}
                  value={typeof raw === 'string' ? raw : p.default}
                  disabled={disabled}
                  onChange={(v) => props.onChange(p.id, v)}
                />
              );
            }

            return (
              <LouiSliderRow
                key={p.id}
                label={p.label}
                {...(p.hint ? { hint: p.hint } : {})}
                {...(p.unit ? { unit: p.unit } : {})}
                {...(p.format ? { format: p.format } : {})}
                value={typeof raw === 'number' ? raw : p.default}
                min={p.min}
                max={p.max}
                step={p.step}
                disabled={disabled}
                onChange={(v) => props.onChange(p.id, v)}
              />
            );
          })}
        </LouiSectionCard>
      ))}
    </div>
  );
}
