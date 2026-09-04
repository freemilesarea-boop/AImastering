// ListEditor — every event as a row you can type into.
//
// This is the only place in the app where a value can be READ as a number and
// typed as a number.  The piano roll can move a note but not put it on 61
// rather than 60 without a steady hand, and a controller lane can be drawn
// but never read: there is no other way to find out that a bend point sits at
// 0.734 rather than 0.75.
//
// Editing is deliberately commit-on-blur-or-Enter rather than on every
// keystroke: a half-typed `1` on the way to `12` is a real number and would
// move the event to bar 1 before the second digit arrived.  Escape puts the
// cell back.

import React, { useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useMidiEditorStore } from '../../../stores/midiEditorStore.js';
import { findTrack, trackClips, updateClip } from '../../../daw/model/session-ops.js';
import { clipNotes, writeClipNotes } from '../../../daw/model/patterns.js';
import { secToBeat, tempoMapOf } from '../../../daw/model/tempo-map.js';
import {
  deleteRows, describeList, editRow, formatLength, formatPosition, formatValue,
  listRows, parseLength, parsePosition, parseValue, toggleRowMute,
  type EditableField, type EditResult, type EventKind, type ListInput, type ListRow,
} from '../../../daw/edit/list-events.js';
import { premium } from '../../../theme/premium.js';

const KIND_LABELS: Record<EventKind, string> = {
  note: '노트', expression: '노트 커브', lane: '파트 레인',
};

export default function ListEditor({ onClose }: { onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const open = useMidiEditorStore((s) => s.open);
  const selectedIds = useMidiEditorStore((s) => s.selectedNoteIds);
  const setSelection = useMidiEditorStore((s) => s.setSelection);

  const [kinds, setKinds] = useState<EventKind[]>(['note', 'expression', 'lane']);
  const [selectionOnly, setSelectionOnly] = useState(false);
  /** `rowId|field` while a cell is being typed into. */
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  /**
   * Set by Escape, read by the blur that Escape causes.
   *
   * A ref rather than state because the two happen in the same tick: clearing
   * `editing` in the Escape handler does not reach the blur handler's closure,
   * which still sees the old value and commits it.  An Escape that looks like
   * a cancel and is actually a commit is worse than no Escape at all.
   */
  const cancelled = useRef(false);

  const track = open ? findTrack(session, open.trackId) : undefined;
  const part = track ? trackClips(track).find((c) => c.id === open?.clipId) : undefined;

  const input: ListInput = useMemo(() => ({
    notes: part ? clipNotes(session, part) : [],
    lanes: part?.controllers ?? [],
  }), [session, part]);

  // Bar numbers belong to the SONG, so a part starting at bar 9 says 9.
  const { map, partStartBeat } = useMemo(() => {
    const m = tempoMapOf(session);
    return { map: m, partStartBeat: part ? secToBeat(m, part.startSec) : 0 };
  }, [session, part]);

  const rows = useMemo(() => listRows(input, {
    kinds,
    ...(selectionOnly && selectedIds.length > 0
      ? { noteIds: new Set(selectedIds) } : {}),
  }), [input, kinds, selectionOnly, selectedIds]);

  if (!open || !part) return null;

  const write = (next: EditResult): void => {
    apply((s) => {
      const withNotes = writeClipNotes(s, open.trackId, open.clipId, next.notes);
      return updateClip(withNotes, open.trackId, open.clipId,
        (c) => ({ ...c, controllers: next.lanes }));
    });
  };

  const commit = (row: ListRow, field: EditableField, text: string): void => {
    setEditing(null);
    const value = field === 'position' ? parsePosition(map, partStartBeat, text)
      : field === 'length' ? parseLength(text)
        : field === 'value' ? parseValue(row, text)
          : Number(text);
    // An unreadable cell leaves the event exactly where it was.  Half-typed
    // is normal, not exceptional.
    if (value === null || !Number.isFinite(value)) return;
    const result = editRow(input, row, field, value);
    if (result.changed) write(result);
  };

  const cell = (
    row: ListRow, field: EditableField, text: string, width: number,
  ): React.ReactNode => {
    const key = `${row.id}|${field}`;
    if (!row.editable.includes(field)) {
      return <span style={{ ...cellStyle, width, color: premium.text.faint }}>—</span>;
    }
    const active = editing?.key === key;
    return (
      <input
        value={active ? editing.text : text}
        onFocus={() => setEditing({ key, text })}
        onChange={(e) => setEditing({ key, text: e.target.value })}
        onBlur={() => {
          if (cancelled.current) { cancelled.current = false; setEditing(null); return; }
          if (active) commit(row, field, editing.text);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { cancelled.current = false; e.currentTarget.blur(); return; }
          // Escape puts the cell back rather than committing what is half
          // typed — the one way out of a mistake mid-edit.
          if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
          e.stopPropagation();
        }}
        style={{ ...cellStyle, width }}
      />
    );
  };

  return (
    <div className="absolute right-2 top-9 z-20 w-[560px] rounded border shadow-2xl"
         style={{
           background: premium.surface.panel, borderColor: premium.surface.hairline,
           fontFamily: premium.type.sans,
         }}>
      <div className="flex items-center gap-2 px-2 py-1 border-b"
           style={{ borderColor: premium.surface.hairline }}>
        <span className="text-[11px]" style={{ color: premium.text.primary }}>리스트 에디터</span>
        <span className="text-[9px]" style={{ color: premium.text.faint }}>
          {describeList(rows)}
        </span>
        <div className="flex-1" />
        {(Object.keys(KIND_LABELS) as EventKind[]).map((k) => (
          <button key={k}
            onClick={() => setKinds((v) => (v.includes(k)
              ? v.filter((x) => x !== k) : [...v, k]))}
            className={`h-5 px-1.5 rounded text-[9px] border ${kinds.includes(k)
              ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
              : 'bg-zinc-900 border-zinc-700 text-zinc-600'}`}>{KIND_LABELS[k]}</button>
        ))}
        <label className="flex items-center gap-1 text-[9px]" style={{ color: premium.text.faint }}>
          <input type="checkbox" checked={selectionOnly}
                 onChange={(e) => setSelectionOnly(e.target.checked)} />
          선택만
        </label>
        <button onClick={onClose}
                className="h-5 px-2 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">
          닫기
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 py-0.5 border-b text-[9px]"
           style={{ borderColor: premium.surface.hairline, color: premium.text.faint }}>
        <span style={{ width: 96 }}>위치 (마디|박|틱)</span>
        <span style={{ width: 118 }}>이벤트</span>
        <span style={{ width: 58 }}>길이</span>
        <span style={{ width: 46 }}>음정</span>
        <span style={{ width: 46 }}>벨로</span>
        <span style={{ width: 34 }}>채널</span>
        <span style={{ width: 56 }}>값</span>
        <span style={{ width: 24 }} />
      </div>

      <div className="max-h-[360px] overflow-y-auto">
        {rows.length === 0 && (
          <div className="px-2 py-3 text-[10px]" style={{ color: premium.text.faint }}>
            보여줄 이벤트가 없습니다
          </div>
        )}
        {rows.map((row) => {
          const isSelected = row.noteId !== undefined && selectedIds.includes(row.noteId);
          return (
            <div key={row.id}
                 onMouseDown={() => (row.noteId ? setSelection([row.noteId]) : undefined)}
                 className="flex items-center gap-1 px-2 py-0.5 border-b"
                 style={{
                   borderColor: 'rgba(255,255,255,0.04)',
                   background: isSelected ? 'rgba(90,150,240,0.12)' : undefined,
                   opacity: row.muted ? 0.45 : 1,
                 }}>
              {cell(row, 'position', formatPosition(map, partStartBeat, row.beat), 96)}
              <span className="text-[9.5px] truncate" style={{ width: 118, color: premium.text.secondary }}
                    title={row.label}>{row.label}</span>
              {cell(row, 'length', row.lengthBeat !== undefined ? formatLength(row.lengthBeat) : '', 58)}
              {cell(row, 'pitch', row.pitch !== undefined ? `${row.pitch}` : '', 46)}
              {cell(row, 'velocity', row.velocity !== undefined ? `${row.velocity}` : '', 46)}
              {cell(row, 'channel', row.channel !== undefined ? `${row.channel + 1}` : '', 34)}
              {cell(row, 'value', formatValue(row), 56)}
              <button
                title={row.kind === 'note' ? '음소거' : '이 포인트 지우기'}
                onClick={() => {
                  const result = row.kind === 'note'
                    ? toggleRowMute(input, row) : deleteRows(input, [row]);
                  if (result.changed) write(result);
                }}
                style={{
                  width: 20, height: 16, borderRadius: 2, fontSize: 8,
                  background: premium.surface.well,
                  color: row.muted ? premium.accent.danger : premium.text.faint,
                  border: `1px solid ${premium.surface.hairline}`,
                }}
              >{row.kind === 'note' ? 'M' : '×'}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  height: 17, borderRadius: 2, textAlign: 'center',
  background: premium.surface.well, color: premium.text.primary,
  border: `1px solid ${premium.surface.hairline}`,
  fontFamily: premium.type.mono, fontSize: 9.5, padding: '0 2px',
};
