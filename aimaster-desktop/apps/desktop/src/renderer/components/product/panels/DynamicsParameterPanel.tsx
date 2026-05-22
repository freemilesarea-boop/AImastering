// DynamicsParameterPanel — Glue compressor UI shell.

import React from 'react';
import {
  LouiSectionCard,
  LouiSliderRow,
  LouiKnob,
  LouiMiniMeter,
} from '../controls/index.js';
import { space } from '../../../theme/loui-theme.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../../audio/parameters/index.js';
import { usePanelStateBridge, type ControlledPanelProps } from './usePanelStateBridge.js';
import { useRealtimeDynamicsGr } from '../../../audio/modules/realtime-gr-context.js';

interface DynState {
  thresholdDb: number;
  ratio:       number;
  attackMs:    number;
  releaseMs:   number;
  mixPct:      number;
}

const DEFAULTS: DynState = {
  thresholdDb: ALL_MODULE_PARAMETER_DEFS.dynamics.parameters.find((p) => p.id === 'thresholdDb')!.default as number,
  ratio:       ALL_MODULE_PARAMETER_DEFS.dynamics.parameters.find((p) => p.id === 'ratio')!.default       as number,
  attackMs:    ALL_MODULE_PARAMETER_DEFS.dynamics.parameters.find((p) => p.id === 'attackMs')!.default    as number,
  releaseMs:   ALL_MODULE_PARAMETER_DEFS.dynamics.parameters.find((p) => p.id === 'releaseMs')!.default   as number,
  mixPct:      ALL_MODULE_PARAMETER_DEFS.dynamics.parameters.find((p) => p.id === 'mixPct')!.default      as number,
};

// GR meter spans 0..GR_METER_MAX_DB (full-scale).  12 dB matches the
// limiter meter's range so both read on the same visual scale.
const GR_METER_MAX_DB = 12;

export function DynamicsParameterPanel(props: ControlledPanelProps = {}) {
  const { state: s, setParam } = usePanelStateBridge<DynState>(DEFAULTS, props);
  // REAL compressor gain reduction from the realtime worklet metrics.
  // Outside an active realtime session this reads "unavailable" — never
  // a faked/animated value.
  const gr = useRealtimeDynamicsGr();

  const update = <K extends keyof DynState>(k: K) => (v: DynState[K]) => setParam(k, v);
  const grNorm = Math.min(1, gr.grDb / GR_METER_MAX_DB);
  const readout = gr.available ? `−${gr.grDb.toFixed(1)} dB` : '—';

  return (
    <>
      <LouiSectionCard title="Gain Reduction">
        <LouiMiniMeter
          value={grNorm}
          status="ok"
          readout={readout}
          height={12}
        />
      </LouiSectionCard>

      <LouiSectionCard title="Compressor">
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: space['3'],
          paddingBlock: space['2'],
        }}>
          <LouiKnob
            label="Threshold"
            value={s.thresholdDb}
            min={-30}
            max={0}
            step={0.5}
            unit="dB"
            onChange={update('thresholdDb')}
          />
          <LouiKnob
            label="Ratio"
            value={s.ratio}
            min={1}
            max={10}
            step={0.1}
            unit=":1"
            format={(v) => v.toFixed(1)}
            onChange={update('ratio')}
          />
          <LouiKnob
            label="Attack"
            value={s.attackMs}
            min={0.1}
            max={100}
            step={0.5}
            unit="ms"
            format={(v) => v.toFixed(1)}
            onChange={update('attackMs')}
          />
          <LouiKnob
            label="Release"
            value={s.releaseMs}
            min={10}
            max={1000}
            step={5}
            unit="ms"
            format={(v) => v.toFixed(0)}
            onChange={update('releaseMs')}
          />
        </div>
      </LouiSectionCard>

      <LouiSectionCard title="Parallel">
        <LouiSliderRow
          label="Mix"
          hint="0 = dry, 100 = fully compressed"
          value={s.mixPct}
          min={0}
          max={100}
          step={1}
          unit="%"
          format={(v) => v.toFixed(0)}
          onChange={update('mixPct')}
        />
      </LouiSectionCard>
    </>
  );
}
