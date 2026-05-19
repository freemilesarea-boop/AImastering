// Storybook stories for the six product control primitives.
//
// Each story is interactive: knob drag / slider drag / toggle click /
// chip selection updates the local state, with the live readout
// reflecting the current value.

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  LouiKnob,
  LouiSliderRow,
  LouiTogglePill,
  LouiValueBadge,
  LouiMiniMeter,
  LouiSectionCard,
} from './index';

function Showcase() {
  const [knob,    setKnob]    = React.useState(0.0);
  const [slider,  setSlider]  = React.useState(-14);
  const [toggle,  setToggle]  = React.useState(true);
  const [meter,   setMeter]   = React.useState(0.4);
  const [mirror,  setMirror]  = React.useState(0.7);

  React.useEffect(() => {
    const id = setInterval(() => {
      setMeter((v) => Math.max(0, Math.min(1, v + (Math.random() - 0.5) * 0.15)));
      setMirror((v) => Math.max(-1, Math.min(1, v + (Math.random() - 0.5) * 0.18)));
    }, 120);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      width: 600,
      background: '#09090b',
      color: '#e4e4e7',
      padding: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    }}>
      <LouiSectionCard
        title="Knob"
        trailing={<LouiValueBadge label="Value" status="accent">{knob.toFixed(1)} dB</LouiValueBadge>}
      >
        <div style={{ display: 'flex', justifyContent: 'space-around', paddingBlock: 8 }}>
          <LouiKnob value={knob} min={-12} max={12} step={0.1} label="Gain" unit="dB"
                    format={(v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))}
                    onChange={setKnob} />
          <LouiKnob value={knob} min={-12} max={12} step={0.1} label="Disabled" unit="dB"
                    disabled />
          <LouiKnob value={knob} min={-12} max={12} step={0.1} label="Small" unit="dB"
                    size={48}
                    onChange={setKnob} />
        </div>
      </LouiSectionCard>

      <LouiSectionCard title="Slider Row">
        <LouiSliderRow label="Threshold" value={slider} min={-30} max={0} step={0.5}
                       unit="dB" hint="Compressor threshold"
                       onChange={setSlider} />
        <LouiSliderRow label="Disabled" value={-10} min={-30} max={0} disabled />
      </LouiSectionCard>

      <LouiSectionCard title="Toggle Pill">
        <LouiTogglePill label="Bypass"      value={toggle}  onChange={setToggle}
                        hint="Enable / bypass this module" />
        <LouiTogglePill label="True-Peak"   value={!toggle} onChange={(v) => setToggle(!v)}
                        onLabel="ISP" offLabel="Sample" />
        <LouiTogglePill label="Disabled"    value={true}    disabled />
      </LouiSectionCard>

      <LouiSectionCard title="Value Badges">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <LouiValueBadge label="LUFS">-14.0 LUFS</LouiValueBadge>
          <LouiValueBadge label="TP" status="warn">-0.8 dBTP</LouiValueBadge>
          <LouiValueBadge label="Phase" status="danger">-0.35</LouiValueBadge>
          <LouiValueBadge label="Match" status="ok">0.94</LouiValueBadge>
          <LouiValueBadge label="Preset" status="accent">Streaming Loud</LouiValueBadge>
        </div>
      </LouiSectionCard>

      <LouiSectionCard title="Mini Meter">
        <LouiMiniMeter value={meter} label="Gain Reduction" status="ok"
                       readout={`${(-meter * 12).toFixed(1)} dB`} height={10} />
        <LouiMiniMeter value={mirror} label="Correlation" mode="mirror"
                       status={mirror > 0.2 ? 'ok' : mirror > -0.1 ? 'warn' : 'danger'}
                       readout={mirror.toFixed(2)} height={10} />
        <LouiMiniMeter value={0.95} label="Limiter Activity" status="danger"
                       readout="−11.4 dB" />
      </LouiSectionCard>
    </div>
  );
}

const meta: Meta<typeof Showcase> = {
  title: 'Product / Controls / Showcase',
  component: Showcase,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'All six product control primitives — Knob, SliderRow, ' +
          'TogglePill, ValueBadge, MiniMeter, SectionCard — composed ' +
          'in a single scrollable showcase.  Used to verify visual ' +
          'consistency before composing the module parameter panels.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof Showcase>;

export const AllPrimitives: Story = {};
