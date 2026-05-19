// ImagerParameterPanel — stereo width / mono / per-band imager UI shell.
//
// Sections:
//   1. Correlation warning bar (live)
//   2. Width · Low Mono · Stereoize
//   3. Width-by-band shells (4 bands, UI-only)
//
// TODO(M3-P-NEXT-5 binding):
//   • widthPct     → engine.imager.width
//   • lowMonoHz    → engine.imager.lowMonoFrequency
//   • stereoize    → engine.imager.stereoize
//   • per-band     → engine.imager.bands[i].width

import React from 'react';
import {
  LouiSectionCard,
  LouiSliderRow,
  LouiTogglePill,
  LouiMiniMeter,
  LouiValueBadge,
} from '../controls/index.js';
import { surface, text, typography, space } from '../../../theme/loui-theme.js';

interface ImgState {
  widthPct:   number;
  lowMonoHz:  number;
  stereoize:  boolean;
  bandWidth:  [number, number, number, number];
}

const DEFAULTS: ImgState = {
  widthPct:   100,
  lowMonoHz:  120,
  stereoize:  false,
  bandWidth:  [40, 100, 110, 90],
};

const BAND_LABELS = ['Low', 'Mid-Low', 'Mid-High', 'High'];

export function ImagerParameterPanel() {
  const [s, setS] = React.useState<ImgState>(DEFAULTS);
  // Driven mock — correlation drifts within ± 0.1 of a base value derived
  // from the width slider.  UI-only.
  const [correlation, setCorrelation] = React.useState(0.78);
  React.useEffect(() => {
    const id = setInterval(() => {
      setCorrelation((prev) => {
        const base = 1 - (s.widthPct / 100) * 0.6;
        const drift = (Math.random() - 0.5) * 0.08;
        return Math.max(-1, Math.min(1, prev * 0.55 + base * 0.45 + drift));
      });
    }, 120);
    return () => clearInterval(id);
  }, [s.widthPct]);

  const update = <K extends keyof ImgState>(k: K) => (v: ImgState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  };

  const correlationStatus: 'ok' | 'warn' | 'danger' =
    correlation < -0.1 ? 'danger' : correlation < 0.2 ? 'warn' : 'ok';

  return (
    <>
      <LouiSectionCard
        title="Correlation"
        trailing={
          <LouiValueBadge label="Live" status={correlationStatus}>
            {correlation.toFixed(2)}
          </LouiValueBadge>
        }
      >
        <LouiMiniMeter
          value={correlation}
          mode="mirror"
          status={correlationStatus}
          readout={correlation < 0.2 ? 'Phase risk — fold-down may cancel' : 'Stable'}
          height={10}
        />
      </LouiSectionCard>

      <LouiSectionCard title="Stereo">
        <LouiSliderRow
          label="Width"
          hint="0 = mono · 200 = extreme wide"
          value={s.widthPct}
          min={0}
          max={200}
          step={1}
          unit="%"
          format={(v) => v.toFixed(0)}
          onChange={update('widthPct')}
        />
        <LouiSliderRow
          label="Low Mono"
          hint="Sum L+R below this frequency"
          value={s.lowMonoHz}
          min={20}
          max={400}
          step={5}
          unit="Hz"
          format={(v) => v.toFixed(0)}
          onChange={update('lowMonoHz')}
        />
        <LouiTogglePill
          label="Stereoize"
          hint="Spread mono sources synthetically"
          value={s.stereoize}
          onChange={update('stereoize')}
        />
      </LouiSectionCard>

      <LouiSectionCard title="Width by Band">
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: space['2'],
          paddingBlock: space['2'],
        }}>
          {s.bandWidth.map((w, i) => (
            <BandBar key={i}
                     label={BAND_LABELS[i]!}
                     value={w}
                     onChange={(v) => setS((p) => ({
                       ...p,
                       bandWidth: p.bandWidth.map((x, j) => j === i ? v : x) as ImgState['bandWidth'],
                     }))} />
          ))}
        </div>
      </LouiSectionCard>
    </>
  );
}

function BandBar({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const fillPct = Math.max(0, Math.min(200, value)) / 2; // 0..200 → 0..100 px
  return (
    <label style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6,
      cursor: 'pointer',
    }}>
      <div style={{
        width: '100%',
        height: 100,
        background: surface.well,
        borderRadius: 4,
        border: `1px solid ${surface.border}`,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Centre line — 100% mark */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0,
          top: 50,
          height: 1,
          background: surface.border,
        }} />
        <div style={{
          position: 'absolute',
          left: 0, right: 0,
          bottom: 0,
          height: `${fillPct}%`,
          background: 'rgba(167,139,250,0.45)',
          borderTop: '1px solid rgba(167,139,250,0.85)',
          transition: 'height 100ms linear',
        }} />
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        aria-label={`${label} width`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: '100%',
          margin: 0,
          accentColor: '#a78bfa',
          cursor: 'pointer',
        }}
      />
      <span style={{
        fontFamily: typography.family.mono,
        fontSize: 10,
        color: text.muted,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value} %
      </span>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: 10,
        color: text.tertiary,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}>
        {label}
      </span>
    </label>
  );
}
