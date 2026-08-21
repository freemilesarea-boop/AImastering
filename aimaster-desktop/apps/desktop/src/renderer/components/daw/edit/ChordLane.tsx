// The chord lane — typing the progression.
//
// The chord track has been readable data for a while (the Riff Machine and the
// scale assistant both use it) and completely untouchable: detection from a
// MIDI part was the only way to get one, and a chord the detector read wrong
// stayed wrong.
//
// The interaction is deliberately a TEXT BOX, not a root × quality picker.
// "Cmaj7" is 12 × N clicks in a picker and five keystrokes here, every
// musician already knows the spelling, and `parseChord` is strict enough that
// a typo comes back as a sentence instead of a silent wrong chord.
//
// Like the arrangement lane above it, a chord stores only where it STARTS —
// what is sounding at 1:12 is the last change at or before it — so gaps and
// overlaps are not representable and dragging a boundary is one edit.

import React, { useCallback, useRef, useState } from 'react';
import { snapToGrid, useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import {
  addChord, chordGrid, chordRanges, moveChord, parseChordInput, removeChord,
  setChord, sortedChords, transposeChords, withChords,
} from '../../../daw/edit/chord-edit.js';
import { formatChord, makeChord } from '../../../daw/model/chords.js';
import { songEnd } from '../../../daw/edit/arrange-ops.js';
import { barSeconds } from '../../../daw/edit/chord-detect.js';
import { premium } from '../../../theme/premium.js';

export const CHORD_LANE_HEIGHT = 24;

interface Viewport { scrollSec: number; pxPerSec: number; width: number }

export function ChordLaneHeader() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const notify = useAppStore((s) => s.notify);

  const addHere = (): void => {
    const at = snapToGrid(playheadSec);
    const result = addChord(sortedChords(session), at, makeChord(0));
    if (!result.ok) { notify(result.reason, 'warning'); return; }
    apply((s) => withChords(s, result.events));
  };

  /** Four bars of C, so a songwriter types over a skeleton. */
  const seed = (): void => {
    if (sortedChords(session).length > 0) {
      notify('이미 코드가 있습니다 — 빈 진행은 비어 있을 때만 만듭니다', 'warning');
      return;
    }
    const bar = barSeconds(session.tempoBpm, session.timeSignature[0]);
    apply((s) => withChords(s, chordGrid(0, bar, 8)));
    notify('8마디 뼈대를 만들었습니다 — 블록을 더블클릭해서 코드를 쓰세요');
  };

  return (
    <div
      className="flex items-center gap-1 px-2 border-b border-zinc-800"
      style={{ height: CHORD_LANE_HEIGHT, background: '#14141c' }}
    >
      <span className="text-[9px] tracking-wide flex-1" style={{ color: premium.text.faint }}>
        코드
      </span>
      <button onClick={seed} title="8마디 뼈대 만들기"
              className="h-4 px-1 rounded text-[8px] leading-none border"
              style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}>8마디</button>
      <button onClick={addHere} title="재생헤드에 코드를 추가합니다"
              className="w-5 h-4 rounded text-[10px] leading-none border"
              style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}>+</button>
    </div>
  );
}

export default function ChordLane({ viewport }: { viewport: Viewport }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit = useDawStore((s) => s.commitEdit);
  const seek = useDawStore((s) => s.seek);
  const notify = useAppStore((s) => s.notify);

  const boxRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const { scrollSec, pxPerSec, width } = viewport;
  const events = sortedChords(session);
  const ranges = chordRanges(events, Math.max(songEnd(session), scrollSec + width / pxPerSec));

  const secAt = useCallback((clientX: number): number => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return Math.max(0, scrollSec + (clientX - box.left) / pxPerSec);
  }, [scrollSec, pxPerSec]);

  const commitText = (id: string, text: string): void => {
    const parsed = parseChordInput(text);
    setEditing(null);
    if (!parsed.ok) { if (parsed.reason) notify(parsed.reason, 'warning'); return; }
    apply((s) => withChords(s, setChord(sortedChords(s), id, parsed.chord)));
  };

  const onBoundaryDown = (e: React.PointerEvent, id: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(id);
    const move = (ev: PointerEvent): void => {
      const at = snapToGrid(secAt(ev.clientX));
      applyTransient((s) => withChords(s, moveChord(sortedChords(s), id, at)));
    };
    const up = (): void => {
      setDragging(null);
      commitEdit();
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={boxRef}
      className="relative border-b border-zinc-800 select-none"
      style={{ height: CHORD_LANE_HEIGHT, width, background: '#0C0C12' }}
    >
      {ranges.map((range) => {
        const left = (range.startSec - scrollSec) * pxPerSec;
        const w = (range.endSec - range.startSec) * pxPerSec;
        if (left + w < -40 || left > width + 40) return null;
        return (
          <div
            key={range.event.id}
            className="absolute top-0 bottom-0 flex items-center gap-1 px-1.5 overflow-hidden group"
            style={{
              left, width: Math.max(2, w),
              background: 'rgba(122,106,168,0.16)',
              borderLeft: '2px solid rgba(150,130,200,0.7)',
            }}
            onClick={() => seek(range.startSec)}
            title={`${formatChord(range.event.chord)} — 더블클릭해서 고쳐 쓰세요`}
          >
            {editing === range.event.id ? (
              <input
                autoFocus
                defaultValue={formatChord(range.event.chord)}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => commitText(range.event.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
                className="h-4 px-1 text-[9.5px] rounded bg-transparent outline-none"
                style={{ color: premium.text.primary, border: '1px solid rgba(150,130,200,0.7)', width: 74 }}
              />
            ) : (
              <span
                className="text-[10px] truncate"
                style={{ color: premium.text.secondary, fontFamily: premium.type.mono }}
                onDoubleClick={(e) => { e.stopPropagation(); setEditing(range.event.id); }}
              >{formatChord(range.event.chord)}</span>
            )}

            {w > 96 && (
              <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button onClick={(e) => {
                  e.stopPropagation();
                  apply((s) => withChords(s,
                    transposeChords(sortedChords(s), 1, new Set([range.event.id]))));
                }} title="반음 위" style={laneChip()}>♯</button>
                <button onClick={(e) => {
                  e.stopPropagation();
                  apply((s) => withChords(s,
                    transposeChords(sortedChords(s), -1, new Set([range.event.id]))));
                }} title="반음 아래" style={laneChip()}>♭</button>
                <button onClick={(e) => {
                  e.stopPropagation();
                  apply((s) => withChords(s, removeChord(sortedChords(s), range.event.id)));
                }} title="지우기" style={laneChip(premium.accent.danger)}>×</button>
              </span>
            )}

            {range.startSec > 0.01 && (
              <div
                onPointerDown={(e) => onBoundaryDown(e, range.event.id)}
                title="코드 위치 끌기"
                className="absolute left-0 top-0 bottom-0"
                style={{
                  width: 6, marginLeft: -3, cursor: 'col-resize',
                  background: dragging === range.event.id ? 'rgba(150,130,200,0.7)' : 'transparent',
                }}
              />
            )}
          </div>
        );
      })}

      {ranges.length === 0 && (
        <span className="absolute left-2 top-0.5 text-[9.5px]" style={{ color: premium.text.faint }}>
          코드 없음 — + 로 하나 넣거나 8마디 뼈대를 만드세요
        </span>
      )}
    </div>
  );
}

function laneChip(color: string = premium.text.muted): React.CSSProperties {
  return {
    height: 13, padding: '0 3px', borderRadius: 2, fontSize: 8,
    color, background: 'transparent', border: '1px solid rgba(255,255,255,0.14)',
  };
}
