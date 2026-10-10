// The analogue drum machine's own panel.
//
// Forty-six parameters across eleven voices, and the shape of that decides
// the layout: a row of pads to pick a voice, that voice's controls beneath
// it, and one mixer row so balancing the kit does not mean clicking through
// eleven pages.  Which is what the front panel of every machine this models
// looked like, and for the same reason.
//
// The picture is the HIT.  There is no filter here and so no curve to draw;
// what a drum voice IS, is a shape a couple of hundred milliseconds long, and
// a drum hit is short enough that rendering it and plotting it is not an
// approximation of the sound but the sound itself.
//
// The kick gets a second picture, because the one thing that makes it an 808
// kick rather than a sine with an envelope — its frequency falling — happens
// below the resolution a waveform display has at fifty hertz.

import React, { useCallback, useState } from 'react';
import Knob from '../plugin/Knob.js';
import { HitView, SweepView } from './DrumCanvas.jsx';
import {
  DRUM_VOICES, DRUM_VOICE_NAMES, type DrumVoice,
} from '../../../daw/engine/drum-machine.js';
import { findInstrument } from '../../../daw/engine/instruments.js';
import { premium } from '../../../theme/premium.js';

export interface DrumPanelProps {
  params: Readonly<Record<string, number>>;
  /** Live, per movement. */
  onDrag: (id: string, value: number) => void;
  /** Once, on release — one undo step for the whole gesture. */
  onCommit: () => void;
}

/** Every box on the panel, at a width it is given rather than one it takes. */
function Section(
  { title, right, children, width }: {
    title: string; right?: React.ReactNode; children: React.ReactNode; width?: number;
  },
): React.ReactElement {
  return (
    <div
      className="rounded-md p-1.5 flex flex-col gap-1"
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: `1px solid ${premium.surface.hairline}`,
        ...(width ? { width, flex: '0 0 auto' } : { flex: '1 1 auto' }),
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[9px] tracking-widest" style={{ color: premium.accent.light }}>{title}</span>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

/**
 * Which General MIDI note plays each voice, for the label on its pad.
 *
 * Shown because a drum part is written by note number and a machine whose
 * pads do not say which note they answer to is one you have to guess at.
 */
const VOICE_NOTE: Readonly<Record<DrumVoice, number>> = {
  bd: 36, sd: 38, cp: 39, lt: 41, mt: 45, ht: 48,
  ch: 42, oh: 46, cy: 49, rs: 37, cb: 56,
};

export default function DrumPanel(
  { params, onDrag, onCommit }: DrumPanelProps,
): React.ReactElement {
  const [voice, setVoice] = useState<DrumVoice>('bd');
  const descriptor = findInstrument('drummachine');

  /** A knob, from the instrument's OWN parameter definition. */
  const knob = useCallback((id: string, label?: string, size = 30) => {
    const def = descriptor?.params.find((d) => d.id === id);
    if (!def) return null;
    const time = def.unit === 's' || def.unit === 'Hz';
    return (
      <Knob
        key={id}
        label={label ?? def.name}
        value={params[id] ?? def.default}
        min={def.min}
        max={def.max}
        defaultValue={def.default}
        unit={def.unit}
        size={size}
        curve={time && def.min > 0 ? 'log' : 'linear'}
        onChange={(v) => onDrag(id, v)}
        onCommit={onCommit}
      />
    );
  }, [descriptor, params, onDrag, onCommit]);

  const num = (id: string, fallback: number): number => {
    const v = params[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  return (
    <div className="flex flex-col gap-2 mt-2">
      <Section title="VOICES">
        <div className="flex gap-0.5 flex-wrap">
          {DRUM_VOICES.map((v) => (
            <button
              key={v}
              onClick={() => setVoice(v)}
              className="hit-target h-7 px-1.5 rounded text-[9px] leading-tight"
              style={{
                background: voice === v ? premium.accent.deep : 'transparent',
                color: voice === v ? premium.accent.light : premium.text.muted,
                border: `1px solid ${voice === v ? premium.accent.deep : 'rgba(255,255,255,0.12)'}`,
                minWidth: 54,
              }}
              title={`노트 ${VOICE_NOTE[v]}`}
            >
              <div>{DRUM_VOICE_NAMES[v]}</div>
              <div style={{ color: premium.text.faint }}>{VOICE_NOTE[v]}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title={DRUM_VOICE_NAMES[voice].toUpperCase()}>
        <div className="flex gap-2 flex-wrap items-start">
          <HitView voice={voice} params={params} width={300} height={72} />
          {voice === 'bd' && (
            <SweepView
              tuneHz={num('bdtune', 52)} bend={num('bdbend', 26)}
              decay={num('bddec', 0.55)} master={num('tune', 0)}
              width={150} height={72}
            />
          )}
          <div className="flex flex-wrap gap-x-0.5 gap-y-0 flex-1">
            {knob(`${voice}tune`, 'TUNE')}
            {knob(`${voice}dec`, 'DECAY')}
            {knob(`${voice}bend`, 'BEND')}
            {/* The controls a voice has beyond tune, decay, bend and level,
                written out rather than looked up in a table.  A kick has no
                Snappy and a hat has no Drive, and pretending otherwise is how
                a drum machine turns into a kit with eleven identical channel
                strips.  Written out because a table of ids fed through a
                variable is not an edit site the coverage check can see — and
                it was right not to: six parameters were unreachable behind
                one. */}
            {voice === 'bd' && knob('bdsnap', 'SNAP')}
            {voice === 'bd' && knob('bddrive', 'DRIVE')}
            {voice === 'sd' && knob('sdtone', 'TONE')}
            {voice === 'sd' && knob('sdsnappy', 'SNAPPY')}
            {voice === 'sd' && knob('sdsnapdec', 'SNAP DEC')}
            {voice === 'cp' && knob('cpspread', 'SPREAD')}
            {knob(`${voice}lvl`, 'LEVEL')}
          </div>
        </div>
        <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
          {voice === 'oh'
            ? '오픈 하이햇은 클로즈드와 같은 금속 소스를 씁니다 — 튜닝은 HAT TUNE 하나로 둘 다 움직입니다'
            : (voice === 'ch' || voice === 'cy'
              ? '사각파 여섯 개를 서로 비조화한 배율로 겹친 뒤 하이패스 — 노이즈는 한 방울도 없습니다. 그래서 음정이 있습니다'
              : '')}
        </div>
      </Section>

      <div className="flex gap-1.5 flex-wrap items-start">
        <Section title="MIX">
          {/* Every voice's level in one row.  Balancing a kit by clicking
              through eleven pages is the thing a mixer row exists to stop. */}
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {DRUM_VOICES.map((v) => knob(`${v}lvl`, DRUM_VOICE_NAMES[v].toUpperCase(), 28))}
          </div>
        </Section>

        <Section title="GLOBAL" width={214}>
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('tune', 'TUNE')}
            {knob('accent', 'ACCENT')}
            {knob('width', 'WIDTH')}
            {knob('level', 'LEVEL')}
          </div>
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            ACCENT 은 벨로시티가 얼마나 중요한지입니다 — 0 이면 모든 히트가 같은 크기,
            1 이면 세기를 그대로 따릅니다
          </div>
        </Section>
      </div>
    </div>
  );
}
