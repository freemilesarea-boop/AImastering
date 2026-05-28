// ImagerParameterPanel — stereo width / mono / per-band imager UI shell.

import React from 'react';
import {
  LouiSectionCard,
  LouiSliderRow,
  LouiTogglePill,
  LouiMiniMeter,
  LouiValueBadge,
} from '../controls/index.js';
import { surface, text, typography, space } from '../../../theme/loui-theme.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../../audio/parameters/index.js';
import { usePanelStateBridge, type ControlledPanelProps } from './usePanelStateBridge.js';
import { useMediaElement } from '../../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../../hooks/useNativeAnalyzer.js';

interface ImgState {
  widthPct:        number;
  lowMonoHz:       number;
  stereoize:       boolean;
  bandLowPct:      number;
  bandMidLowPct:   number;
  bandMidHighPct:  number;
  bandHighPct:     number;
}

const findImg = (id: string) =>
  ALL_MODULE_PARAMETER_DEFS.imager.parameters.find((p) => p.id === id)!.default;
const DEFAULTS: ImgState = {
  widthPct:       findImg('widthPct')       as number,
  lowMonoHz:      findImg('lowMonoHz')      as number,
  stereoize:      findImg('stereoize')      as boolean,
  bandLowPct:     findImg('bandLowPct')     as number,
  bandMidLowPct:  findImg('bandMidLowPct')  as number,
  bandMidHighPct: findImg('bandMidHighPct') as number,
  bandHighPct:    findImg('bandHighPct')    as number,
};

const BAND_KEYS = ['bandLowPct', 'bandMidLowPct', 'bandMidHighPct', 'bandHighPct'] as const;
const BAND_LABELS = ['Low', 'Mid-Low', 'Mid-High', 'High'];

export function ImagerParameterPanel(props: ControlledPanelProps = {}) {
  const { state: s, setParam } = usePanelStateBridge<ImgState>(DEFAULTS, props);
  const media = useMediaElement();
  const nativeAnalyzer = useNativeAnalyzer(media);
  const correlationAvailable = nativeAnalyzer.status === 'connected' && nativeAnalyzer.lastFrameAt !== null;
  const correlation = correlationAvailable ? nativeAnalyzer.meters.correlation : null;

  const update = <K extends keyof ImgState>(k: K) => (v: ImgState[K]) => setParam(k, v);

  const correlationStatus: 'ok' | 'warn' | 'danger' =
    correlation === null ? 'ok'
    : correlation < -0.1 ? 'danger'
    : correlation < 0.2  ? 'warn'
    : 'ok';

  return (
    <>
      <LouiSectionCard
        title="Correlation"
        trailing={
          correlation !== null
            ? (
              <LouiValueBadge label="Live" status={correlationStatus}>
                {correlation.toFixed(2)}
              </LouiValueBadge>
            )
            : undefined
        }
      >
        <LouiMiniMeter
          value={correlation ?? 0}
          mode="mirror"
          status={correlationStatus}
          readout={
            correlation === null
              ? '재생 중 표시됩니다'
              : correlation < 0.2
                ? 'Phase risk — fold-down may cancel'
                : 'Stable'
          }
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
          {BAND_KEYS.map((key, i) => (
            <BandBar
              key={key}
              label={BAND_LABELS[i]!}
              value={s[key]}
              onChange={(v) => setParam(key, v)}
            />
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
  const fillPct = Math.max(0, Math.min(200, value)) / 2;
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
