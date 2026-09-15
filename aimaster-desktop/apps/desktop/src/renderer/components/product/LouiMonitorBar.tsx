// LouiMonitorBar — the A/B, delta and level-match controls.
//
// Twenty modules are worth nothing if you cannot tell whether they helped.
// Two things get in the way of judging that, and this bar removes both.
//
// **Louder wins.** A mastering chain almost always raises level, and at
// matched programme material listeners prefer the louder version nearly
// every time — regardless of quality. An A/B that does not level-match is
// therefore not comparing processing, it is comparing makeup gain. So the
// match is offered up-front, and the gain it applied is shown as a number:
// an A/B that silently moved the level by 4 dB is exactly as misleading as
// one that did not match at all.
//
// **"Better" is hard, "different" is easy.** Delta plays the difference
// alone — wet minus dry, level-matched first — so a stage that only changed
// gain reads as near-silence, and a stage that changed tone is audible on
// its own terms.
//
// The readout is the honest half of this component. It shows what the chain
// actually added, what the match compensated, and both loudness figures, so
// the user can see the comparison is fair rather than take it on trust.

import React from 'react';
import type {
  MatchTarget,
  MonitorMode,
  MonitorSettings,
} from '../../audio/chain-config.js';
import { surface, text, typography, space, radius, meter } from '../../theme/loui-theme.js';

/** Live measurements from the engine.  Absent when nothing is running. */
export interface MonitorReadout {
  /** Loudness the chain added, in dB (processed − dry). */
  loudnessDeltaDb?: number;
  /** Gain the level match applied, in dB. */
  matchGainDb?: number;
  dryLufs?: number;
  wetLufs?: number;
}

export interface LouiMonitorBarProps {
  value: MonitorSettings;
  onChange: (next: MonitorSettings) => void;
  readout?: MonitorReadout;
  /**
   * Where the monitor setting takes effect right now.  The realtime preview
   * is currently disabled, so it applies to the rendered output — saying so
   * is better than letting the user press A/B and hear nothing.
   */
  appliesTo?: 'render' | 'live';
}

const MODES: { id: MonitorMode; label: string; hint: string }[] = [
  { id: 'processed', label: 'Processed', hint: '체인을 통과한 결과' },
  { id: 'bypass',    label: 'Bypass',    hint: '원본 — 지연·레벨을 맞춰서' },
  { id: 'delta',     label: 'Delta',     hint: '체인이 바꾼 것만' },
];

const TARGETS: { id: MatchTarget; label: string; hint: string }[] = [
  { id: 'dry', label: '→ 원본', hint: '처리본을 원본 레벨로 낮춤' },
  { id: 'wet', label: '→ 처리본', hint: '원본을 처리본 레벨로 올림' },
];

function Segmented<T extends string>(props: {
  options: readonly { id: T; label: string; hint?: string }[];
  value: T;
  ariaLabel: string;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.ariaLabel}
      style={{
        display: 'inline-flex',
        padding: 2,
        gap: 2,
        background: surface.well,
        border: `1px solid ${surface.border}`,
        borderRadius: radius.chip,
      }}
    >
      {props.options.map((o) => {
        const on = o.id === props.value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.hint}
            onClick={() => props.onChange(o.id)}
            style={{
              appearance: 'none',
              cursor: 'pointer',
              paddingInline: space['3'],
              paddingBlock: space['1'],
              borderRadius: 4,
              border: 'none',
              background: on ? 'rgba(167,139,250,0.20)' : 'transparent',
              color: on ? meter.accent.foreground : text.tertiary,
              fontFamily: typography.family.sans,
              fontSize: typography.size.xs,
              fontWeight: typography.weight.medium,
              whiteSpace: 'nowrap',
              transition: 'background 120ms ease-out, color 120ms ease-out',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled number, or an em dash when there is nothing to show. */
function Stat(props: { label: string; value: number | undefined; unit: string; signed?: boolean }) {
  const has = typeof props.value === 'number' && Number.isFinite(props.value);
  const shown = !has
    ? '—'
    : props.signed && props.value! >= 0
      ? `+${props.value!.toFixed(1)}`
      : props.value!.toFixed(1);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: space['1'] }}>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        whiteSpace: 'nowrap',
      }}>
        {props.label}
      </span>
      <span style={{
        fontFamily: typography.family.mono,
        fontSize: typography.size.xs,
        color: has ? text.secondary : text.disabled,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {shown}{has ? ` ${props.unit}` : ''}
      </span>
    </div>
  );
}

export function LouiMonitorBar(props: LouiMonitorBarProps) {
  const v = props.value;
  const set = (patch: Partial<MonitorSettings>) => props.onChange({ ...v, ...patch });
  const comparing = v.mode !== 'processed' || v.loudnessMatch;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: space['3'],
      paddingInline: space['4'],
      paddingBlock: space['2'],
      background: surface.panel,
      border: `1px solid ${comparing ? 'rgba(167,139,250,0.35)' : surface.border}`,
      borderRadius: radius.panel,
      transition: 'border-color 160ms ease-out',
    }}>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        Monitor
      </span>

      <Segmented options={MODES} value={v.mode} ariaLabel="모니터 모드" onChange={(m) => set({ mode: m })} />

      {/* Level match — the control that makes the comparison honest. */}
      <button
        type="button"
        role="switch"
        aria-checked={v.loudnessMatch}
        onClick={() => set({ loudnessMatch: !v.loudnessMatch })}
        title="레벨을 맞추지 않은 A/B는 처리가 아니라 메이크업 게인을 비교하게 됩니다"
        style={{
          appearance: 'none',
          cursor: 'pointer',
          paddingInline: space['3'],
          paddingBlock: space['1'],
          borderRadius: radius.chip,
          border: `1px solid ${v.loudnessMatch ? 'rgba(167,139,250,0.5)' : surface.border}`,
          background: v.loudnessMatch ? 'rgba(167,139,250,0.16)' : surface.well,
          color: v.loudnessMatch ? meter.accent.foreground : text.tertiary,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          whiteSpace: 'nowrap',
        }}
      >
        레벨 매칭
      </button>

      {v.loudnessMatch && (
        <Segmented
          options={TARGETS}
          value={v.matchTarget}
          ariaLabel="매칭 기준"
          onChange={(t) => set({ matchTarget: t })}
        />
      )}

      {/* Delta make-up — only meaningful while listening to the difference. */}
      {v.mode === 'delta' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            whiteSpace: 'nowrap',
          }}>
            Delta 게인
          </span>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={v.deltaGainDb}
            aria-label="Delta 게인"
            onChange={(e) => set({ deltaGainDb: Number(e.target.value) })}
            style={{ width: 96, accentColor: meter.accent.foreground }}
          />
          <span style={{
            fontFamily: typography.family.mono,
            fontSize: typography.size.xs,
            color: text.secondary,
            fontVariantNumeric: 'tabular-nums',
            minWidth: 40,
          }}>
            +{v.deltaGainDb.toFixed(0)} dB
          </span>
        </label>
      )}

      <div style={{ flex: 1 }} />

      {/* The honest half: what the chain did, and what the match compensated. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space['4'], flexWrap: 'wrap' }}>
        <Stat label="체인 추가" value={props.readout?.loudnessDeltaDb} unit="dB" signed />
        <Stat label="매칭" value={v.loudnessMatch ? props.readout?.matchGainDb : undefined} unit="dB" signed />
        <Stat label="원본" value={props.readout?.dryLufs} unit="LUFS" />
        <Stat label="처리본" value={props.readout?.wetLufs} unit="LUFS" />
      </div>

      {comparing && (
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: meter.warn.foreground,
          whiteSpace: 'nowrap',
        }}>
          {props.appliesTo === 'live'
            ? '비교 중 — 출력은 마스터가 아닙니다'
            : '비교 모드 — 렌더 결과에 적용됩니다 (마스터 아님)'}
        </span>
      )}
    </div>
  );
}
