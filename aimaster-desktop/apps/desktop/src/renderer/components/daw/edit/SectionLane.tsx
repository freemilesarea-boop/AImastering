// The arrangement lane — the shape of the song, above everything else.
//
// It is a strip of coloured blocks, not a row of flags, because a section IS a
// range and drawing it as a point loses the one thing you look at the lane
// for: how long the chorus is compared to the verse.
//
// Two gestures, and nothing else:
//   click a block   select its range across every track (and locate there)
//   drag a boundary move it, which moves BOTH neighbours — that is what
//                   dragging the line between two sections means
//
// The operations that move audio (duplicate, delete-with-time) are buttons on
// the block rather than drag gestures: a ripple edit changes the length of the
// song, and that should never be one slip of the mouse away.

import React, { useCallback, useRef, useState } from 'react';
import { snapToGrid, useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import {
  MIN_SECTION_SEC, SECTION_KINDS, addSection, createSection, describeRange, kindColor,
  moveSectionStart, removeSectionMarker, renameSection, sectionLabel, sectionRanges,
  sectionsOf, setSectionKind, withSections,
  type SectionKind,
} from '../../../daw/model/arrangement.js';
import {
  deleteSectionTime, describeOrder, duplicateSection, nudgeSection,
  selectionForSection, songEnd,
} from '../../../daw/edit/arrange-ops.js';
import { premium } from '../../../theme/premium.js';

export const SECTION_LANE_HEIGHT = 26;

interface Viewport { scrollSec: number; pxPerSec: number; width: number }

export function SectionLaneHeader() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const notify = useAppStore((s) => s.notify);

  const addHere = (): void => {
    const at = snapToGrid(playheadSec);
    const result = addSection(sectionsOf(session), createSection('verse', at));
    if (!result.ok) { notify(result.reason, 'warning'); return; }
    apply((s) => withSections(s, result.sections));
  };

  return (
    <div
      className="flex items-center gap-1 px-2 border-b border-zinc-800"
      style={{ height: SECTION_LANE_HEIGHT, background: '#14141c' }}
    >
      <span className="text-[9px] tracking-wide flex-1" style={{ color: premium.text.faint }}>
        구간
      </span>
      <button
        onClick={addHere}
        title="재생헤드에 구간 경계를 추가합니다"
        className="w-5 h-4 rounded text-[10px] leading-none border"
        style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
      >+</button>
    </div>
  );
}

export default function SectionLane({ viewport }: { viewport: Viewport }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit = useDawStore((s) => s.commitEdit);
  const seek = useDawStore((s) => s.seek);
  const setSelection = useDawStore((s) => s.setSelection);
  const notify = useAppStore((s) => s.notify);

  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const { scrollSec, pxPerSec, width } = viewport;
  const sections = sectionsOf(session);
  const ranges = sectionRanges(sections, Math.max(songEnd(session), scrollSec + width / pxPerSec));

  const secAt = useCallback((clientX: number): number => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return 0;
    return Math.max(0, scrollSec + (clientX - box.left) / pxPerSec);
  }, [scrollSec, pxPerSec]);

  const onBoundaryDown = (e: React.PointerEvent, sectionId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(sectionId);
    const move = (ev: PointerEvent): void => {
      const at = snapToGrid(secAt(ev.clientX));
      applyTransient((s) => withSections(s, moveSectionStart(sectionsOf(s), sectionId, at)));
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

  const selectSection = (sectionId: string, startSec: number): void => {
    const selection = selectionForSection(session, sectionId);
    if (selection) setSelection(selection);
    seek(startSec);
  };

  const runRipple = (
    sectionId: string,
    op: typeof duplicateSection,
    what: string,
  ): void => {
    // The ripple runs once, on the store's own session, and its complaints are
    // shown — a ripple that quietly left the meter map behind is exactly the
    // kind of thing that is discovered three edits later.
    let problems: string[] = [];
    apply((s) => {
      const result = op(s, sectionId);
      problems = result.problems;
      return result.session;
    });
    if (problems.length > 0) for (const p of problems.slice(0, 2)) notify(p, 'warning');
    else notify(what);
  };

  /**
   * Move a section one place along the running order.
   *
   * The new order is read back in the toast: a reorder is invisible until the
   * playhead gets there, and "코러스 를 옮겼습니다" alone does not say where to.
   */
  const nudge = (sectionId: string, direction: -1 | 1): void => {
    let problems: string[] = [];
    let order = '';
    apply((s) => {
      const result = nudgeSection(s, sectionId, direction);
      problems = result.problems;
      order = describeOrder(result.session);
      return result.session;
    });
    if (problems.length > 0) { notify(problems[0]!, 'warning'); return; }
    notify(order, 'success');
  };

  return (
    <div
      ref={boxRef}
      className="relative border-b border-zinc-800 select-none"
      style={{ height: SECTION_LANE_HEIGHT, width, background: '#0E0E14' }}
    >
      {ranges.map((range) => {
        const left = (range.startSec - scrollSec) * pxPerSec;
        const w = (range.endSec - range.startSec) * pxPerSec;
        if (left + w < -40 || left > width + 40) return null;
        const color = kindColor(range.section.kind);
        return (
          <div
            key={range.section.id}
            className="absolute top-0 bottom-0 flex items-center gap-1 px-1.5 overflow-hidden group"
            style={{
              left, width: Math.max(2, w),
              background: `${color}33`,
              borderLeft: `2px solid ${color}`,
            }}
            onClick={() => selectSection(range.section.id, range.startSec)}
            title={`${sectionLabel(range.section)} — ${describeRange(range)}`}
          >
            {editing === range.section.id ? (
              <input
                autoFocus
                defaultValue={range.section.name}
                placeholder={sectionLabel(range.section)}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const name = e.target.value;
                  apply((s) => withSections(s, renameSection(sectionsOf(s), range.section.id, name)));
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
                className="h-4 px-1 text-[9.5px] rounded bg-transparent outline-none"
                style={{ color: premium.text.primary, border: `1px solid ${color}`, width: 90 }}
              />
            ) : (
              <span
                className="text-[9.5px] truncate"
                style={{ color: premium.text.secondary }}
                onDoubleClick={(e) => { e.stopPropagation(); setEditing(range.section.id); }}
              >{sectionLabel(range.section)}</span>
            )}

            {/* Only on hover, and only when the block is wide enough to hold
                them — a two-pixel section with four buttons in it is noise. */}
            {w > 130 && (
              <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <select
                  value={range.section.kind}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => apply((s) => withSections(s,
                    setSectionKind(sectionsOf(s), range.section.id, e.target.value as SectionKind)))}
                  title="구간 종류"
                  style={{
                    height: 15, fontSize: 8, borderRadius: 2, background: 'transparent',
                    color: premium.text.muted, border: '1px solid rgba(255,255,255,0.14)',
                  }}
                >
                  {SECTION_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>{k.label}</option>
                  ))}
                </select>
                {/* Reorder.  Buttons rather than dragging the block: the
                    block's own left edge is already the boundary handle, and
                    a section can be two pixels wide. */}
                <button
                  onClick={(e) => { e.stopPropagation(); nudge(range.section.id, -1); }}
                  disabled={range.index === 0}
                  title="이 구간을 앞 구간과 맞바꿉니다 (내용째로 이동)"
                  style={laneChip(undefined, range.index === 0)}
                >◀</button>
                <button
                  onClick={(e) => { e.stopPropagation(); nudge(range.section.id, 1); }}
                  disabled={range.index === ranges.length - 1}
                  title="이 구간을 뒤 구간과 맞바꿉니다 (내용째로 이동)"
                  style={laneChip(undefined, range.index === ranges.length - 1)}
                >▶</button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    runRipple(range.section.id, duplicateSection,
                      `${sectionLabel(range.section)} 을 복제했습니다`);
                  }}
                  title="이 구간을 복제해서 바로 뒤에 붙입니다 (뒤의 모든 것이 밀립니다)"
                  style={laneChip()}
                >복제</button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    runRipple(range.section.id, deleteSectionTime,
                      `${sectionLabel(range.section)} 을 잘라냈습니다`);
                  }}
                  title="이 구간을 시간째로 잘라냅니다 (곡이 짧아집니다)"
                  style={laneChip(premium.accent.danger)}
                >잘라내기</button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    apply((s) => withSections(s,
                      removeSectionMarker(sectionsOf(s), range.section.id)));
                  }}
                  title="경계만 지웁니다 — 오디오는 그대로입니다"
                  style={laneChip()}
                >경계만</button>
              </span>
            )}

            {/* The boundary handle: dragging it moves both neighbours. */}
            {range.startSec > MIN_SECTION_SEC && (
              <div
                onPointerDown={(e) => onBoundaryDown(e, range.section.id)}
                title="경계 끌기"
                className="absolute left-0 top-0 bottom-0"
                style={{
                  width: 6, marginLeft: -3, cursor: 'col-resize',
                  background: dragging === range.section.id ? color : 'transparent',
                }}
              />
            )}
          </div>
        );
      })}

      {ranges.length === 0 && (
        <span className="absolute left-2 top-1 text-[9.5px]" style={{ color: premium.text.faint }}>
          구간 없음 — 재생헤드에서 + 를 누르면 경계가 생깁니다
        </span>
      )}
    </div>
  );
}

function laneChip(
  color: string = premium.text.muted, disabled = false,
): React.CSSProperties {
  return {
    height: 15, padding: '0 4px', borderRadius: 2, fontSize: 8,
    color: disabled ? premium.text.faint : color,
    background: 'transparent',
    border: `1px solid rgba(255,255,255,${disabled ? '0.06' : '0.14'})`,
    // A first section that cannot move left says so by looking unavailable,
    // rather than by doing nothing when pressed.
    cursor: disabled ? 'default' : 'pointer',
  };
}
