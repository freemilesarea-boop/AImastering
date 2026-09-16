// The bowed string's own panel.
//
// The layout follows the instrument rather than the parameter list: what a
// player controls is the BOW, then the string under it, then the box it is
// heard through — so that is the order, and the bow gets the big picture
// because the bow is the instrument.
//
// The pictures answer the question two knobs cannot.  Bow Force and Bow
// Position are numbers with no obvious meaning and a narrow window of good
// values; the cycle shows whether the string is in that window and the
// spectrum shows what the position is doing to the tone.  Both are measured
// from the engine, on the note the picture says it is of.

import React, { useCallback, useState } from 'react';
import Knob from '../plugin/Knob.js';
import { BodyView, CycleView, REGIME_LABEL, REGIME_NOTE, SpectrumView } from './BowedCanvas.jsx';
import { bowAnalysis, bodyOf, betaOf, stringRows } from '../../../daw/model/bowed-views.js';
import { findInstrument } from '../../../daw/engine/instruments.js';
import { premium } from '../../../theme/premium.js';

export interface BowedPanelProps {
  params: Readonly<Record<string, number>>;
  /** Live, per movement. */
  onDrag: (id: string, value: number) => void;
  /** Once, on release — one undo step for the whole gesture. */
  onCommit: () => void;
}

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

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const spell = (pitch: number): string =>
  `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

export default function BowedPanel(
  { params, onDrag, onCommit }: BowedPanelProps,
): React.ReactElement {
  // Which note the pictures are OF.
  //
  // They have to be of something: a stick-slip cycle is a cycle of one note,
  // and the bow's fraction of the string — which decides the comb and the
  // length of the stick — changes as the note goes up, because the arm does
  // not move.  So the panel says which note rather than drawing an average
  // of none.  It rests on the third string, which is the middle of the
  // instrument, and follows the body when that changes.
  const body = bodyOf(params);
  const [offset, setOffset] = useState(2);
  const strings = body.strings;
  const pitch = offset < strings.length
    ? (strings[offset] ?? strings[0] ?? 55)
    : (strings[strings.length - 1] ?? 76) + 12;

  const descriptor = findInstrument('bowed');
  const knob = useCallback((id: string, label?: string, size = 30) => {
    const def = descriptor?.params.find((d) => d.id === id);
    if (!def) return null;
    const time = def.unit === 's';
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

  // One render for both pictures and the badge — see `bowAnalysis`.  Three
  // calls would be three renders of the same note, and two of them could
  // disagree with the third.
  const { cycle, spectrum } = bowAnalysis(params, pitch, 330);
  const beta = betaOf(params, pitch);
  const rows = stringRows(params, pitch);

  return (
    <div className="flex flex-col gap-2 mt-2">
      {/* Which instrument, and which note the pictures are of. */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] tracking-widest" style={{ color: premium.accent.light }}>
          {body.name.toUpperCase()}
        </span>
        <div className="flex gap-0.5">
          {rows.map((r, i) => (
            <button
              key={r.open}
              onClick={() => setOffset(i)}
              title={`${r.name} 개방현`}
              className="hit-target h-5 px-1.5 rounded text-[9px]"
              style={{
                background: offset === i ? premium.accent.deep : 'transparent',
                color: offset === i ? premium.accent.light : premium.text.muted,
                border: `1px solid ${offset === i ? premium.accent.deep : 'rgba(255,255,255,0.12)'}`,
              }}
            >{r.name}</button>
          ))}
          <button
            onClick={() => setOffset(strings.length)}
            title="가장 높은 줄의 한 옥타브 위 — 활이 그대로면 줄만 짧아집니다"
            className="hit-target h-5 px-1.5 rounded text-[9px]"
            style={{
              background: offset >= strings.length ? premium.accent.deep : 'transparent',
              color: offset >= strings.length ? premium.accent.light : premium.text.muted,
              border: `1px solid ${offset >= strings.length ? premium.accent.deep : 'rgba(255,255,255,0.12)'}`,
            }}
          >{spell((strings[strings.length - 1] ?? 76) + 12)}</button>
        </div>
        <span className="text-[9px]" style={{ color: premium.text.faint }}>
          β = {(beta * 100).toFixed(1)}%
          {offset >= strings.length ? ' — 짚어 올라가면 활이 상대적으로 브리지에 가까워집니다' : ''}
        </span>
      </div>

      <Section
        title="BOW"
        right={(
          <span
            className="text-[9px] px-1.5 rounded"
            style={{
              color: cycle.regime === 'helmholtz' ? premium.accent.light : '#e1967a',
              border: `1px solid ${cycle.regime === 'helmholtz'
                ? premium.accent.deep : 'rgba(225,150,120,0.5)'}`,
            }}
          >{REGIME_LABEL[cycle.regime]}</span>
        )}
      >
        <div className="flex gap-2 items-start flex-wrap">
          <CycleView cycle={cycle} width={330} height={90} />
          <div className="flex flex-wrap gap-x-0.5 gap-y-0 flex-1">
            {knob('speed', 'BOW SPD')}
            {knob('force', 'BOW FRC')}
            {knob('pos', 'BOW POS')}
            {knob('hair', 'HAIR')}
            {knob('attack', 'ATTACK')}
            {knob('release', 'RELEASE')}
          </div>
        </div>
        <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
          {REGIME_NOTE[cycle.regime]} · 붙어 있는 구간 {(cycle.stuck * 100).toFixed(0)}%
          {' '}(헬름홀츠라면 {(cycle.idealStuck * 100).toFixed(0)}%)
          {/* The release count is a reading of the drawn cycle; the badge is
              the verdict, and it comes from the spectrum — which is the
              measurement that was shown to separate the regimes and the count
              is not (see `bowAnalysis`).  Where they disagree the note is
              borderline, and printing "Helmholtz · released twice" side by
              side reads as the panel contradicting itself.  So the count is
              shown when it is telling the user something the badge is not. */}
          {cycle.releases > 1 && cycle.regime !== 'helmholtz'
            ? ` · 한 주기에 ${cycle.releases}번 놓침` : ''}
        </div>
        <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
          BOW SPD 가 음량입니다. BOW FRC 는 음량이 아니라 위 세 상태 중 어디에 있는지를
          정합니다 — 실제 악기가 그렇고, 그래서 한 활 안에서 크레셴도가 됩니다
        </div>
      </Section>

      <div className="flex gap-1.5 flex-wrap items-start">
        <Section title="STRING">
          <div className="flex gap-2 items-start flex-wrap">
            <SpectrumView spec={spectrum} width={280} height={84} />
            <div className="flex flex-wrap gap-x-0.5 gap-y-0 flex-1">
              {knob('bright', 'BRIGHT')}
              {knob('sustainRing', 'RING')}
            </div>
          </div>
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            활이 놓는 지점이 그 배음의 마디라서 h{Math.round(1 / beta)} 이 파입니다 —
            EQ 가 아니라 빗살이고, 활을 브리지 쪽으로 옮기면 파이는 자리가 위로 올라갑니다
          </div>
          <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
            BRIGHT 는 이 그림의 아래쪽을 거의 못 건드립니다 — 활이 매 주기 모서리를 다시
            넣어서, 줄을 아무리 죽여도 낮은 배음은 그대로입니다 (측정: 2~6 배음이 노브
            전 구간에서 0.6 dB). 실제로 듣는 차이는 활이 떠난 뒤의 여운이고, 약음기가
            줄이 아니라 브리지에 붙는 이유도 이것입니다
          </div>
        </Section>

        <Section title="BODY" width={330}>
          <BodyView params={params} width={314} height={84} />
          <div className="flex flex-wrap gap-x-0.5 gap-y-0">
            {knob('bodyAmt', 'BODY')}
            {knob('size', 'SIZE')}
            {knob('width', 'WIDTH')}
            {knob('level', 'LEVEL')}
          </div>
        </Section>
      </div>

      <Section title="VIBRATO" width={330}>
        <div className="flex flex-wrap gap-x-0.5 gap-y-0">
          {knob('vibRate', 'RATE')}
          {knob('vibDepth', 'DEPTH')}
          {knob('vibDelay', 'DELAY')}
        </div>
        <div className="text-[8px] leading-tight" style={{ color: premium.text.faint }}>
          손가락이 줄 위에서 흔들리는 것이라 길이가 바뀝니다. 같이 들리는 음량 떨림은
          따로 넣은 효과가 아니라 배음이 몸통의 공명을 타넘는 것입니다 — BODY 를 내리면
          같이 줄어듭니다
        </div>
      </Section>
    </div>
  );
}
