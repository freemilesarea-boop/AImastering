// LimiterParameterPanel — true-peak limiter UI shell.

import React from 'react';
import {
  LouiSectionCard,
  LouiSliderRow,
  LouiMiniMeter,
  LouiValueBadge,
  LouiTogglePill,
} from '../controls/index.js';
import { surface, text, typography, meter, space } from '../../../theme/loui-theme.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../../audio/parameters/index.js';
import { usePanelStateBridge, type ControlledPanelProps } from './usePanelStateBridge.js';
import { useRealtimeGr } from '../../../audio/modules/realtime-gr-context.js';

type LimiterCharacter = 'transparent' | 'glue' | 'aggressive' | 'classic';

interface LimState {
  targetLufs:    number;
  ceilingDbtp:   number;
  lookaheadMs:   number;
  character:     LimiterCharacter;
  isp:           boolean;
}

const findLim = (id: string) =>
  ALL_MODULE_PARAMETER_DEFS.limiter.parameters.find((p) => p.id === id)!.default;
const DEFAULTS: LimState = {
  targetLufs:   findLim('targetLufs')   as number,
  ceilingDbtp:  findLim('ceilingDbtp')  as number,
  lookaheadMs:  findLim('lookaheadMs')  as number,
  character:    findLim('character')    as LimiterCharacter,
  isp:          findLim('isp')          as boolean,
};

const CHARACTERS: { id: LimiterCharacter; label: string; desc: string }[] = [
  { id: 'transparent', label: 'Transparent', desc: 'Clean, hi-fi mastering' },
  { id: 'glue',        label: 'Glue',        desc: 'Default — warms transients' },
  { id: 'aggressive',  label: 'Aggressive',  desc: 'Loud, modern pop' },
  { id: 'classic',     label: 'Classic',     desc: 'Vintage, soft saturation' },
];

export function LimiterParameterPanel(props: ControlledPanelProps = {}) {
  const { state: s, setParam } = usePanelStateBridge<LimState>(DEFAULTS, props);
  const gr = useRealtimeGr();

  const update = <K extends keyof LimState>(k: K) => (v: LimState[K]) => setParam(k, v);

  const GR_METER_MAX_DB = 12;
  const grNorm = Math.min(1, gr.grDb / GR_METER_MAX_DB);
  const grDb = gr.grDb;
  const grReadout = gr.available ? `−${grDb.toFixed(1)} dB` : '—';
  const grStatus: 'ok' | 'warn' | 'danger' = grNorm > 0.8 ? 'danger' : grNorm > 0.5 ? 'warn' : 'ok';
  const ceilingStatus: 'ok' | 'warn' | 'danger' = s.ceilingDbtp >= -0.2 ? 'danger' : s.ceilingDbtp >= -0.6 ? 'warn' : 'ok';

  return (
    <>
      <LouiSectionCard
        title="Targets"
        trailing={
          <LouiValueBadge label="Ceiling" status={ceilingStatus}>
            {s.ceilingDbtp.toFixed(1)} dBTP
          </LouiValueBadge>
        }
      >
        <LouiSliderRow
          label="Target LUFS"
          hint="Integrated loudness target"
          value={s.targetLufs}
          min={-24}
          max={-6}
          step={0.5}
          unit="LUFS"
          format={(v) => v.toFixed(1)}
          onChange={update('targetLufs')}
        />
        <LouiSliderRow
          label="True-Peak Ceiling"
          hint="Maximum allowed inter-sample peak"
          value={s.ceilingDbtp}
          min={-3}
          max={0}
          step={0.1}
          unit="dBTP"
          format={(v) => v.toFixed(1)}
          onChange={update('ceilingDbtp')}
        />
        <LouiTogglePill
          label="True-Peak"
          hint="4× oversampled ISP detection"
          value={s.isp}
          onChange={update('isp')}
        />
      </LouiSectionCard>

      <LouiSectionCard title="Behaviour">
        <LouiSliderRow
          label="Lookahead"
          hint="Anticipation buffer for transient capture"
          value={s.lookaheadMs}
          min={0}
          max={20}
          step={0.1}
          unit="ms"
          format={(v) => v.toFixed(1)}
          onChange={update('lookaheadMs')}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.sm,
            color: text.secondary,
            fontWeight: typography.weight.medium,
          }}>
            Character
          </span>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: space['2'],
          }}>
            {CHARACTERS.map((c) => {
              const active = s.character === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => update('character')(c.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 2,
                    padding: space['3'],
                    background: active ? 'rgba(167,139,250,0.10)' : surface.well,
                    border: `1px solid ${active ? meter.accent.foreground : surface.border}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 120ms ease-out, border-color 120ms ease-out',
                  }}
                >
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.sm,
                    fontWeight: typography.weight.semi,
                    color: active ? text.primary : text.secondary,
                  }}>
                    {c.label}
                  </span>
                  <span style={{
                    fontFamily: typography.family.sans,
                    fontSize: typography.size.xs,
                    color: text.muted,
                  }}>
                    {c.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </LouiSectionCard>

      <LouiSectionCard title="Gain Reduction">
        <LouiMiniMeter
          value={grNorm}
          status={grStatus}
          readout={grReadout}
          height={12}
        />
      </LouiSectionCard>
    </>
  );
}
