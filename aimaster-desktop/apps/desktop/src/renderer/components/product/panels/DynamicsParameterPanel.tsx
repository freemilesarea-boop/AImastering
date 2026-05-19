// DynamicsParameterPanel — Glue compressor UI shell.
//
// Sections:
//   1. Live gain-reduction mini-meter (top, headline)
//   2. Threshold · Ratio · Attack · Release knobs
//   3. Mix slider (parallel comp)
//
// TODO(M3-P-NEXT-5 binding):
//   • thresholdDb  → engine.glueComp.threshold
//   • ratio        → engine.glueComp.ratio
//   • attackMs     → engine.glueComp.attack
//   • releaseMs    → engine.glueComp.release
//   • mixPct       → engine.glueComp.mix
//   • gainReduction (read) → engine.glueComp.grDb

import React from 'react';
import {
  LouiSectionCard,
  LouiSliderRow,
  LouiKnob,
  LouiMiniMeter,
} from '../controls/index.js';
import { space } from '../../../theme/loui-theme.js';

interface DynState {
  thresholdDb: number;
  ratio:       number;
  attackMs:    number;
  releaseMs:   number;
  mixPct:      number;
}

const DEFAULTS: DynState = {
  thresholdDb: -14,
  ratio:        2.0,
  attackMs:    10,
  releaseMs:   120,
  mixPct:      100,
};

export function DynamicsParameterPanel() {
  const [s, setS] = React.useState<DynState>(DEFAULTS);
  // UI-shell-only — drives the mini meter so the demo feels alive without
  // a real gain-reduction stream.  Fake-value oscillates between 0 and a
  // value derived from threshold + ratio.
  const [grNorm, setGrNorm] = React.useState(0.3);
  React.useEffect(() => {
    const id = setInterval(() => {
      // Pseudo-random walk bounded to a sensible range so the value moves
      // organically without crossing UI bounds.
      setGrNorm((prev) => {
        const target = Math.min(1, Math.max(0, (Math.abs(s.thresholdDb) / 24) * (s.ratio / 4)));
        const drift = (Math.random() - 0.5) * 0.12;
        return Math.max(0, Math.min(1, prev * 0.6 + target * 0.4 + drift));
      });
    }, 100);
    return () => clearInterval(id);
  }, [s.thresholdDb, s.ratio]);

  const update = <K extends keyof DynState>(k: K) => (v: DynState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  };

  // Map normalised meter value 0..1 → dB readout (0 dB to -12 dB).
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
