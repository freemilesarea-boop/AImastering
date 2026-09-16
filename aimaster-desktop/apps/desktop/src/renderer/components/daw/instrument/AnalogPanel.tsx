// The analogue synth's own panel.
//
// Same argument as the wavetable synth's next door — fifty-eight knobs in one
// flat grid is every control and no way to find one — but the LAYOUT is a
// different instrument's, and that is the point of having two.
//
// A wavetable synth is a table, a filter and a modulation matrix, so its
// panel is three boxes and a tabbed matrix.  An analogue synth is a signal
// path you can follow with your finger: two VCOs and a sub and some noise go
// into a mixer, the mixer goes into one ladder, the ladder goes into a VCA,
// and two envelopes and two LFOs move the lot.  There is no matrix because
// there was no matrix — the routing is the eight fixed sends a panel of this
// kind has always had, and offering a hundred destinations would be modelling
// a different instrument.
//
// The pictures are the three things a number cannot say:
//
//   · what a VCO's shape and pulse width actually look like, which matters
//     here because the triangle is the integral of the pulse and its width
//     control therefore does something
//   · the ladder's curve WITH the resonance-off curve behind it, so the bass
//     the feedback removes is visible and BASS COMP can be seen putting it
//     back
//   · drift and component tolerance, over ten seconds and across the voices —
//     the two controls that make this analogue and the two whose numbers say
//     least

import React, { useCallback, useState } from 'react';
import Knob from '../plugin/Knob.js';
import {
  AnalogCharacterView, AnalogEnvView, AnalogWaveView, LadderView,
} from './AnalogCanvas.jsx';
import { ANALOG_SHAPE_NAMES } from '../../../daw/model/analog-views.js';
import { LFO_SHAPES } from '../../../daw/engine/mod-matrix.js';
import { findInstrument } from '../../../daw/engine/instruments.js';
import { premium } from '../../../theme/premium.js';

export interface AnalogPanelProps {
  params: Readonly<Record<string, number>>;
  /** Live, per movement. */
  onDrag: (id: string, value: number) => void;
  /** Once, on release — one undo step for the whole gesture. */
  onCommit: () => void;
}

/**
 * Every box on the panel, at a width it is given rather than one it takes.
 *
 * The rack row measures 671 px, MEASURED in the running app rather than
 * guessed — the first draft of this panel used 222 and three of those plus
 * their gaps come to 678, which put the ladder on its own line.  Three at 214
 * come to 654 and leave room for the scrollbar.
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

/** An on/off parameter as the lit button a hardware one would be. */
function Toggle(
  { on, label, title, onClick }: {
    on: boolean; label: string; title?: string; onClick: () => void;
  },
): React.ReactElement {
  return (
    <button
      className="hit-target h-5 px-1.5 rounded text-[9px] tracking-wide"
      style={{
        border: `1px solid ${on ? premium.accent.deep : 'rgba(255,255,255,0.14)'}`,
        color: on ? premium.accent.base : premium.text.muted,
      }}
      title={title ?? ''}
      onClick={onClick}
    >{label}</button>
  );
}

export default function AnalogPanel(
  { params, onDrag, onCommit }: AnalogPanelProps,
): React.ReactElement {
  const [tab, setTab] = useState<string>('AMP ENV');
  const descriptor = findInstrument('analog');

  /**
   * A knob, from the instrument's OWN parameter definition.
   *
   * The range, the default and the unit come from `InstrumentParamDef` rather
   * than being typed again here — a panel that restated them would be a
   * second place for the cutoff's range to be wrong.
   */
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

  const set = useCallback((id: string, v: number) => { onDrag(id, v); onCommit(); }, [onDrag, onCommit]);
  const num = (id: string, fallback: number): number => {
    const v = params[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  const vco = (o: 'o1' | 'o2'): React.ReactElement => {
    const n = o === 'o1' ? 1 : 2;
    const shape = num(`${o}shape`, 0);
    return (
      <Section
        width={214}
        title={`VCO ${n}`}
        right={(
          <Choice
            value={shape}
            names={ANALOG_SHAPE_NAMES}
            title="파형 — PW 는 펄스와 삼각파에만 작용합니다"
            onPick={(v) => set(`${o}shape`, v)}
            width={78}
          />
        )}
      >
        <AnalogWaveView shape={shape} pw={num(`${o}width`, 0.5)} width={198} height={62} />
        <div className="flex flex-wrap gap-x-0.5 gap-y-0">
          {knob(`${o}width`, 'PW')}
          {knob(`${o}oct`, 'OCT')}
          {knob(`${o}semi`, 'SEMI')}
          {knob(`${o}fine`, 'FINE')}
          {knob(`${o}level`, 'LEVEL')}
        </div>
        {n === 2 && (
          <div className="flex items-center gap-1">
            <Toggle
              on={num('sync', 0) > 0.5} label="SYNC"
              title="VCO 2 의 위상을 VCO 1 이 한 바퀴 돌 때마다 0 으로 — 음정이 아니라 음색이 바뀝니다"
              onClick={() => set('sync', num('sync', 0) > 0.5 ? 0 : 1)}
            />
            <Toggle
              on={num('ring', 0) > 0.5} label="RING"
              title="두 VCO 를 곱합니다 — 합과 차의 주파수만 남아 종·금속 소리가 됩니다"
              onClick={() => set('ring', num('ring', 0) > 0.5 ? 0 : 1)}
            />
          </div>
        )}
      </Section>
    );
  };

  const envTab = (n: number): React.ReactElement => (
    <div className="flex items-center gap-2 flex-wrap">
      <AnalogEnvView
        attack={num(`e${n}a`, 0.01)} decay={num(`e${n}d`, 0.4)}
        sustain={num(`e${n}s`, 0.6)} release={num(`e${n}r`, 0.25)}
        curve={num('envCurve', 0.85)}
        width={236} height={72}
      />
      <div className="flex gap-1">
        {knob(`e${n}a`, 'ATTACK', 32)}
        {knob(`e${n}d`, 'DECAY', 32)}
        {knob(`e${n}s`, 'SUSTAIN', 32)}
        {knob(`e${n}r`, 'RELEASE', 32)}
        {knob('envCurve', 'CURVE', 32)}
      </div>
      <span className="text-[8px] max-w-[190px] leading-tight" style={{ color: premium.text.faint }}>
        {n === 1
          ? 'ENV 1 은 VCA 엔벨로프입니다 — 언제나 소리를 여닫습니다'
          : 'ENV 2 는 필터로 갑니다 — FILTER 의 ENV AMT 가 그 깊이입니다'}
        {' '}CURVE 0 은 직선(디지털), 1 은 축전기가 그리는 곡선입니다. 흐린 선이 0 일 때의 모양입니다
      </span>
    </div>
  );

  const lfoTab = (n: number): React.ReactElement => {
    const synced = num(`l${n}sync`, 0) > 0.5;
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex flex-col gap-1">
          <Choice
            value={num(`l${n}shape`, 0)} names={LFO_SHAPES}
            title="모양"
            onPick={(v) => set(`l${n}shape`, v)} width={92}
          />
          <Toggle
            on={synced} label={synced ? 'BPM' : 'FREE'}
            title={synced ? '박자에 묶여 있습니다 — BEATS 가 한 주기' : '자유 주행 — RATE 가 헤르츠'}
            onClick={() => set(`l${n}sync`, synced ? 0 : 1)}
          />
        </div>
        <div className="flex gap-1">
          {synced ? knob(`l${n}beats`, 'BEATS', 32) : knob(`l${n}rate`, 'RATE', 32)}
          {knob(`l${n}delay`, 'DELAY', 32)}
        </div>
        <span className="text-[8px] max-w-[210px] leading-tight" style={{ color: premium.text.faint }}>
          DELAY 는 건반을 누른 뒤 LFO 가 올라오기까지의 시간입니다 — 비브라토를 손으로 넣는 대신
          {n === 1 ? ' ROUTING 의 L1 보내기로 깊이를 정합니다' : ' ROUTING 의 L2 보내기로 깊이를 정합니다'}
        </span>
      </div>
    );
  };

  const routingTab = (): React.ReactElement => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] w-8 shrink-0" style={{ color: premium.accent.light }}>LFO 1</span>
        <div className="flex flex-wrap gap-x-0.5 gap-y-0">
          {knob('l1pitch', '→ PITCH')}
          {knob('l1pw', '→ PW')}
          {knob('l1flt', '→ FILTER')}
          {knob('l1amp', '→ AMP')}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] w-8 shrink-0" style={{ color: premium.accent.light }}>LFO 2</span>
        <div className="flex flex-wrap gap-x-0.5 gap-y-0">
          {knob('l2pitch', '→ PITCH')}
          {knob('l2flt', '→ FILTER')}
        </div>
      </div>
      <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
        고정 배선입니다 — 아날로그 신디사이저의 앞판이 원래 그렇습니다.
        보낼 곳을 자유롭게 고르고 싶다면 옆의 웨이브테이블 신디사이저에 8줄짜리 매트릭스가 있습니다
      </div>
    </div>
  );

  const tabs = ['AMP ENV', 'FLT ENV', 'LFO 1', 'LFO 2', 'ROUTING'];
  const poles = Math.round(num('poles', 4));

  return (
    <div className="flex flex-col gap-2 mt-2">
      {/* Top row: the two VCOs and the ladder they both go through. */}
      <div className="flex gap-1.5 flex-wrap items-start">
        {vco('o1')}
        {vco('o2')}

        <Section
          width={214}
          title="LADDER"
          right={(
            <div className="flex items-center gap-0.5">
              {([2, 3, 4] as const).map((p) => (
                <Toggle
                  key={p}
                  on={poles === p}
                  label={`${p * 6}`}
                  title={`${p * 6} dB/oct — 네 단은 언제나 돕니다. 바뀌는 것은 출력을 어디서 뽑느냐입니다`}
                  onClick={() => set('poles', p)}
                />
              ))}
            </div>
          )}
        >
          <LadderView
            poles={poles} cutoffSemis={num('cutoff', 92)} res={num('res', 0.2)}
            compensation={num('fltComp', 0)}
            width={198} height={62}
          />
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('cutoff', 'CUTOFF')}
            {knob('res', 'RES')}
            {knob('drive', 'DRIVE')}
            {knob('fltKey', 'KEY TRK')}
            {knob('fltComp', 'BASS COMP')}
            {knob('envAmt', 'ENV AMT')}
            {knob('velFlt', 'VEL→FLT')}
            {knob('level', 'LEVEL')}
          </div>
        </Section>
      </div>

      <div className="flex gap-1.5 flex-wrap items-start">
        <Section title="MIXER · UNISON" width={214}>
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('subOct', 'SUB OCT')}
            {knob('subLevel', 'SUB')}
            {knob('noise', 'NOISE')}
            {knob('unison', 'UNISON')}
            {knob('detune', 'DETUNE')}
            {knob('spread', 'SPREAD')}
          </div>
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            SUB 는 VCO 1 아래의 사각파입니다. UNISON 은 한 음을 여러 오실레이터로 겹칩니다 —
            DETUNE 이 그 사이 간격, SPREAD 가 좌우 폭입니다
          </div>
        </Section>

        <Section title="ANALOGUE">
          <AnalogCharacterView
            drift={num('drift', 3.5)} tolerance={num('tolerance', 0.03)}
            voices={num('voices', 6)}
            width={260} height={84}
          />
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('drift', 'DRIFT')}
            {knob('tolerance', 'TOLERANCE')}
            {knob('voices', 'VOICES')}
            {knob('velAmp', 'VEL→AMP')}
          </div>
          {/* Said plainly because a synth that claims "analogue randomness"
              and then bounces differently every time is broken, not vintage. */}
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            DRIFT 는 VCO 가 떠도는 폭, TOLERANCE 는 보이스마다 부품이 다른 정도입니다.
            둘 다 난수가 아니라 음과 보이스에서 계산됩니다 — 같은 곡은 언제나 같게 바운스됩니다
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
          {tab === 'AMP ENV' && envTab(1)}
          {tab === 'FLT ENV' && envTab(2)}
          {tab.startsWith('LFO') && lfoTab(Number(tab.slice(4)))}
          {tab === 'ROUTING' && routingTab()}
        </div>
      </Section>
    </div>
  );
}
