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
        {/* Stereoize — not yet implemented */}
        <div style={{ opacity: 0.4, pointerEvents: 'none' }}>
          <LouiTogglePill
            label="Stereoize"
            hint="준비 중 — 아직 적용되지 않습니다"
            value={s.stereoize}
            onChange={update('stereoize')}
          />
        </div>
      </LouiSectionCard>

      {/* Width by Band.  This section used to be locked, badged 준비 중, and
          captioned "다음 업데이트에서 지원됩니다" — and it worked the whole time.
          The path is this panel → `chain-config.ts` → `chainConfigToJson` →
          `Chain.setConfigJson` → the Rust `ImagerConfig.band_width_pct`, and
          the reason it reads as dead from here is that the only consumer is a
          serde deserialiser on the other side of a JSON string.  Measured
          through the chain the app actually runs: the AI-vocal preset's 78 %
          top band takes 2.01 dB off the side at 9 kHz, against 2.16 dB for a
          perfect 78 %.  The app was already shipping presets that set these
          bands and an analysis that narrowed the top from them, with the user
          locked out of the controls.

          This file is reached only from Storybook — the app renders every
          module through the generic `ModuleParameterPanel`, which has always
          shown these four as ordinary sliders.  So nobody was shown the wrong
          message; what was wrong was the story, and a story is where somebody
          goes to find out what a control does. */}
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
        <p style={{
          margin: 0,
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          lineHeight: 1.5,
        }}>
          대역 경계는 120 Hz · 800 Hz · 5 kHz 입니다. 위의 전체 Width 가 각 대역 값에 곱해지므로,
          저역만 좁히고 고역만 넓히는 식으로 대역마다 다르게 둘 수 있습니다.
        </p>
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
