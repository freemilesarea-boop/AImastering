// LouiFreeEqBandList — the free EQ's bands as numbers you can type.
//
// The graph is the fast way to work and a bad way to be exact. Dragging
// cannot express "cut 200 Hz by 3 dB at Q 1.4"; it can only get close, and
// a wheel run to its stop lands on Q 0.1, where a bell is so wide it reads
// as a tilt rather than a cut — which looks exactly like a cut that failed
// to apply.
//
// So every band also appears as a row: filter shape, frequency, gain, Q, a
// switch and a delete. Same state as the graph, both directions live.
//
// Cut and boost are not modes here, they are the sign of the gain. The row
// says so with a −/+ button rather than leaving the user to discover that
// typing a minus works.

import React, { useCallback } from 'react';
import {
  type FreeEqBand,
  FREE_KIND_CYCLE,
} from '../../../audio/modules/eq-graph-model.js';
import { surface, text, typography, space, radius, meter } from '../../../theme/loui-theme.js';

export interface LouiFreeEqBandListProps {
  bands: readonly FreeEqBand[];
  onChange: (bandId: string, patch: Partial<FreeEqBand>) => void;
  onRemove: (bandId: string) => void;
  onAdd: () => void;
  atCapacity: boolean;
  disabled?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  bell: 'Bell',
  lowshelf: 'Low shelf',
  highshelf: 'High shelf',
  highpass: 'High-pass',
  lowpass: 'Low-pass',
};

const KIND_COLOR: Record<string, string> = {
  bell: '#A78BFA',
  lowshelf: '#FBBF24',
  highshelf: '#22D3EE',
  highpass: '#60A5FA',
  lowpass: '#F87171',
};

function isPass(kind: string): boolean {
  return kind === 'highpass' || kind === 'lowpass';
}

/** A compact numeric field.  Commits on blur and on Enter, not per keystroke,
 *  so a half-typed "−" or "1" never reaches the audio thread as a value. */
function NumField(props: {
  value: number;
  suffix?: string;
  min: number;
  max: number;
  step: number;
  disabled?: boolean | undefined;
  width?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? (Math.abs(props.value) >= 100
    ? props.value.toFixed(0)
    : props.value.toFixed(props.step < 0.1 ? 2 : 1));

  const commit = useCallback(() => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (!Number.isFinite(n)) return;
    props.onCommit(Math.max(props.min, Math.min(props.max, n)));
  }, [draft, props]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
      <input
        type="text"
        inputMode="decimal"
        value={shown}
        disabled={props.disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') setDraft(null);
        }}
        style={{
          width: props.width ?? 52,
          appearance: 'textfield',
          background: surface.well,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.chip,
          color: text.secondary,
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          textAlign: 'right',
          padding: '2px 4px',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      {props.suffix && (
        <span style={{ fontFamily: typography.family.mono, fontSize: 9, color: text.muted }}>
          {props.suffix}
        </span>
      )}
    </span>
  );
}

function BandRow(props: {
  band: FreeEqBand;
  index: number;
  disabled?: boolean;
  onChange: (patch: Partial<FreeEqBand>) => void;
  onRemove: () => void;
}) {
  const { band, disabled } = props;
  const pass = isPass(band.kind);
  const cutting = band.gainDb < 0;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: space['2'],
      paddingInline: space['2'],
      paddingBlock: space['1'],
      borderRadius: radius.chip,
      background: band.enabled ? surface.panel : 'transparent',
      border: `1px solid ${band.enabled ? surface.border : 'transparent'}`,
      opacity: band.enabled ? 1 : 0.5,
      flexWrap: 'wrap',
    }}>
      <span style={{
        width: 14, textAlign: 'right',
        fontFamily: typography.family.mono, fontSize: 9,
        color: KIND_COLOR[band.kind] ?? text.muted,
      }}>
        {props.index + 1}
      </span>

      <select
        value={band.kind}
        disabled={disabled}
        onChange={(e) => props.onChange({ kind: e.target.value as FreeEqBand['kind'] })}
        aria-label="필터 종류"
        style={{
          appearance: 'none',
          background: surface.well,
          border: `1px solid ${surface.border}`,
          borderRadius: radius.chip,
          color: KIND_COLOR[band.kind] ?? text.secondary,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          padding: '2px 6px',
          minWidth: 88,
        }}
      >
        {FREE_KIND_CYCLE.map((k) => (
          <option key={k} value={k}>{KIND_LABEL[k]}</option>
        ))}
      </select>

      <NumField
        value={band.frequencyHz} suffix="Hz" min={20} max={20_000} step={1}
        disabled={disabled} width={58}
        onCommit={(v) => props.onChange({ frequencyHz: v })}
      />

      {/* Cut / boost.  A pass filter has no gain in the engine, so the
          control is absent rather than present and ignored. */}
      {pass ? (
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.xs,
          color: text.disabled, minWidth: 96,
        }}>
          게인 없음
        </span>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => props.onChange({ gainDb: -band.gainDb })}
            title="컷 / 부스트 전환"
            style={{
              appearance: 'none',
              cursor: disabled ? 'default' : 'pointer',
              width: 22, height: 20,
              borderRadius: radius.chip,
              border: `1px solid ${cutting ? 'rgba(248,113,113,0.5)' : 'rgba(52,211,153,0.45)'}`,
              background: cutting ? 'rgba(248,113,113,0.14)' : 'rgba(52,211,153,0.12)',
              color: cutting ? '#F87171' : '#34D399',
              fontFamily: typography.family.mono,
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            {cutting ? '−' : '+'}
          </button>
          <NumField
            value={band.gainDb} suffix="dB" min={-30} max={30} step={0.1}
            disabled={disabled} width={52}
            onCommit={(v) => props.onChange({ gainDb: v })}
          />
        </span>
      )}

      <NumField
        value={band.q} suffix="Q" min={0.1} max={18} step={0.01}
        disabled={disabled} width={48}
        onCommit={(v) => props.onChange({ q: v })}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => props.onChange({ enabled: !band.enabled })}
        aria-pressed={band.enabled}
        style={{
          appearance: 'none',
          cursor: disabled ? 'default' : 'pointer',
          paddingInline: 6, paddingBlock: 2,
          borderRadius: radius.chip,
          border: `1px solid ${surface.border}`,
          background: band.enabled ? 'rgba(167,139,250,0.16)' : surface.well,
          color: band.enabled ? meter.accent.foreground : text.muted,
          fontFamily: typography.family.sans,
          fontSize: 10,
        }}
      >
        {band.enabled ? 'On' : 'Off'}
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={props.onRemove}
        aria-label="밴드 삭제"
        style={{
          appearance: 'none',
          cursor: disabled ? 'default' : 'pointer',
          width: 20, height: 20,
          borderRadius: radius.chip,
          border: `1px solid ${surface.border}`,
          background: 'transparent',
          color: text.muted,
          fontSize: 11, lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function LouiFreeEqBandList(props: LouiFreeEqBandListProps) {
  const { bands, disabled } = props;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['1'],
      opacity: disabled ? 0.45 : 1,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: space['2'], paddingInline: space['2'],
      }}>
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.xs,
          color: text.muted, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          밴드 {bands.length}
        </span>
        <button
          type="button"
          disabled={disabled || props.atCapacity}
          onClick={props.onAdd}
          style={{
            appearance: 'none',
            cursor: disabled || props.atCapacity ? 'default' : 'pointer',
            paddingInline: space['2'], paddingBlock: 2,
            borderRadius: radius.chip,
            border: `1px solid ${surface.border}`,
            background: surface.well,
            color: props.atCapacity ? text.disabled : text.tertiary,
            fontFamily: typography.family.sans, fontSize: typography.size.xs,
          }}
        >
          {props.atCapacity ? '한도 도달' : '+ 밴드 추가'}
        </button>
      </div>

      {bands.length === 0 ? (
        <span style={{
          paddingInline: space['2'], paddingBlock: space['2'],
          fontFamily: typography.family.sans, fontSize: typography.size.xs,
          color: text.muted, lineHeight: 1.6,
        }}>
          아직 밴드가 없습니다. 그래프의 빈 곳을 더블클릭하거나 「+ 밴드 추가」를 누르세요.
          위로 끌면 부스트, 아래로 끌면 컷입니다.
        </span>
      ) : (
        bands.map((b, i) => (
          <BandRow
            key={b.id}
            band={b}
            index={i}
            {...(disabled !== undefined ? { disabled } : {})}
            onChange={(patch) => props.onChange(b.id, patch)}
            onRemove={() => props.onRemove(b.id)}
          />
        ))
      )}
    </div>
  );
}
