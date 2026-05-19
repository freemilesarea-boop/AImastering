// EqParameterPanel — UI shell for the EQ module slide-over.
//
// Sections:
//   1. EQ curve preview (placeholder SVG)
//   2. Band controls: Low Cut · Low Shelf · Presence · Air · Output Gain
//   3. Adaptive toggle + reset
//
// IMPORTANT — UI STATE ONLY.  Every onChange handler updates local state
// in this component.  No DSP parameter is written.  The engine binding
// map lives in docs/redesign/loui-mastering-v2/m3-product-next-4/
// 05-FUTURE-DSP-BINDING.md.
//
// TODO(M3-P-NEXT-5 binding):
//   • lowCutHz       → engine.eq.lowCut.frequency
//   • lowShelfDb     → engine.eq.lowShelf.gain
//   • presenceDb     → engine.eq.presence.gain
//   • airDb          → engine.eq.air.gain
//   • outputGainDb   → engine.outputGain
//   • adaptive       → engine.eq.adaptive

import React from 'react';
import {
  LouiSliderRow,
  LouiSectionCard,
  LouiTogglePill,
  LouiValueBadge,
} from '../controls/index.js';
import { surface, text, typography, meter, space } from '../../../theme/loui-theme.js';

interface EqState {
  lowCutHz:      number;
  lowShelfDb:    number;
  presenceDb:    number;
  airDb:         number;
  outputGainDb:  number;
  adaptive:      boolean;
}

const DEFAULTS: EqState = {
  lowCutHz:     32,
  lowShelfDb:    1.2,
  presenceDb:    1.4,
  airDb:         2.0,
  outputGainDb:  0.0,
  adaptive:      true,
};

/** Curve preview — schematic, not the live EQ response. */
function EqCurvePreview({ state }: { state: EqState }) {
  // Construct a simple polyline that reflects the four band gains.
  // X axis: log-frequency, mapped to 0..200 px.
  // Y axis: gain dB, mapped to 8..40 px (centered around 24 px = 0 dB).
  const yFor = (db: number) => 24 - Math.max(-12, Math.min(12, db)) * 1.2;
  const xFor = (hz: number) => {
    const lo = Math.log10(20);
    const hi = Math.log10(20_000);
    return ((Math.log10(hz) - lo) / (hi - lo)) * 200;
  };
  const points = [
    [xFor(20), yFor(state.lowShelfDb - 14)],          // low cut effect
    [xFor(state.lowCutHz), yFor(state.lowShelfDb - 6)],
    [xFor(120), yFor(state.lowShelfDb)],
    [xFor(800), yFor(0)],
    [xFor(3000), yFor(state.presenceDb)],
    [xFor(8000), yFor((state.presenceDb + state.airDb) / 2)],
    [xFor(15000), yFor(state.airDb)],
    [xFor(20000), yFor(state.airDb - 1)],
  ];
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`)
    .join(' ');

  return (
    <div style={{
      width: '100%',
      height: 96,
      background: surface.well,
      border: `1px solid ${surface.border}`,
      borderRadius: 6,
      padding: space['2'],
      position: 'relative',
    }}>
      <svg viewBox="0 0 200 48" preserveAspectRatio="none"
           style={{ width: '100%', height: '100%' }}>
        {/* Zero-dB centre line */}
        <line x1={0} y1={24} x2={200} y2={24} stroke={surface.border} strokeWidth={0.5} strokeDasharray="2 2" />
        {/* Vertical band markers */}
        {[100, 1000, 10000].map((hz) => (
          <line key={hz} x1={xFor(hz)} y1={4} x2={xFor(hz)} y2={44}
                stroke={surface.border} strokeWidth={0.5} />
        ))}
        {/* Curve */}
        <path d={path}
              stroke={meter.accent.foreground}
              strokeWidth={1.5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round" />
      </svg>
      <span style={{
        position: 'absolute',
        bottom: 4,
        right: 6,
        fontFamily: typography.family.mono,
        fontSize: 9,
        color: text.muted,
        letterSpacing: '0.04em',
      }}>
        20 Hz — 20 kHz
      </span>
    </div>
  );
}

export function EqParameterPanel() {
  const [s, setS] = React.useState<EqState>(DEFAULTS);

  const update = <K extends keyof EqState>(k: K) => (v: EqState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  };

  return (
    <>
      <LouiSectionCard
        title="EQ Curve"
        trailing={
          <LouiValueBadge label="Mode" status="accent">
            {s.adaptive ? 'Adaptive' : 'Manual'}
          </LouiValueBadge>
        }
      >
        <EqCurvePreview state={s} />
      </LouiSectionCard>

      <LouiSectionCard title="Bands">
        <LouiSliderRow
          label="Low Cut"
          hint="High-pass at the low end"
          value={s.lowCutHz}
          min={20}
          max={120}
          step={1}
          unit="Hz"
          format={(v) => v.toFixed(0)}
          onChange={update('lowCutHz')}
        />
        <LouiSliderRow
          label="Low Shelf"
          hint="120 Hz / Q=0.7"
          value={s.lowShelfDb}
          min={-6}
          max={6}
          step={0.1}
          unit="dB"
          format={(v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))}
          onChange={update('lowShelfDb')}
        />
        <LouiSliderRow
          label="Presence"
          hint="3 kHz peak / Q=1.1"
          value={s.presenceDb}
          min={-6}
          max={6}
          step={0.1}
          unit="dB"
          format={(v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))}
          onChange={update('presenceDb')}
        />
        <LouiSliderRow
          label="Air"
          hint="12 kHz shelf"
          value={s.airDb}
          min={-6}
          max={6}
          step={0.1}
          unit="dB"
          format={(v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))}
          onChange={update('airDb')}
        />
      </LouiSectionCard>

      <LouiSectionCard title="Output">
        <LouiSliderRow
          label="Output Gain"
          value={s.outputGainDb}
          min={-12}
          max={12}
          step={0.1}
          unit="dB"
          format={(v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))}
          onChange={update('outputGainDb')}
        />
        <LouiTogglePill
          label="Adaptive"
          hint="Auto-tune EQ to spectral target"
          value={s.adaptive}
          onChange={update('adaptive')}
        />
      </LouiSectionCard>
    </>
  );
}
