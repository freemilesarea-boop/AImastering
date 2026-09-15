// MidiInsertRack — the chain between the keyboard and the instrument.
//
// Order is the point of the panel, so it reads top to bottom and the arrows
// are the primary control: a chorder above an arpeggiator arpeggiates the
// chord, below it harmonises every step, and both are things people want.
//
// The header line says whether the chain is running LIVE — the inserts that
// one key press can answer on its own act immediately, and the arpeggiator
// takes over the keyboard's timing.  Saying which is which is the difference
// between "the arp is broken" and "the arp is after the split".

import React from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { updateTrack } from '../../../daw/model/session-ops.js';
import {
  INSERT_LABELS, MAX_MIDI_INSERTS, defaultInsert, describeChain, describeInsert,
  isStatelessInsert, timedInsert,
  type ArpeggiatorInsert, type ChorderInsert, type EchoInsert, type MidiInsert,
  type MidiInsertKind, type RangeInsert, type TransposeInsert, type VelocityInsert,
} from '../../../daw/model/midi-insert.js';
import { midiInsertsOf, setMidiInserts } from '../../../daw/model/midi-insert-track.js';
import { premium } from '../../../theme/premium.js';

const KINDS = Object.keys(INSERT_LABELS) as MidiInsertKind[];
const RATES: { label: string; beats: number }[] = [
  { label: '1/4', beats: 1 }, { label: '1/8', beats: 0.5 }, { label: '1/8T', beats: 1 / 3 },
  { label: '1/16', beats: 0.25 }, { label: '1/16T', beats: 1 / 6 }, { label: '1/32', beats: 0.125 },
];
const CHORD_PRESETS: { label: string; intervals: number[] }[] = [
  { label: '메이저', intervals: [0, 4, 7] },
  { label: '마이너', intervals: [0, 3, 7] },
  { label: '5도', intervals: [0, 7] },
  { label: '옥타브', intervals: [0, 12] },
  { label: 'sus4', intervals: [0, 5, 7] },
  { label: '7th', intervals: [0, 4, 7, 10] },
];

export default function MidiInsertRack(
  { trackId, onClose }: { trackId: string; onClose: () => void },
) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const track = session.tracks.find((t) => t.id === trackId);
  const chain = midiInsertsOf(track);
  const timed = timedInsert(chain);

  const write = (next: MidiInsert[]): void => {
    apply((s) => updateTrack(s, trackId, (t) => setMidiInserts(t, next)));
  };
  const patch = (id: string, over: Record<string, unknown>): void => {
    write(chain.map((i) => (i.id === id ? { ...i, ...over } as MidiInsert : i)));
  };
  const move = (index: number, delta: number): void => {
    const to = index + delta;
    if (to < 0 || to >= chain.length) return;
    const next = chain.slice();
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved as MidiInsert);
    write(next);
  };

  return (
    <div className="absolute right-2 top-9 z-20 w-[440px] rounded border shadow-2xl"
         style={{
           background: premium.surface.panel, borderColor: premium.surface.hairline,
           fontFamily: premium.type.sans,
         }}>
      <div className="flex items-center gap-2 px-2 py-1 border-b"
           style={{ borderColor: premium.surface.hairline }}>
        <span className="text-[11px]" style={{ color: premium.text.primary }}>MIDI 인서트</span>
        <span className="text-[9px] truncate" style={{ color: premium.text.faint, maxWidth: 190 }}
              title={describeChain(chain)}>{describeChain(chain)}</span>
        <div className="flex-1" />
        <select
          value=""
          onChange={(e) => {
            const kind = e.target.value as MidiInsertKind;
            if (!kind || chain.length >= MAX_MIDI_INSERTS) return;
            write([...chain, defaultInsert(kind, `mi-${Date.now()}-${chain.length}`)]);
          }}
          className="h-5 rounded bg-zinc-900 border border-zinc-700 text-[10px] px-1 text-zinc-300"
        >
          <option value="">+ 인서트…</option>
          {KINDS.map((k) => <option key={k} value={k}>{INSERT_LABELS[k]}</option>)}
        </select>
        <button onClick={onClose}
                className="h-5 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">
          닫기
        </button>
      </div>

      {/* What happens when you actually play, spelled out.  "The arp does
          nothing" is almost always "the arp is behind a split". */}
      <div className="px-2 py-1 text-[9px] border-b leading-relaxed"
           style={{ borderColor: premium.surface.hairline, color: premium.text.faint }}>
        {timed
          ? `건반을 누르면 ${INSERT_LABELS[timed.kind]} 가 타이밍을 가져갑니다 — 그 위의 인서트는 누른 키에, 아래 인서트는 나온 스텝에 걸립니다.`
          : '건반을 누르면 이 체인이 그 자리에서 걸립니다. 재생할 때도 같은 체인을 지나갑니다.'}
      </div>

      <div className="max-h-[380px] overflow-y-auto">
        {chain.length === 0 && (
          <div className="px-2 py-3 text-[10px]" style={{ color: premium.text.faint }}>
            인서트가 없습니다 — 파트는 쓰인 그대로 연주됩니다
          </div>
        )}
        {chain.map((insert, index) => (
          <div key={insert.id} className="border-b px-2 py-1"
               style={{
                 borderColor: 'rgba(255,255,255,0.04)',
                 opacity: insert.bypass ? 0.45 : 1,
                 // The timed insert is where the keyboard's timing changes
                 // hands, so it is marked rather than left to be inferred.
                 background: timed?.id === insert.id ? 'rgba(120,140,255,0.07)' : undefined,
               }}>
            <div className="flex items-center gap-1 mb-1">
              <span className="text-[9px] w-3" style={{ color: premium.text.faint }}>{index + 1}</span>
              <span className="text-[10px]" style={{ color: premium.text.primary }}>
                {INSERT_LABELS[insert.kind]}
              </span>
              {!isStatelessInsert(insert) && !insert.bypass && (
                <span className="text-[8px] px-1 rounded"
                      style={{ background: 'rgba(120,140,255,0.2)', color: '#aab4ff' }}
                      title="이 인서트는 자기 클럭을 돌립니다">클럭</span>
              )}
              <div className="flex-1" />
              <button style={miniStyle} onClick={() => move(index, -1)} title="위로">▲</button>
              <button style={miniStyle} onClick={() => move(index, 1)} title="아래로">▼</button>
              <button
                style={{
                  ...miniStyle,
                  color: insert.bypass ? premium.text.faint : premium.accent.good,
                }}
                title="끄면 설정은 남고 체인에서만 빠집니다"
                onClick={() => patch(insert.id, { bypass: !insert.bypass })}
              >{insert.bypass ? 'OFF' : 'ON'}</button>
              <button style={miniStyle} title="삭제"
                      onClick={() => write(chain.filter((i) => i.id !== insert.id))}>×</button>
            </div>

            <div className="flex items-center gap-1 flex-wrap pl-4">
              {insert.kind === 'transpose' && (
                <Field label="반음">
                  <input type="number" min={-48} max={48} style={numStyle}
                         value={(insert as TransposeInsert).semitones}
                         onChange={(e) => patch(insert.id, { semitones: Number(e.target.value) })} />
                </Field>
              )}

              {insert.kind === 'velocity' && (
                <>
                  <Field label="배율">
                    <input type="number" step="0.05" min={0} max={4} style={numStyle}
                           value={(insert as VelocityInsert).scale}
                           onChange={(e) => patch(insert.id, { scale: Number(e.target.value) })} />
                  </Field>
                  <Field label="가감">
                    <input type="number" min={-127} max={127} style={numStyle}
                           value={(insert as VelocityInsert).offset}
                           onChange={(e) => patch(insert.id, { offset: Number(e.target.value) })} />
                  </Field>
                  <Field label="고정">
                    <input type="number" min={1} max={127} style={numStyle}
                           placeholder="—"
                           value={(insert as VelocityInsert).fixed ?? ''}
                           onChange={(e) => {
                             const raw = e.target.value;
                             if (raw === '') {
                               // Removed, not set to undefined — see the same
                               // rule in the drum map's clearSlotField.
                               const { fixed: _drop, ...rest } = insert as VelocityInsert & { id: string };
                               write(chain.map((i) => (i.id === insert.id ? rest as MidiInsert : i)));
                               return;
                             }
                             patch(insert.id, { fixed: Number(raw) });
                           }} />
                  </Field>
                </>
              )}

              {insert.kind === 'range' && (
                <>
                  <Field label="아래">
                    <input type="number" min={0} max={127} style={numStyle}
                           value={(insert as RangeInsert).lowPitch}
                           onChange={(e) => patch(insert.id, { lowPitch: Number(e.target.value) })} />
                  </Field>
                  <Field label="위">
                    <input type="number" min={0} max={127} style={numStyle}
                           value={(insert as RangeInsert).highPitch}
                           onChange={(e) => patch(insert.id, { highPitch: Number(e.target.value) })} />
                  </Field>
                  <select style={{ ...ctlStyle, width: 76 }}
                          value={(insert as RangeInsert).mode}
                          onChange={(e) => patch(insert.id, { mode: e.target.value })}>
                    <option value="fold">옥타브로 접기</option>
                    <option value="drop">밖은 자르기</option>
                  </select>
                </>
              )}

              {insert.kind === 'chorder' && (
                <>
                  <select style={{ ...ctlStyle, width: 76 }} value=""
                          onChange={(e) => {
                            const found = CHORD_PRESETS.find((c) => c.label === e.target.value);
                            if (found) patch(insert.id, { intervals: found.intervals });
                          }}>
                    <option value="">코드…</option>
                    {CHORD_PRESETS.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}
                  </select>
                  <Field label="간격">
                    <input style={{ ...numStyle, width: 96, textAlign: 'left' }}
                           value={(insert as ChorderInsert).intervals.join(', ')}
                           title="누른 음 기준 반음 간격. 0 은 원음"
                           onChange={(e) => patch(insert.id, {
                             intervals: e.target.value.split(/[,\s]+/)
                               .map((v) => Number(v)).filter((v) => Number.isFinite(v)),
                           })} />
                  </Field>
                  <Field label="추가음">
                    <input type="number" step="0.05" min={0} max={1} style={numStyle}
                           value={(insert as ChorderInsert).addedLevel ?? 1}
                           onChange={(e) => patch(insert.id, { addedLevel: Number(e.target.value) })} />
                  </Field>
                </>
              )}

              {insert.kind === 'arpeggiator' && (
                <>
                  <select style={{ ...ctlStyle, width: 68 }}
                          value={(insert as ArpeggiatorInsert).direction}
                          onChange={(e) => patch(insert.id, { direction: e.target.value })}>
                    <option value="up">올라감</option>
                    <option value="down">내려감</option>
                    <option value="updown">위아래</option>
                    <option value="random">랜덤</option>
                    <option value="chord">코드</option>
                  </select>
                  <select style={{ ...ctlStyle, width: 58 }}
                          value={RATES.find((r) => Math.abs(r.beats - (insert as ArpeggiatorInsert).rateBeat) < 1e-6)?.label ?? '1/16'}
                          onChange={(e) => patch(insert.id, {
                            rateBeat: RATES.find((r) => r.label === e.target.value)?.beats ?? 0.25,
                          })}>
                    {RATES.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
                  </select>
                  <Field label="게이트">
                    <input type="number" step="0.05" min={0.05} max={1} style={numStyle}
                           value={(insert as ArpeggiatorInsert).gate}
                           onChange={(e) => patch(insert.id, { gate: Number(e.target.value) })} />
                  </Field>
                  <Field label="옥타브">
                    <input type="number" min={1} max={4} style={numStyle}
                           value={(insert as ArpeggiatorInsert).octaves}
                           onChange={(e) => patch(insert.id, { octaves: Number(e.target.value) })} />
                  </Field>
                </>
              )}

              {insert.kind === 'echo' && (
                <>
                  <Field label="간격">
                    <input type="number" step="0.05" min={0.03} max={4} style={numStyle}
                           value={(insert as EchoInsert).delayBeat}
                           onChange={(e) => patch(insert.id, { delayBeat: Number(e.target.value) })} />
                  </Field>
                  <Field label="횟수">
                    <input type="number" min={0} max={16} style={numStyle}
                           value={(insert as EchoInsert).repeats}
                           onChange={(e) => patch(insert.id, { repeats: Number(e.target.value) })} />
                  </Field>
                  <Field label="감쇠">
                    <input type="number" step="0.05" min={0} max={1} style={numStyle}
                           value={(insert as EchoInsert).feedback}
                           onChange={(e) => patch(insert.id, { feedback: Number(e.target.value) })} />
                  </Field>
                  <Field label="반음/회">
                    <input type="number" min={-24} max={24} style={numStyle}
                           value={(insert as EchoInsert).pitchStep}
                           onChange={(e) => patch(insert.id, { pitchStep: Number(e.target.value) })} />
                  </Field>
                </>
              )}
            </div>
            <div className="text-[8.5px] pl-4 pt-0.5" style={{ color: premium.text.faint }}>
              {describeInsert(insert)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1"
           style={{ fontSize: 8.5, color: premium.text.faint }}>
      {label}{children}
    </label>
  );
}

const ctlStyle: React.CSSProperties = {
  height: 18, borderRadius: 3, fontSize: 9.5,
  background: premium.surface.well, color: premium.text.secondary,
  border: `1px solid ${premium.surface.hairline}`, padding: '0 2px',
};

const numStyle: React.CSSProperties = {
  ...ctlStyle, width: 48, textAlign: 'center',
  fontFamily: premium.type.mono, color: premium.text.primary,
};

const miniStyle: React.CSSProperties = {
  height: 16, minWidth: 16, padding: '0 4px', borderRadius: 2, fontSize: 8,
  background: premium.surface.well, color: premium.text.faint,
  border: `1px solid ${premium.surface.hairline}`,
};
