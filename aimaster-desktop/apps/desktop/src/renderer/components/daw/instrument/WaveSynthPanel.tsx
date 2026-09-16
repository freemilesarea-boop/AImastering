// The wavetable synth's own panel.
//
// The rack draws every instrument's knobs from `InstrumentParamDef`, which is
// right for an instrument with fifteen of them and useless for one with a
// hundred and thirteen: a flat grid of a hundred knobs is every control and
// no way to find one.  The knobs are the same knobs — this is a LAYOUT, not a
// second way to edit — and what it adds is the two things a flat grid cannot
// have.
//
//   · GROUPING that matches the signal path.  Oscillators, then the sub and
//     the noise that join them, then the filter they all go through, then the
//     modulation that moves the lot.  You can read the instrument off the
//     panel.
//   · PICTURES of the things a number cannot describe.  "Table 4, position
//     3.2" tells you nothing; the shape at 3.2 sitting between the shapes
//     either side of it tells you what the knob will do.  The same for the
//     filter's curve, the envelopes and the LFOs — all drawn from the same
//     maths the engine runs, in `synth-views.ts`.
//
// The matrix gets a grid rather than twenty-four knobs, because a matrix row
// is a sentence — LFO 2 → CUTOFF, −60% — and three knobs labelled M2 Src,
// M2 Dst and M2 Amt is that sentence with the words taken apart.

import React, { useCallback, useState } from 'react';
import Knob from '../plugin/Knob.js';
import { EnvelopeView, FilterView, LfoView, WavetableView } from './SynthCanvas.jsx';
import { WAVETABLES, wavetableAt } from '../../../daw/engine/wavetable.js';
import {
  LFO_SHAPES, MATRIX_ROWS, MOD_DESTS, MOD_SOURCES, rowParams,
} from '../../../daw/engine/mod-matrix.js';
import { FILTER_MODE_NAMES } from '../../../daw/model/synth-views.js';
import { findInstrument } from '../../../daw/engine/instruments.js';
import { premium } from '../../../theme/premium.js';

export interface WaveSynthPanelProps {
  params: Readonly<Record<string, number>>;
  /** Live, per movement. */
  onDrag: (id: string, value: number) => void;
  /** Once, on release — one undo step for the whole gesture. */
  onCommit: () => void;
}

const SUB_WAVE_NAMES = ['Sine', 'Tri', 'Square', 'Saw'] as const;

/**
 * Every box on the panel, at a width it is given rather than one it takes.
 *
 * The rack is about seven hundred pixels wide and the first version let the
 * sections size themselves, which put one oscillator per row and turned the
 * panel into the tall list it was meant to replace.  Widths are stated here
 * so the three top boxes fit on one line, and the knobs inside wrap to fill
 * the column instead of pushing it open.
 */
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

/** A dropdown that stores its choice as a number, like every other parameter. */
function Choice(
  { value, names, title, onPick, width }: {
    value: number; names: readonly string[]; title?: string;
    onPick: (v: number) => void; width?: number;
  },
): React.ReactElement {
  return (
    <select
      value={Math.max(0, Math.min(names.length - 1, Math.round(value)))}
      title={title ?? ''}
      onChange={(e) => onPick(Number(e.target.value))}
      className="h-5 px-1 rounded text-[9px] bg-zinc-900 border border-zinc-700 text-zinc-200"
      style={width ? { width } : undefined}
    >
      {names.map((n, i) => <option key={n} value={i}>{n}</option>)}
    </select>
  );
}

export default function WaveSynthPanel(
  { params, onDrag, onCommit }: WaveSynthPanelProps,
): React.ReactElement {
  const [tab, setTab] = useState<string>('ENV 1');
  const descriptor = findInstrument('wavesynth');

  /**
   * A knob, from the instrument's OWN parameter definition.
   *
   * The range, the default and the unit all come from `InstrumentParamDef`
   * rather than being typed again here — a panel that restated them would be
   * a second place for the cutoff's range to be wrong, and the two would
   * disagree the first time one of them changed.
   */
  const knob = useCallback((id: string, label?: string, size = 32) => {
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

  const set = useCallback((id: string, v: number) => { onDrag(id, v); onCommit(); }, [onDrag, onCommit]);
  const num = (id: string, fallback: number): number => {
    const v = params[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  const oscillator = (o: 'a' | 'b'): React.ReactElement => {
    const up = o.toUpperCase();
    const tableIndex = Math.round(num(`${o}Table`, o === 'a' ? 0 : 1));
    const table = wavetableAt(tableIndex);
    return (
      <Section
        width={214}
        title={`OSC ${up}`}
        right={(
          <div className="flex items-center gap-1">
            <button
              className="hit-target h-5 w-4 rounded text-[9px]"
              style={{ color: premium.text.muted }}
              title="이전 표"
              onClick={() => set(`${o}Table`, Math.max(0, tableIndex - 1))}
            >‹</button>
            <Choice
              value={tableIndex}
              names={WAVETABLES.map((t) => t.name)}
              title={table.note}
              onPick={(v) => set(`${o}Table`, v)}
              width={86}
            />
            <button
              className="hit-target h-5 w-4 rounded text-[9px]"
              style={{ color: premium.text.muted }}
              title="다음 표"
              onClick={() => set(`${o}Table`, Math.min(WAVETABLES.length - 1, tableIndex + 1))}
            >›</button>
          </div>
        )}
      >
        <WavetableView tableIndex={tableIndex} pos={num(`${o}Pos`, 0)} width={198} height={78} />
        <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>{table.note}</div>
        <div className="flex flex-wrap gap-x-0.5 gap-y-0">
          {knob(`${o}Pos`, 'WT POS', 30)}
          {knob(`${o}Unison`, 'UNISON', 30)}
          {knob(`${o}Detune`, 'DETUNE', 30)}
          {knob(`${o}Blend`, 'BLEND', 30)}
          {knob(`${o}Width`, 'WIDTH', 30)}
          {knob(`${o}Phase`, 'PHASE', 30)}
          {knob(`${o}Rand`, 'RAND', 30)}
          {knob(`${o}Pan`, 'PAN', 30)}
          {knob(`${o}Oct`, 'OCT', 30)}
          {knob(`${o}Semi`, 'SEMI', 30)}
          {knob(`${o}Fine`, 'FINE', 30)}
          {knob(`${o}Level`, 'LEVEL', 30)}
        </div>
      </Section>
    );
  };

  const envTab = (n: number): React.ReactElement => (
    <div className="flex items-center gap-2 flex-wrap">
      <EnvelopeView
        attack={num(`e${n}a`, 0.01)} decay={num(`e${n}d`, 0.3)}
        sustain={num(`e${n}s`, 0.5)} release={num(`e${n}r`, 0.2)}
        width={236} height={72}
      />
      <div className="flex gap-1">
        {knob(`e${n}a`, 'ATTACK', 32)}
        {knob(`e${n}d`, 'DECAY', 32)}
        {knob(`e${n}s`, 'SUSTAIN', 32)}
        {knob(`e${n}r`, 'RELEASE', 32)}
      </div>
      <span className="text-[8px] max-w-[190px] leading-tight" style={{ color: premium.text.faint }}>
        {n === 1
          ? 'ENV 1 은 앰프 엔벨로프입니다 — 매트릭스에 쓰지 않아도 항상 소리를 여닫습니다'
          : `ENV ${n} 은 매트릭스 소스입니다. 어디로도 보내지 않으면 아무 일도 하지 않습니다`}
      </span>
    </div>
  );

  const lfoTab = (n: number): React.ReactElement => {
    const synced = num(`l${n}sync`, 1) > 0.5;
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <LfoView shape={num(`l${n}shape`, 0)} skew={num(`l${n}skew`, 0.5)} width={236} height={72} />
        <div className="flex flex-col gap-1">
          <Choice
            value={num(`l${n}shape`, 0)} names={LFO_SHAPES}
            title="모양 — SKEW 로 그 사이를 오갑니다"
            onPick={(v) => set(`l${n}shape`, v)} width={92}
          />
          <button
            className="h-5 px-1.5 rounded text-[9px]"
            style={{
              border: `1px solid ${synced ? premium.accent.deep : 'rgba(255,255,255,0.14)'}`,
              color: synced ? premium.accent.base : premium.text.muted,
            }}
            title={synced ? '박자에 묶여 있습니다 — BEATS 가 한 주기의 길이' : '자유 주행 — RATE 가 헤르츠'}
            onClick={() => set(`l${n}sync`, synced ? 0 : 1)}
          >{synced ? 'BPM' : 'FREE'}</button>
        </div>
        <div className="flex gap-1">
          {synced ? knob(`l${n}beats`, 'BEATS', 32) : knob(`l${n}rate`, 'RATE', 32)}
          {knob(`l${n}skew`, 'SKEW', 32)}
          {knob(`l${n}phase`, 'PHASE', 32)}
          {knob(`l${n}delay`, 'DELAY', 32)}
          {knob(`l${n}rise`, 'RISE', 32)}
        </div>
      </div>
    );
  };

  const matrixTab = (): React.ReactElement => (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: MATRIX_ROWS }, (_, r) => {
        const ids = rowParams(r);
        const src = Math.round(num(ids.src, 0));
        const dst = Math.round(num(ids.dst, 0));
        const amt = num(ids.amt, 0);
        const live = src > 0 && dst > 0 && Math.abs(amt) > 0.0005;
        return (
          <div key={r} className="flex items-center gap-1.5">
            <span className="text-[9px] w-5 shrink-0" style={{ color: live ? premium.accent.base : premium.text.faint }}>
              {r + 1}
            </span>
            <Choice value={src} names={MOD_SOURCES.map((s) => s.name)} onPick={(v) => set(ids.src, v)} width={92} />
            <span className="text-[9px]" style={{ color: premium.text.faint }}>→</span>
            <Choice value={dst} names={MOD_DESTS.map((d) => d.name)} onPick={(v) => set(ids.dst, v)} width={104} />
            {/* The depth is a SLIDER and not a knob: it is bipolar and its
                centre is off, and a horizontal track shows which side of
                zero eight rows are on at a glance. */}
            <input
              type="range" min={-1} max={1} step={0.005} value={amt}
              onChange={(e) => onDrag(ids.amt, Number(e.target.value))}
              onPointerUp={onCommit}
              onDoubleClick={() => set(ids.amt, 0)}
              title="깊이 — 두 번 누르면 0"
              className="flex-1 h-4"
            />
            <span className="text-[9px] w-9 text-right tabular-nums"
                  style={{ color: live ? premium.text.secondary : premium.text.faint }}>
              {`${amt >= 0 ? '+' : ''}${Math.round(amt * 100)}%`}
            </span>
          </div>
        );
      })}
      <div className="text-[8px] mt-0.5" style={{ color: premium.text.faint }}>
        소스도 목적지도 깊이도 있어야 한 줄이 작동합니다 — 셋 중 하나라도 비면 그 줄은 계산되지 않습니다
      </div>
    </div>
  );

  const tabs = ['ENV 1', 'ENV 2', 'ENV 3', 'LFO 1', 'LFO 2', 'LFO 3', 'LFO 4', 'MATRIX'];

  return (
    <div className="flex flex-col gap-2 mt-2">
      {/* Top row: the two oscillators and the filter they both go through,
          sized so the rack's seven hundred pixels hold all three on one line.
          The first version let them size themselves and put one oscillator
          per row, which is the tall list this panel exists to replace. */}
      <div className="flex gap-1.5 flex-wrap items-start">
        {oscillator('a')}
        {oscillator('b')}

        <Section
          width={214}
          title="FILTER"
          right={(
            <div className="flex items-center gap-1">
              <Choice
                value={num('fltType', 0)} names={FILTER_MODE_NAMES}
                onPick={(v) => set('fltType', v)} width={62}
              />
              <button
                className="hit-target h-5 px-1.5 rounded text-[9px]"
                style={{
                  border: `1px solid ${num('flt24', 1) > 0.5 ? premium.accent.deep : 'rgba(255,255,255,0.14)'}`,
                  color: num('flt24', 1) > 0.5 ? premium.accent.base : premium.text.muted,
                }}
                title="한 번 더 통과시켜 기울기를 두 배로"
                onClick={() => set('flt24', num('flt24', 1) > 0.5 ? 0 : 1)}
              >{num('flt24', 1) > 0.5 ? '24 dB' : '12 dB'}</button>
            </div>
          )}
        >
          <FilterView
            mode={num('fltType', 0)} poles={num('flt24', 1) > 0.5 ? 2 : 1}
            cutoffSemis={num('cutoff', 110)} res={num('res', 0.15)}
            width={198} height={78}
          />
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('cutoff', 'CUTOFF', 30)}
            {knob('res', 'RES', 30)}
            {knob('drive', 'DRIVE', 30)}
            {knob('fltMix', 'MIX', 30)}
            {knob('fltKey', 'KEY TRK', 30)}
            {knob('level', 'LEVEL', 30)}
          </div>
        </Section>
      </div>

      <div className="flex gap-1.5 flex-wrap items-start">
        <Section title="SUB · NOISE" width={214}>
          <Choice
            value={num('subWave', 0)} names={SUB_WAVE_NAMES}
            title="서브 파형 — 필터 앞으로 들어갑니다"
            onPick={(v) => set('subWave', v)} width={72}
          />
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('subOct', 'SUB OCT', 30)}
            {knob('subLevel', 'SUB', 30)}
            {knob('noiseColour', 'COLOUR', 30)}
            {knob('noiseLevel', 'NOISE', 30)}
          </div>
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            COLOUR: 0 화이트 · 0.5 핑크 · 1 브라운
          </div>
        </Section>

        <Section title="MACRO · CONTROLLER">
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('macro1', '1', 30)}
            {knob('macro2', '2', 30)}
            {knob('macro3', '3', 30)}
            {knob('macro4', '4', 30)}
            {knob('wheel', 'MOD WHL', 30)}
            {knob('pressure', 'PRESS', 30)}
          </div>
          {/* MOD WHL and PRESS are here because they are the only way those
              two matrix sources can be anything but zero.  Nothing plays a
              controller into this instrument yet — a MIDI part carries per
              note pitch bend and pressure, and the wheel is a channel message
              with nowhere to land — so these are a held value standing in for
              one, which is enough to build a patch around and honest about
              being that. */}
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            매크로는 매트릭스의 소스입니다 — 보내기 전에는 노브일 뿐입니다.
            MOD WHL · PRESS 는 아직 컨트롤러가 연결되지 않아 고정값입니다
          </div>
        </Section>
      </div>

      <Section title="MODULATION">
        <div className="flex gap-0.5 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="hit-target h-5 px-2 rounded text-[9px] tracking-wide"
              style={{
                background: tab === t ? premium.accent.deep : 'transparent',
                color: tab === t ? premium.accent.light : premium.text.muted,
                border: `1px solid ${tab === t ? premium.accent.deep : 'transparent'}`,
              }}
            >{t}</button>
          ))}
        </div>
        <div className="pt-1">
          {tab.startsWith('ENV') && envTab(Number(tab.slice(4)))}
          {tab.startsWith('LFO') && lfoTab(Number(tab.slice(4)))}
          {tab === 'MATRIX' && matrixTab()}
        </div>
      </Section>
    </div>
  );
}
