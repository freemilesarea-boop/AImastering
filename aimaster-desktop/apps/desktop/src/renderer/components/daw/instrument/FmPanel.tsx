// The FM synth's own panel.
//
// Ninety-one parameters, and seventy-two of them are the same twelve repeated
// six times.  That shape decides the layout: one operator is shown at a time
// with six buttons to choose it, which is how every FM instrument has ever
// been laid out and is not a compromise — the six operators are identical in
// kind, so six copies of the same twelve knobs on screen at once would be a
// wall that teaches nothing.
//
// What the panel adds over the knob grid is the ALGORITHM.  Six boxes and the
// arrows between them is the only description of an FM patch that means
// anything; "algorithm 15" is a page reference.  Clicking a box selects that
// operator, so "that one is too bright" and the knob that fixes it are one
// click apart.
//
// And a spectrum, because six ratios and six levels genuinely do not tell
// anybody where the partials will land.  That is the difficulty of the
// instrument, not a failure of the person using it.

import React, { useCallback, useState } from 'react';
import Knob from '../plugin/Knob.js';
import { AlgorithmView, FmEnvView, FmSpectrumView, FmWaveView } from './FmCanvas.jsx';
import { FM_ALGORITHMS, algorithmAt } from '../../../daw/engine/fm-core.js';
import { FM_WAVE_NAMES, operatorHz } from '../../../daw/model/fm-views.js';
import { LFO_SHAPES } from '../../../daw/engine/mod-matrix.js';
import { findInstrument } from '../../../daw/engine/instruments.js';
import { premium } from '../../../theme/premium.js';

export interface FmPanelProps {
  params: Readonly<Record<string, number>>;
  /** Live, per movement. */
  onDrag: (id: string, value: number) => void;
  /** Once, on release — one undo step for the whole gesture. */
  onCommit: () => void;
}

/**
 * Every box on the panel, at a width it is given rather than one it takes.
 *
 * The rack row measures 671 px, measured in the running app.  330 + 6 + 331
 * comes to 667.  The spectrum box needs an explicit width for the same
 * reason: left to size itself it asked for the whole row and wrapped onto a
 * line of its own, which is what the first version did.
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

export default function FmPanel(
  { params, onDrag, onCommit }: FmPanelProps,
): React.ReactElement {
  const [op, setOp] = useState(1);
  const [tab, setTab] = useState<string>('PITCH');
  const descriptor = findInstrument('fm');

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

  const set = useCallback((id: string, v: number) => { onDrag(id, v); onCommit(); }, [onDrag, onCommit]);
  const num = (id: string, fallback: number): number => {
    const v = params[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  const algoIndex = Math.round(num('algo', 14));
  const alg = algorithmAt(algoIndex);
  const carriers = new Set(alg.carriers);
  const fixed = num(`o${op}fixed`, 0) > 0.5;
  const hz = operatorHz(261.63, num(`o${op}ratio`, 1), num(`o${op}fine`, 0), fixed, num(`o${op}hz`, 440));

  const modTab = (): React.ReactElement => {
    if (tab === 'PITCH') {
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1">
            {knob('pAmt', 'AMOUNT', 32)}
            {knob('pAtk', 'ATTACK', 32)}
            {knob('pDec', 'DECAY', 32)}
          </div>
          <span className="text-[8px] max-w-[300px] leading-tight" style={{ color: premium.text.faint }}>
            음 시작에서 음정이 훅 떨어지는 짧은 엔벨로프입니다 — FM 베이스의 클릭과
            브라스의 립 어택이 여기서 나옵니다. 0 이면 꺼져 있습니다
          </span>
        </div>
      );
    }
    if (tab === 'LFO') {
      const synced = num('lfoSync', 0) > 0.5;
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <Choice
              value={num('lfoShape', 0)} names={LFO_SHAPES}
              onPick={(v) => set('lfoShape', v)} width={92}
            />
            <Toggle
              on={synced} label={synced ? 'BPM' : 'FREE'}
              title={synced ? '박자에 묶여 있습니다' : '자유 주행 — RATE 가 헤르츠'}
              onClick={() => set('lfoSync', synced ? 0 : 1)}
            />
          </div>
          <div className="flex gap-1">
            {synced ? knob('lfoBeats', 'BEATS', 32) : knob('lfoRate', 'RATE', 32)}
            {knob('lfoDelay', 'DELAY', 32)}
            {knob('lfoPitch', '→ PITCH', 32)}
            {knob('lfoAmp', '→ AMP', 32)}
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex flex-wrap gap-x-0.5 gap-y-0">
          {knob('unison', 'UNISON')}
          {knob('detune', 'DETUNE')}
          {knob('width', 'WIDTH')}
          {knob('spread', 'SPREAD')}
          {knob('transpose', 'TRANSPOSE')}
          {knob('level', 'LEVEL')}
        </div>
        {/* Said plainly, because a knob that does nothing on most patches is
            worse than no knob unless it says when. */}
        <span className="text-[8px] max-w-[290px] leading-tight" style={{ color: premium.text.faint }}>
          SPREAD 는 캐리어를 좌우로 벌립니다 — 캐리어가 하나뿐인 알고리듬에서는 아무 일도
          하지 않습니다. WIDTH 는 유니즌 보이스를 벌리므로 UNISON 이 1 이면 마찬가지입니다
        </span>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="flex gap-1.5 flex-wrap items-start">
        <Section
          width={330}
          title="ALGORITHM"
          right={(
            <div className="flex items-center gap-1">
              <button
                className="hit-target h-5 w-4 rounded text-[9px]"
                style={{ color: premium.text.muted }}
                title="이전 알고리듬"
                onClick={() => set('algo', Math.max(0, algoIndex - 1))}
              >‹</button>
              <Choice
                value={algoIndex}
                names={FM_ALGORITHMS.map((a) => a.name)}
                title={alg.note}
                onPick={(v) => set('algo', v)}
                width={150}
              />
              <button
                className="hit-target h-5 w-4 rounded text-[9px]"
                style={{ color: premium.text.muted }}
                title="다음 알고리듬"
                onClick={() => set('algo', Math.min(FM_ALGORITHMS.length - 1, algoIndex + 1))}
              >›</button>
            </div>
          )}
        >
          <AlgorithmView
            algo={algoIndex}
            selected={op - 1}
            feedbackOp={Math.round(num('fbOp', 6)) - 1}
            feedback={num('feedback', 0)}
            onPick={(k) => setOp(k + 1)}
            width={314}
            height={132}
          />
          <div className="flex items-center gap-1 flex-wrap">
            {knob('feedback', 'FEEDBACK')}
            {knob('fbOp', 'FB OP')}
            <span className="text-[8px] flex-1 leading-tight" style={{ color: premium.text.faint }}>
              칠해진 상자가 캐리어 — 소리로 나가는 오퍼레이터입니다. 상자를 누르면 아래에서 편집합니다.
              {alg.note ? ` ${alg.note}` : ''}
            </span>
          </div>
        </Section>

        <Section title="SPECTRUM" width={331}>
          <FmSpectrumView params={params} width={315} height={132} />
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            지금 패치를 C4 로 실제 렌더해서 그린 스펙트럼입니다 — 배율 여섯 개와 레벨 여섯 개로는
            배음이 어디에 설지 알 수 없기 때문입니다. 노브를 놓을 때마다 다시 그립니다
          </div>
        </Section>
      </div>

      <Section
        title={`OPERATOR ${op}`}
        right={(
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                className="hit-target h-5 w-6 rounded text-[9px]"
                style={{
                  background: op === n ? premium.accent.deep : 'transparent',
                  color: op === n
                    ? premium.accent.light
                    : (carriers.has(n - 1) ? premium.accent.base : premium.text.muted),
                  border: `1px solid ${op === n ? premium.accent.deep : 'rgba(255,255,255,0.12)'}`,
                }}
                title={carriers.has(n - 1) ? '캐리어' : '모듈레이터'}
                onClick={() => setOp(n)}
              >{n}</button>
            ))}
          </div>
        )}
      >
        <div className="flex gap-2 flex-wrap items-start">
          <div className="flex flex-col gap-1">
            <FmWaveView wave={num(`o${op}wave`, 0)} width={150} height={44} />
            <Choice
              value={num(`o${op}wave`, 0)} names={FM_WAVE_NAMES}
              title="사인 외의 파형은 변조 전부터 배음을 가지고 있습니다 — 낮은 인덱스로 더 조밀한 소리를 냅니다"
              onPick={(v) => set(`o${op}wave`, v)} width={150}
            />
          </div>
          <div className="flex flex-col gap-1">
            <FmEnvView
              attack={num(`o${op}a`, 0.002)} decay={num(`o${op}d`, 1)}
              sustain={num(`o${op}s`, 0)} release={num(`o${op}r`, 0.4)}
              width={210} height={44}
            />
            <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
              {carriers.has(op - 1)
                ? `캐리어 — 이 엔벨로프가 음량입니다 · ${hz.toFixed(1)} Hz`
                : `모듈레이터 — 이 엔벨로프가 밝기입니다 · ${hz.toFixed(1)} Hz`}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-0.5 gap-y-0 flex-1">
            {knob(`o${op}ratio`, 'RATIO')}
            {knob(`o${op}fine`, 'FINE')}
            {knob(`o${op}level`, 'LEVEL')}
            {knob(`o${op}a`, 'ATK')}
            {knob(`o${op}d`, 'DEC')}
            {knob(`o${op}s`, 'SUS')}
            {knob(`o${op}r`, 'REL')}
            {knob(`o${op}vel`, 'VEL')}
            {knob(`o${op}key`, 'KEY')}
            {knob(`o${op}hz`, 'FIXED Hz')}
          </div>
          <div className="flex flex-col gap-1">
            <Toggle
              on={fixed} label={fixed ? 'FIXED' : 'RATIO'}
              title={fixed
                ? '고정 주파수 — 건반을 따라가지 않습니다. 포먼트와 금속성 어택에'
                : '음정의 배수 — 건반을 따라갑니다'}
              onClick={() => set(`o${op}fixed`, fixed ? 0 : 1)}
            />
          </div>
        </div>
      </Section>

      <Section title="MODULATION · VOICE">
        <div className="flex gap-0.5 flex-wrap">
          {['PITCH', 'LFO', 'VOICE'].map((t) => (
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
        <div className="pt-1">{modTab()}</div>
      </Section>
    </div>
  );
}
