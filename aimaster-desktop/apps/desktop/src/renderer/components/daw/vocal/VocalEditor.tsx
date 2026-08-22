// The vocal editor — one note at a time.
//
// The analysis and the PSOLA renderer already worked; you just could not see
// what they had found.  The shortcuts could tune a whole clip to a scale and
// report "12 segments", which is the wrong granularity for the only job this
// feature ever has: the take is good and two notes are flat.
//
// So the view draws three things, and the difference between them is the
// whole point:
//
//   the GREY line   what was sung, exactly, curve and vibrato and all
//   the BLOB        the note the singer aimed at, and the handle you drag
//   the BRIGHT line what the render will produce
//
// When nothing is edited the two lines sit on top of each other.  That is the
// honest resting state, and it is why the performance line is never hidden:
// a pitch editor that only shows its own output cannot be argued with.
//
// Dragging snaps to the semitone by default and to nothing while Alt is held,
// because "put it on the note" and "nudge it four cents" are both real edits
// and one of them is not expressible on a grid.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useVocalEditorStore } from '../../../stores/vocalEditorStore.js';
import {
  correctedLine, describeSegment, describeTiming, editedPitch, findClipSegments,
  hasPendingEdits, isEdited, mapSegments, moveSegmentTime, moveToPitch, nudgeCents,
  patchSegment, performanceLine, pitchName, pitchRange, resetSegment,
  resetSegmentTime, segmentsInSpan, timingRange, withSegments,
} from '../../../daw/edit/vocal-edit.js';
import { snapSecToBeats, tempoMapOf } from '../../../daw/model/tempo-map.js';
import { analyzeClipPitch, renderClipPitch, tuningSummary } from '../../../daw/audio/varia-actions.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { premium } from '../../../theme/premium.js';
import type { VariSegment } from '../../../daw/audio/pitch-analysis.js';
import type { ClipId, TrackId } from '../../../daw/model/types.js';

const SEMITONE_PX = 14;
const HEIGHT_PAD = 8;

export default function VocalEditor() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const {
    open, selected, pxPerSec, busy, snap,
  } = useVocalEditorStore();
  const openTake = useVocalEditorStore((s) => s.openTake);
  const select = useVocalEditorStore((s) => s.select);
  const toggle = useVocalEditorStore((s) => s.toggle);
  const clearSelection = useVocalEditorStore((s) => s.clearSelection);
  const setBusy = useVocalEditorStore((s) => s.setBusy);
  const setPxPerSec = useVocalEditorStore((s) => s.setPxPerSec);
  const setSnap = useVocalEditorStore((s) => s.setSnap);

  const boxRef = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ fromSec: number; toSec: number } | null>(null);

  // Every audio clip in the session is offerable; a clip with no analysis yet
  // is offered too, because "open it and press 분석" is the flow.
  const takes = useMemo(() => session.tracks.flatMap((track) =>
    trackClips(track)
      .filter((c) => c.kind === 'audio')
      .map((c) => ({
        trackId: track.id, clipId: c.id,
        label: `${track.name} · ${c.name}`,
        analysed: c.pitchSegments.length,
      }))), [session]);

  const clip = useMemo(() => {
    if (!open) return null;
    const track = findTrack(session, open.trackId);
    return track ? trackClips(track).find((c) => c.id === open.clipId) ?? null : null;
  }, [session, open]);

  const segments = clip?.pitchSegments ?? [];
  const range = useMemo(() => pitchRange(segments), [segments]);
  const height = (range.highPitch - range.lowPitch) * SEMITONE_PX + HEIGHT_PAD * 2;
  const lengthSec = clip?.durationSec ?? 0;

  const yOf = useCallback((pitch: number): number =>
    HEIGHT_PAD + (range.highPitch - pitch) * SEMITONE_PX, [range]);
  const xOf = useCallback((sec: number): number => sec * pxPerSec, [pxPerSec]);

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: e.clientX - box.left + (boxRef.current?.scrollLeft ?? 0),
      y: e.clientY - box.top + (boxRef.current?.scrollTop ?? 0),
    };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────

  const runAnalyze = async (): Promise<void> => {
    if (!open) { notify('먼저 테이크를 고르세요', 'warning'); return; }
    setBusy('피치 분석 중…');
    try {
      const result = await analyzeClipPitch(session, open.trackId, open.clipId);
      apply(() => result.session);
      clearSelection();
      notify(`${result.segmentCount}개 구간 — ${tuningSummary(
        result.session.tracks.flatMap((t) => trackClips(t))
          .find((c) => c.id === open.clipId)?.pitchSegments ?? [])}`, 'success');
    } catch (err) {
      notify(`분석 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  };

  const runRender = async (): Promise<void> => {
    if (!open || !clip) return;
    if (!hasPendingEdits(clip)) { notify('바뀐 것이 없습니다', 'info'); return; }
    setBusy('렌더링 중…');
    try {
      // One render is one undo step, and the edits are baked as it lands so a
      // second press cannot correct the same note twice.
      const rendered = await renderClipPitch(session, open.trackId, open.clipId);
      apply(() => rendered);
      notify('보정을 오디오에 적용했습니다', 'success');
    } catch (err) {
      notify(`렌더링 실패: ${(err as Error).message}`, 'error');
    } finally { setBusy(null); }
  };

  const editSelection = (fn: (segment: VariSegment) => VariSegment): void => {
    if (!open) return;
    if (selected.size === 0) { notify('먼저 노트를 고르세요', 'warning'); return; }
    apply((s) => mapSegments(s, open.trackId, open.clipId, selected, fn));
  };

  /**
   * Move the selection in time by a fixed step.
   *
   * Refuses out loud when the neighbours leave no room: a button that does
   * nothing looks broken, and "it stopped" is information — the note is
   * already against the next word.
   */
  const nudgeTiming = (deltaSec: number): void => {
    if (!open) return;
    if (selected.size === 0) { notify('먼저 노트를 고르세요', 'warning'); return; }
    const length = clip?.durationSec ?? 0;
    const range = timingRange(segments, selected, length);
    if (deltaSec < 0 ? range.minDelta >= -1e-9 : range.maxDelta <= 1e-9) {
      notify('옆 노트에 막혀 더 옮길 수 없습니다', 'warning');
      return;
    }
    apply((st) => withSegments(st, open.trackId, open.clipId,
      (list) => moveSegmentTime(list, selected, deltaSec, length).segments));
  };

  /**
   * Snap a timing move so the note's START lands on the grid.
   *
   * The grid is musical and the note is not: the snap is computed on the
   * TIMELINE, through the clip's position and the tempo map, so "put this
   * word on beat three" means beat three of the song rather than of the clip.
   */
  const snapTimingDelta = (segment: VariSegment, wanted: number): number => {
    const division = useDawStore.getState().gridDivision;
    if (!clip || !(division > 0)) return wanted;
    const base = clip.startSec + segment.startSec + segment.edit.timeOffsetSec;
    const snapped = snapSecToBeats(tempoMapOf(session), base + wanted, division);
    return snapped - base;
  };

  // ── Dragging a blob ────────────────────────────────────────────────────────

  const onBlobDown = (e: React.PointerEvent, segment: VariSegment): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!open) return;

    // Cmd/Ctrl-click takes a note out of the selection rather than replacing
    // it — the one gesture for "everything in this phrase except that one".
    if (e.metaKey || e.ctrlKey) { toggle(segment.id); return; }

    const ids = e.shiftKey || selected.has(segment.id)
      ? new Set(selected).add(segment.id)
      : new Set([segment.id]);
    select(ids);

    const startPitch = editedPitch(segment);
    const start = localPoint(e);
    // Where every dragged note started, captured once.  `applyTransient` keeps
    // handing back the LAST transient state, so a move handler that adds a
    // delta each time accumulates; setting an absolute offset from the frozen
    // start is the only shape that survives a slow drag.
    const startOffsets = new Map(
      segments.filter((s) => ids.has(s.id)).map((s) => [s.id, s.edit.pitchOffsetCents]));
    const startTiming = new Map(
      segments.filter((s) => ids.has(s.id)).map((s) => [s.id, s.edit.timeOffsetSec]));
    const clipLength = clip?.durationSec ?? 0;
    let moved = false;
    // ONE gesture, ONE axis.  A blob drag that changed pitch and timing at
    // once would move a note twelve milliseconds late every time somebody
    // tuned it, and nobody would notice until the render.  The axis is
    // decided by the first few pixels and then held for the rest of the drag.
    let axis: 'pitch' | 'time' | null = null;

    const move = (ev: PointerEvent): void => {
      const here = localPoint(ev);
      const dx = here.x - start.x;
      const dy = here.y - start.y;
      if (!moved) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'time' : 'pitch';
        moved = true;
      }

      if (axis === 'time') {
        // Alt suspends the grid here too, and here it matters more: vocal
        // timing lives in milliseconds, and the grid is in beats.
        const wanted = dx / pxPerSec;
        const delta = snap && !ev.altKey ? snapTimingDelta(segment, wanted) : wanted;
        useDawStore.getState().applyTransient((state) =>
          withSegments(state, open.trackId, open.clipId, (list) =>
            moveSegmentTime(list, ids, delta, clipLength, startTiming).segments));
        return;
      }

      const raw = startPitch - dy / SEMITONE_PX;
      // Alt suspends the grid: a four-cent move is not expressible on it.
      const target = snap && !ev.altKey ? Math.round(raw) : raw;
      const deltaCents = (target - startPitch) * 100;
      // Every selected note moves by the SAME interval rather than all landing
      // on one pitch — dragging a phrase up a tone is the common gesture, and
      // collapsing a phrase onto one note is not an edit anybody wants.
      useDawStore.getState().applyTransient((state) =>
        mapSegments(state, open.trackId, open.clipId, ids, (seg) => patchSegment(seg, {
          pitchOffsetCents: (startOffsets.get(seg.id) ?? 0) + deltaCents,
        })));
    };
    const up = (): void => {
      if (moved) {
        useDawStore.getState().commitEdit();
        if (axis === 'time') {
          const after = findClipSegments(useDawStore.getState().session, open.trackId, open.clipId)
            .find((s) => s.id === segment.id);
          if (after) notify(`타이밍 ${describeTiming(after)}`);
        }
      }
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  // ── Rubber band ────────────────────────────────────────────────────────────

  const onBackgroundDown = (e: React.PointerEvent): void => {
    if (!open) return;
    const startX = localPoint(e).x;
    const fromSec = startX / pxPerSec;
    let dragged = false;
    const move = (ev: PointerEvent): void => {
      dragged = true;
      setBand({ fromSec, toSec: localPoint(ev).x / pxPerSec });
    };
    const up = (ev: PointerEvent): void => {
      if (dragged) {
        const toSec = localPoint(ev).x / pxPerSec;
        select(segmentsInSpan(segments, fromSec, toSec).map((s) => s.id));
      } else {
        clearSelection();
      }
      setBand(null);
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  const chosen = segments.filter((s) => selected.has(s.id));

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: premium.surface.abyss }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 flex-wrap"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
          Vocal Editor
        </span>

        <select
          value={open ? `${open.trackId}|${open.clipId}` : ''}
          onChange={(e) => {
            const [trackId, clipId] = e.target.value.split('|');
            openTake(trackId && clipId
              ? { trackId: trackId as TrackId, clipId: clipId as ClipId } : null);
          }}
          style={{
            height: 26, minWidth: 200, padding: '0 6px', borderRadius: 3,
            background: premium.surface.well, color: premium.text.primary,
            border: `1px solid ${premium.surface.hairline}`,
            fontFamily: premium.type.sans, fontSize: 11,
          }}
        >
          <option value="">테이크 선택…</option>
          {takes.map((t) => (
            <option key={t.clipId} value={`${t.trackId}|${t.clipId}`}>
              {t.label}{t.analysed > 0 ? ` (${t.analysed})` : ''}
            </option>
          ))}
        </select>

        <Btn onClick={() => { void runAnalyze(); }} disabled={!open}>피치 분석</Btn>
        <Btn onClick={() => { void runRender(); }}
             disabled={!clip || !hasPendingEdits(clip)}
             primary={!!clip && hasPendingEdits(clip)}>
          {clip && hasPendingEdits(clip) ? '오디오에 적용 ●' : '오디오에 적용'}
        </Btn>

        <div className="flex-1" />

        <label className="flex items-center gap-1"
               style={{ fontSize: 10.5, color: premium.text.muted, cursor: 'pointer' }}>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          반음 스냅 (Alt 로 일시 해제)
        </label>
        <Btn onClick={() => setPxPerSec(pxPerSec / 1.4)}>−</Btn>
        <Btn onClick={() => setPxPerSec(pxPerSec * 1.4)}>+</Btn>
        {busy && <span style={{ fontSize: 11, color: premium.accent.base }}>{busy}</span>}
      </div>

      {/* ── Blob view ──────────────────────────────────────────────────── */}
      <div ref={boxRef} className="flex-1 overflow-auto relative" onPointerDown={onBackgroundDown}>
        {segments.length === 0 ? (
          <div className="p-6" style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted }}>
            {open
              ? '이 테이크는 아직 분석되지 않았습니다 — 피치 분석을 누르세요.'
              : '보컬 테이크를 고르세요. 오디오 클립이면 무엇이든 열 수 있습니다.'}
          </div>
        ) : (
          <svg
            width={Math.max(600, xOf(lengthSec) + 40)}
            height={height}
            style={{ display: 'block' }}
          >
            {/* Semitone grid.  Naturals get a brighter line so the octave is
                readable without labels on every row. */}
            {Array.from({ length: range.highPitch - range.lowPitch + 1 }, (_, i) => {
              const pitch = range.lowPitch + i;
              const natural = ![1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
              return (
                <g key={pitch}>
                  <line x1={0} x2="100%" y1={yOf(pitch)} y2={yOf(pitch)}
                        stroke={natural ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)'} />
                  {natural && pitch % 12 === 0 && (
                    <text x={4} y={yOf(pitch) - 2} fontSize={8} fill={premium.text.faint}>
                      {pitchName(pitch)}
                    </text>
                  )}
                </g>
              );
            })}

            {segments.map((segment) => {
              const sung = performanceLine(segment);
              const fixed = correctedLine(segment);
              const path = (points: { timeSec: number; pitch: number }[]): string =>
                points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.timeSec).toFixed(1)},${yOf(p.pitch).toFixed(1)}`).join(' ');
              const isSelected = selected.has(segment.id);
              const blobY = yOf(editedPitch(segment));
              const x = xOf(segment.startSec + segment.edit.timeOffsetSec);
              const w = Math.max(3, xOf(segment.endSec - segment.startSec));
              return (
                <g key={segment.id}>
                  {/* What was sung — never hidden, even after an edit.
                      Both curves are DECORATION: they are drawn over the
                      blob, and a stroked path takes pointer events, so
                      without this the note cannot be grabbed anywhere near
                      its middle — which is exactly where a hand goes. */}
                  <path d={path(sung)} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={1}
                        style={{ pointerEvents: 'none' }} />
                  {/* Where the note was SUNG, when it has been moved.  A
                      timing edit is otherwise invisible — the blob just sits
                      somewhere, and nothing says how far from the take it is. */}
                  {segment.edit.timeOffsetSec !== 0 && (
                    <>
                      <rect
                        x={xOf(segment.startSec)} y={blobY - SEMITONE_PX / 2 + 1}
                        width={w} height={SEMITONE_PX - 2} rx={3}
                        fill="none" stroke="rgba(255,255,255,0.20)" strokeDasharray="2 2"
                      />
                      <line
                        x1={xOf(segment.startSec)} x2={x} y1={blobY} y2={blobY}
                        stroke={premium.accent.base} strokeWidth={1} strokeDasharray="1 2"
                      />
                    </>
                  )}
                  {/* The blob: the note, and the handle.  It moves on both
                      axes, so the cursor says so — `ns-resize` would promise
                      pitch only. */}
                  <rect
                    x={x} y={blobY - SEMITONE_PX / 2 + 1}
                    width={w} height={SEMITONE_PX - 2} rx={3}
                    fill={isEdited(segment) ? 'rgba(198,167,104,0.30)' : 'rgba(120,140,200,0.26)'}
                    stroke={isSelected ? premium.accent.light : 'rgba(255,255,255,0.18)'}
                    strokeWidth={isSelected ? 1.5 : 1}
                    style={{ cursor: 'move' }}
                    onPointerDown={(e) => onBlobDown(e, segment)}
                  >
                    <title>{`${pitchName(Math.round(editedPitch(segment)))} · ${describeTiming(segment)}`
                      + ' — 위아래로 끌면 음정, 좌우로 끌면 타이밍'}</title>
                  </rect>
                  {/* What the render will produce. */}
                  <path d={path(fixed)} fill="none"
                        stroke={isEdited(segment) ? premium.accent.base : 'rgba(255,255,255,0.45)'}
                        strokeWidth={1.4} style={{ pointerEvents: 'none' }} />
                </g>
              );
            })}

            {band && (
              <rect
                x={xOf(Math.min(band.fromSec, band.toSec))}
                y={0}
                width={Math.abs(xOf(band.toSec - band.fromSec))}
                height={height}
                fill="rgba(198,167,104,0.10)"
                stroke="rgba(198,167,104,0.4)"
              />
            )}
          </svg>
        )}
      </div>

      {/* ── Inspector ──────────────────────────────────────────────────── */}
      {segments.length > 0 && (
        <div className="px-4 py-2 flex items-center gap-2 flex-wrap"
             style={{ borderTop: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
          <span style={{ fontFamily: premium.type.mono, fontSize: 10.5, color: premium.text.secondary, minWidth: 240 }}>
            {chosen.length === 0 ? `${segments.length}개 구간 — 노트를 고르세요`
              : chosen.length === 1 ? describeSegment(chosen[0]!)
              : `${chosen.length}개 선택`}
          </span>

          <Btn onClick={() => editSelection((s) => moveToPitch(s, Math.round(s.measured.medianPitch)))}>
            가장 가까운 반음으로
          </Btn>
          <Btn onClick={() => editSelection((s) => nudgeCents(s, 10))}>+10¢</Btn>
          <Btn onClick={() => editSelection((s) => nudgeCents(s, -10))}>−10¢</Btn>

          <Slider label="비브라토" value={chosen[0]?.edit.vibratoScale ?? 1}
                  onChange={(v) => editSelection((s) => patchSegment(s, { vibratoScale: v }))} />
          <Slider label="드리프트" value={chosen[0]?.edit.driftScale ?? 1}
                  onChange={(v) => editSelection((s) => patchSegment(s, { driftScale: v }))} />
          <Slider label="포먼트" value={chosen[0]?.edit.formantSemitones ?? 0}
                  min={-6} max={6} step={0.5} unit=" st"
                  onChange={(v) => editSelection((s) => patchSegment(s, { formantSemitones: v }))} />

          {/* Timing.  Milliseconds, because that is the unit a late word is
              talked about in, and clamped by the neighbours like the drag. */}
          <Btn onClick={() => nudgeTiming(-0.01)}>−10ms</Btn>
          <Btn onClick={() => nudgeTiming(0.01)}>+10ms</Btn>
          <Btn onClick={() => {
            if (!open || selected.size === 0) { notify('먼저 노트를 고르세요', 'warning'); return; }
            apply((st) => withSegments(st, open.trackId, open.clipId,
              (list) => resetSegmentTime(list, selected)));
          }}>타이밍 0</Btn>

          <Btn onClick={() => editSelection(resetSegment)}>원래대로</Btn>
        </div>
      )}
    </div>
  );
}

function Slider({
  label, value, onChange, min = 0, max = 1, step = 0.05, unit = '',
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <label className="flex items-center gap-1" style={{ fontSize: 10, color: premium.text.muted }}>
      {label}
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             style={{ width: 66, accentColor: premium.accent.base }} />
      <span style={{ fontFamily: premium.type.mono, minWidth: 30 }}>
        {unit ? value.toFixed(1) + unit : `${Math.round(value * 100)}%`}
      </span>
    </label>
  );
}

function Btn({ onClick, children, disabled, primary }: {
  onClick: () => void; children: React.ReactNode; disabled?: boolean; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 24, padding: '0 9px', borderRadius: 3,
        fontFamily: premium.type.sans, fontSize: 10.5,
        color: disabled ? premium.text.faint : primary ? premium.accent.light : premium.text.secondary,
        background: primary ? 'rgba(198,167,104,0.14)' : premium.surface.well,
        border: `1px solid ${primary ? premium.accent.deep : premium.surface.hairline}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >{children}</button>
  );
}
