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

export function DynamicsParameterPanel(props: ControlledPanelProps = {}) {
  const { state: s, setParam } = usePanelStateBridge<DynState>(DEFAULTS, props);
  const [grNorm, setGrNorm] = React.useState(0.3);

  React.useEffect(() => {
    const id = setInterval(() => {
      setGrNorm((prev) => {
        const target = Math.min(1, Math.max(0, (Math.abs(s.thresholdDb) / 24) * (s.ratio / 4)));
        const drift = (Math.random() - 0.5) * 0.12;
        return Math.max(0, Math.min(1, prev * 0.6 + target * 0.4 + drift));
      });
    }, 100);
    return () => clearInterval(id);
  }, [s.thresholdDb, s.ratio]);

  const update = <K extends keyof DynState>(k: K) => (v: DynState[K]) => setParam(k, v);
  const grDb = -grNorm * 12;

  return (
    <>
      <LouiSectionCard title="Gain Reduction">
        <LouiMiniMeter
          value={grNorm}
          status="ok"
          readout={`${grDb.toFixed(1)} dB`}
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
