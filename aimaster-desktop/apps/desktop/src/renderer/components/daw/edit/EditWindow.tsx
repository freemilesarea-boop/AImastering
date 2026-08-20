// EditWindow — the timeline half of the workspace.
//
// Ruler, track headers, clip lanes, selection, play head, loop locators.
// Every gesture here writes to dawStore, and every keystroke that does the
// same work lives in the shortcut layer — the mouse and the keyboard drive
// one model, never two.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore, snapToGrid, type EditMode } from '../../../stores/dawStore.js';
import { useWorkspaceStore } from '../../../stores/workspaceStore.js';
import { useRecordingStore } from '../../../stores/recordingStore.js';
import { useAudioStore } from '../../../stores/audioStore.js';
import { usePluginWindowStore } from '../../../stores/pluginWindowStore.js';
import { decodeForDisplay } from '../../../daw/engine/audio-cache.js';
import { activePlaylist, clipAt, sessionEndSec } from '../../../daw/model/session-ops.js';
import { moveClip } from '../../../daw/edit/clip-edit.js';
import { useMidiEditorStore } from '../../../stores/midiEditorStore.js';
import { formatChord } from '../../../daw/model/chords.js';
import {
  collapsedOverviewClips, stackDepth, stackSummary, toggleCollapsed, unpackStack,
  visibleTracks,
} from '../../../daw/model/stacks.js';
import { premium } from '../../../theme/premium.js';
import { cyclePlaylist } from '../../../daw/edit/comping.js';
import { toggleMute, toggleSolo } from '../../../daw/model/mixer-math.js';
import type { Track } from '../../../daw/model/types.js';
import TrackLaneCanvas from './TrackLaneCanvas.js';
import AutomationLaneCanvas, {
  AUTOMATION_LANE_HEIGHT, AutomationLaneHeader,
} from './AutomationLane.js';
import {
  availableTargets, setLaneVisible, visibleLanes,
} from '../../../daw/edit/automation-lanes.js';
import type { AutomationLane } from '../../../daw/model/types.js';

const HEADER_WIDTH = 168;
const RULER_HEIGHT = 26;

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.000';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

const EDIT_MODES: EditMode[] = ['shuffle', 'slip', 'spot', 'grid'];
const MODE_LABELS: Record<EditMode, string> = {
  shuffle: 'SHUFFLE', slip: 'SLIP', spot: 'SPOT', grid: 'GRID',
};

export default function EditWindow() {
  const session      = useDawStore((s) => s.session);
  const selection    = useDawStore((s) => s.selection);
  const setSelection = useDawStore((s) => s.setSelection);
  const playheadSec  = useDawStore((s) => s.playheadSec);
  const seek         = useDawStore((s) => s.seek);
  const pxPerSec     = useDawStore((s) => s.pxPerSec);
  const setPxPerSec  = useDawStore((s) => s.setPxPerSec);
  const scrollSec    = useDawStore((s) => s.scrollSec);
  const setScrollSec = useDawStore((s) => s.setScrollSec);
  const editMode     = useDawStore((s) => s.editMode);
  const setEditMode  = useDawStore((s) => s.setEditMode);
  const gridSec      = useDawStore((s) => s.gridSec);
  const nudgeSec     = useDawStore((s) => s.nudgeSec);
  const tabToTransient = useDawStore((s) => s.tabToTransient);
  const toggleTab    = useDawStore((s) => s.toggleTabToTransient);
  const loopEnabled  = useDawStore((s) => s.loopEnabled);
  const loopStartSec = useDawStore((s) => s.loopStartSec);
  const loopEndSec   = useDawStore((s) => s.loopEndSec);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const setFocusedTrack = useDawStore((s) => s.setFocusedTrack);
  const apply        = useDawStore((s) => s.apply);
  const tool         = useWorkspaceStore((s) => s.tool);

  const laneRef = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState(900);
  const [decodeTick, setDecodeTick] = useState(0);
  const [drag, setDrag] = useState<null | { anchorSec: number; trackIds: string[] }>(null);
  // Clip drag: one gesture = one undo step, so it writes through
  // applyTransient and commits on mouse up.
  const [clipDrag, setClipDrag] = useState<null | {
    trackId: string; clipId: string; grabOffsetSec: number;
  }>(null);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit     = useDawStore((s) => s.commitEdit);

  // Decode sources for display (no user gesture needed — offline context).
  useEffect(() => {
    let cancelled = false;
    void decodeForDisplay(session.files).then(() => {
      if (!cancelled) setDecodeTick((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [session.files]);

  // Track the lane width so the canvases size themselves correctly.
  useEffect(() => {
    const el = laneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setLaneWidth(Math.max(120, w));
    });
    ro.observe(el);
    setLaneWidth(Math.max(120, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const endSec = useMemo(() => sessionEndSec(session), [session]);
  const toX = useCallback((sec: number) => (sec - scrollSec) * pxPerSec, [scrollSec, pxPerSec]);
  const secAt = useCallback((clientX: number) => {
    const el = laneRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, scrollSec + (clientX - rect.left) / pxPerSec);
  }, [scrollSec, pxPerSec]);

  // Collapsed stacks fold their members away, so the arrange window stays
  // readable at forty tracks.
  const rows = visibleTracks(session);

  // Headers and lanes are two columns of the same list, so they are built ONCE
  // and both sides map over it.  Building them separately is how the two
  // columns end up one row out of step the first time somebody opens an
  // automation lane.
  const displayRows = useMemo<Array<
    | { kind: 'track'; key: string; track: Track; height: number }
    | { kind: 'lane'; key: string; track: Track; lane: AutomationLane; height: number }
  >>(() => {
    const out: Array<
      | { kind: 'track'; key: string; track: Track; height: number }
      | { kind: 'lane'; key: string; track: Track; lane: AutomationLane; height: number }
    > = [];
    for (const track of rows) {
      out.push({ kind: 'track', key: track.id, track, height: track.height });
      if (track.kind === 'folder' && track.collapsed) continue;
      for (const lane of visibleLanes(track)) {
        out.push({
          kind: 'lane',
          key: `${track.id}:${lane.id}`,
          track,
          lane,
          height: AUTOMATION_LANE_HEIGHT,
        });
      }
    }
    return out;
  }, [rows]);
  const recordStatus = useRecordingStore((s) => s.status);
  // A session with only a master track is not "empty timeline", it is "you
  // have nothing to work on yet" — and a blank grid says neither.
  const hasMaterial = session.tracks.some((t) => t.kind === 'audio' || t.kind === 'instrument');
  const queueCount = useAudioStore((s) => s.queue.length);

  /**
   * Open or close a track's automation.
   *
   * Opening shows the volume lane — the one anybody opening automation wants
   * first — and closing folds every lane away without deleting anything: the
   * breakpoints stay, and the engine goes on playing them.
   */
  const toggleAutomation = useCallback((track: Track) => {
    const open = visibleLanes(track).length > 0;
    apply((s) => {
      if (open) {
        let next = s;
        for (const lane of track.automation) {
          next = setLaneVisible(next, track.id, lane.target, false);
        }
        return next;
      }
      const first = availableTargets(track)[0];
      return first ? setLaneVisible(s, track.id, first, true) : s;
    });
  }, [apply]);

  // ── Lane gestures ───────────────────────────────────────────────────────
  const onLaneDown = useCallback((e: React.MouseEvent, track: Track) => {
    const at = snapToGrid(secAt(e.clientX));
    setFocusedTrack(track.id);
    if (tool === 'zoom') {
      setPxPerSec(e.altKey ? pxPerSec / 1.6 : pxPerSec * 1.6);
      return;
    }
    if (tool === 'select' && !e.shiftKey) {
      // Grabber behaviour: a click ON a clip drags it, empty lane seeks.
      const raw = secAt(e.clientX);
      const clip = clipAt(track, raw);
      if (clip) {
        setClipDrag({ trackId: track.id, clipId: clip.id, grabOffsetSec: raw - clip.startSec });
        setSelection({ startSec: clip.startSec, endSec: clip.startSec + clip.durationSec, trackIds: [track.id] });
        return;
      }
      seek(at);
      setSelection({ startSec: at, endSec: at, trackIds: [track.id] });
      setDrag({ anchorSec: at, trackIds: [track.id] });
      return;
    }
    // range tool or shift-drag → time selection
    setSelection({ startSec: at, endSec: at, trackIds: [track.id] });
    setDrag({ anchorSec: at, trackIds: [track.id] });
  }, [secAt, setFocusedTrack, tool, setPxPerSec, pxPerSec, seek, setSelection]);

  const onLaneMove = useCallback((e: React.MouseEvent) => {
    if (clipDrag) {
      const target = snapToGrid(Math.max(0, secAt(e.clientX) - clipDrag.grabOffsetSec));
      applyTransient((s) => moveClip(s, clipDrag.trackId, clipDrag.clipId, target));
      return;
    }
    if (!drag) return;
    const at = snapToGrid(secAt(e.clientX));
    setSelection({
      startSec: Math.min(drag.anchorSec, at),
      endSec: Math.max(drag.anchorSec, at),
      trackIds: drag.trackIds,
    });
  }, [drag, clipDrag, secAt, setSelection, applyTransient]);

  const endDrag = useCallback(() => {
    if (clipDrag) { commitEdit(); setClipDrag(null); }
    setDrag(null);
  }, [clipDrag, commitEdit]);

  const rulerDown = useCallback((e: React.MouseEvent) => {
    seek(snapToGrid(secAt(e.clientX)));
  }, [seek, secAt]);

  // Ruler ticks — roughly one label every 90 px.
  const ticks = useMemo(() => {
    const targetSec = 90 / pxPerSec;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s >= targetSec) ?? 300;
    const first = Math.floor(scrollSec / step) * step;
    const out: number[] = [];
    for (let t = first; t < scrollSec + laneWidth / pxPerSec; t += step) out.push(t);
    return out;
  }, [pxPerSec, scrollSec, laneWidth]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#101018] text-zinc-200">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-[#15151d] flex-wrap">
        <div className="flex rounded-md overflow-hidden border border-zinc-700">
          {EDIT_MODES.map((m) => (
            <button
              key={m}
              onClick={() => setEditMode(m)}
              className={`px-2 py-1 text-[10px] font-mono tracking-wide transition-colors ${
                editMode === m ? 'bg-emerald-600/30 text-emerald-300' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
            >{MODE_LABELS[m]}</button>
          ))}
        </div>

        <span className="text-[10px] font-mono text-zinc-600">
          Grid {gridSec}s · Nudge {nudgeSec}s
        </span>

        <button
          onClick={toggleTab}
          title="Tab to Transient (Cmd+Alt+Tab)"
          className={`px-2 py-1 rounded text-[10px] border transition-colors ${
            tabToTransient
              ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
              : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
        >TAB→TRANSIENT</button>

        <div className="flex-1" />

        <button onClick={() => setPxPerSec(pxPerSec / 1.5)}
          className="px-2 py-1 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">−</button>
        <span className="text-[10px] font-mono text-zinc-600 w-16 text-center">{pxPerSec.toFixed(0)} px/s</span>
        <button onClick={() => setPxPerSec(pxPerSec * 1.5)}
          className="px-2 py-1 rounded text-[10px] bg-zinc-900 border border-zinc-700 text-zinc-400">+</button>

        <span className="text-[11px] font-mono text-zinc-300 ml-2">{fmt(playheadSec)}</span>
        <span className="text-[10px] font-mono text-zinc-600">
          {selection.endSec > selection.startSec
            ? `SEL ${fmt(selection.startSec)} → ${fmt(selection.endSec)}`
            : 'SEL —'}
        </span>
      </div>

      {/* ── Ruler ───────────────────────────────────────────────────────── */}
      <div className="flex border-b border-zinc-800 bg-[#12121a]">
        <div style={{ width: HEADER_WIDTH }} className="shrink-0 border-r border-zinc-800" />
        <div
          onMouseDown={rulerDown}
          className="relative flex-1 cursor-pointer overflow-hidden"
          style={{ height: RULER_HEIGHT }}
        >
          {ticks.map((t) => (
            <div key={t} className="absolute top-0 bottom-0 border-l border-zinc-800"
                 style={{ left: toX(t) }}>
              <span className="absolute left-1 top-1 text-[9px] font-mono text-zinc-600">{fmt(t).slice(0, -2)}</span>
            </div>
          ))}
          {loopEndSec > loopStartSec && (
            <div className={`absolute top-0 h-1.5 ${loopEnabled ? 'bg-emerald-500' : 'bg-zinc-600'}`}
                 style={{ left: toX(loopStartSec), width: Math.max(2, (loopEndSec - loopStartSec) * pxPerSec) }} />
          )}
          <div className="absolute top-0 bottom-0 w-px bg-red-400" style={{ left: toX(playheadSec) }} />
        </div>
      </div>

      {/* ── Chord track ─────────────────────────────────────────────────
          The project's harmony, shown above the tracks so an arrangement
          decision is visible while editing. */}
      <div className="flex border-b border-zinc-800 bg-[#14141c]" style={{ height: 22 }}>
        <div style={{ width: HEADER_WIDTH }}
             className="shrink-0 border-r border-zinc-800 flex items-center px-2">
          <span className="text-[9px] uppercase tracking-[0.14em] text-zinc-600">Chords</span>
        </div>
        <div className="relative flex-1 overflow-hidden">
          {session.chordTrack.map((event) => (
            <span
              key={event.id}
              className="absolute top-0.5 px-1 rounded text-[10px] font-medium
                         bg-indigo-600/25 border border-indigo-500/40 text-indigo-200 whitespace-nowrap"
              style={{ left: toX(event.timeSec) }}
              title={`${formatChord(event.chord)} @ ${event.timeSec.toFixed(2)}s`}
            >
              {formatChord(event.chord)}
            </span>
          ))}
          {session.chordTrack.length === 0 && (
            <span className="absolute left-2 top-1 text-[9px] text-zinc-700">
              MIDI 파트에서 Mod+Shift+C 로 코드를 감지할 수 있습니다
            </span>
          )}
        </div>
      </div>

      {/* ── Tracks ──────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-y-auto" onMouseUp={endDrag} onMouseLeave={endDrag}>
        {/* Headers */}
        <div style={{ width: HEADER_WIDTH }} className="shrink-0 border-r border-zinc-800 bg-[#12121a]">
          {displayRows.map((row) => (row.kind === 'lane' ? (
            <AutomationLaneHeader key={row.key} track={row.track} lane={row.lane} />
          ) : (
            <TrackHeader
              key={row.key}
              track={row.track}
              depth={stackDepth(session, row.track.id)}
              summary={row.track.kind === 'folder' ? stackSummary(session, row.track.id) : null}
              focused={focusedTrackId === row.track.id}
              onFocus={() => setFocusedTrack(row.track.id)}
              onSolo={() => apply((s) => toggleSolo(s, row.track.id))}
              onMute={() => apply((s) => toggleMute(s, row.track.id))}
              onCyclePlaylist={(dir) => apply((s) => cyclePlaylist(s, row.track.id, dir))}
              onArm={() => void useRecordingStore.getState().toggleArm(row.track.id)}
              recording={recordStatus === 'recording' || recordStatus === 'countIn'}
              onToggleCollapse={() => apply((s) => toggleCollapsed(s, row.track.id))}
              onUnpack={() => apply((s) => unpackStack(s, row.track.id))}
              onSmart={() => useDawStore.getState().openSmartControls(row.track.id)}
              onInserts={() => usePluginWindowStore.getState().toggleRack(row.track.id)}
              onToggleAutomation={() => toggleAutomation(row.track)}
              automationOpen={visibleLanes(row.track).length > 0}
            />
          )))}
        </div>

        {/* Lanes */}
        <div ref={laneRef} className="flex-1 relative overflow-hidden" onMouseMove={onLaneMove}>
          {!hasMaterial && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10"
                 style={{ pointerEvents: 'none' }}>
              <p style={{
                fontFamily: premium.type.display, fontSize: 20, color: premium.accent.light,
              }}>세션이 비어 있습니다</p>
              <p style={{
                fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted,
                textAlign: 'center', lineHeight: 1.7,
              }}>
                {queueCount > 0
                  ? <>홈에 불러온 {queueCount}곡이 있습니다 — 위의 <b>홈 트랙 가져오기</b>를 누르세요.<br />
                      또는 <b>오디오 추가</b>로 파일을 열거나, <b>+ 인스트루먼트</b>로 MIDI 파트를 만드세요.</>
                  : <><b>오디오 추가</b>로 파일을 열거나, <b>+ 인스트루먼트</b>로 MIDI 파트를 만드세요.<br />
                      드럼부터 짜려면 <b>STEPS</b> 탭에서 그리드를 찍으면 됩니다.</>}
              </p>
            </div>
          )}
          {displayRows.map((row) => (row.kind === 'lane' ? (
            <AutomationLaneCanvas
              key={row.key}
              track={row.track}
              lane={row.lane}
              viewport={{ scrollSec, pxPerSec, width: laneWidth, height: row.height }}
            />
          ) : (
            <div
              key={row.key}
              onMouseDown={(e) => onLaneDown(e, row.track)}
              onDoubleClick={(e) => {
                // Double-clicking a MIDI part opens it in the Key Editor,
                // exactly like the reference DAW.
                const at = secAt(e.clientX);
                const clip = clipAt(row.track, at);
                if (clip?.kind === 'midi') {
                  useMidiEditorStore.getState().openPart({ trackId: row.track.id, clipId: clip.id });
                  useDawStore.getState().setWindow('midi');
                }
              }}
              className="relative border-b border-zinc-900"
              style={{ height: row.height }}
            >
              {row.track.kind === 'folder' && row.track.collapsed ? (
                // A collapsed stack still shows where its material sits.
                <div className="absolute inset-0">
                  {collapsedOverviewClips(session, row.track.id).map((c, i) => (
                    <div
                      key={`${c.startSec}-${i}`}
                      className="absolute rounded-sm"
                      style={{
                        left: toX(c.startSec),
                        width: Math.max(2, (c.endSec - c.startSec) * pxPerSec),
                        top: 6 + (i % 4) * 4,
                        height: 6,
                        background: c.trackColor,
                        opacity: 0.75,
                      }}
                    />
                  ))}
                </div>
              ) : (
                <TrackLaneCanvas
                  track={row.track}
                  viewport={{ scrollSec, pxPerSec, width: laneWidth, height: row.height }}
                  selected={selection.trackIds.includes(row.track.id)}
                  decodeTick={decodeTick}
                />
              )}
              {selection.trackIds.includes(row.track.id) && selection.endSec > selection.startSec && (
                <div className="absolute top-0 bottom-0 bg-white/10 border-x border-white/40 pointer-events-none"
                     style={{
                       left: toX(selection.startSec),
                       width: Math.max(1, (selection.endSec - selection.startSec) * pxPerSec),
                     }} />
              )}
            </div>
          )))}

          {/* Play head across every lane */}
          <div className="absolute top-0 bottom-0 w-px bg-red-400 pointer-events-none"
               style={{ left: toX(playheadSec) }} />
        </div>
      </div>

      {/* ── Horizontal scroll ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1 border-t border-zinc-800 bg-[#12121a]">
        <span className="text-[10px] font-mono text-zinc-600">스크롤</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, endSec)}
          step={0.05}
          value={Math.min(scrollSec, Math.max(1, endSec))}
          onChange={(e) => setScrollSec(parseFloat(e.target.value))}
          className="flex-1 accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-zinc-600">{fmt(endSec)}</span>
      </div>
    </div>
  );
}

function TrackHeader({
  track, depth, summary, focused, onFocus, onSolo, onMute, onCyclePlaylist,
  onToggleCollapse, onUnpack, onSmart, onInserts, onArm, recording,
  onToggleAutomation, automationOpen,
}: {
  track: Track;
  depth: number;
  summary: string | null;
  focused: boolean;
  onFocus: () => void;
  onSolo: () => void;
  onMute: () => void;
  onCyclePlaylist: (dir: 1 | -1) => void;
  onArm: () => void;
  recording: boolean;
  onToggleCollapse: () => void;
  onUnpack: () => void;
  onSmart: () => void;
  onInserts: () => void;
  onToggleAutomation: () => void;
  automationOpen: boolean;
}) {
  const playlist = activePlaylist(track);
  const takes = track.playlists.length;
  const isFolder = track.kind === 'folder';
  const macroCount = Object.values(track.macros.values).filter((v) => (v ?? 0) !== 0).length;
  // Folders and VCAs carry no signal, so there is nothing to insert into them.
  const carriesInserts = track.kind !== 'folder' && track.kind !== 'vca';
  const insertCount = track.inserts.length;
  return (
    <div
      onMouseDown={onFocus}
      className={`px-2 py-1.5 border-b border-zinc-900 flex flex-col gap-1 ${focused ? 'bg-zinc-800/60' : ''}`}
      style={{
        height: track.height,
        paddingLeft: 8 + depth * 12,
        ...(isFolder
          ? { background: focused ? 'rgba(198,167,104,0.10)' : 'rgba(198,167,104,0.05)' }
          : {}),
      }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {isFolder ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            title={track.collapsed ? '스택 펼치기' : '스택 접기'}
            className="w-3.5 h-3.5 shrink-0 text-[9px] leading-none"
            style={{ color: premium.accent.base }}
          >{track.collapsed ? '▶' : '▼'}</button>
        ) : (
          <span className="w-1.5 h-4 rounded-sm shrink-0" style={{ background: track.color }} />
        )}
        <span
          className="text-[11px] truncate flex-1"
          style={{
            color: isFolder ? premium.accent.light : 'rgb(228,228,231)',
            letterSpacing: isFolder ? '0.08em' : undefined,
            fontWeight: isFolder ? 600 : 400,
          }}
          title={track.name}
        >{isFolder ? track.name.toUpperCase() : track.name}</span>
        {macroCount > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onSmart(); }}
            title={`${macroCount}개 매크로 활성 — 스마트 컨트롤 열기`}
            className="text-[8px] px-1 rounded shrink-0"
            style={{
              border: `1px solid ${premium.accent.deep}`,
              color: premium.accent.base,
            }}
          >{macroCount}</button>
        )}
        {carriesInserts && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleAutomation(); }}
            title={automationOpen ? '오토메이션 레인 접기' : '오토메이션 레인 열기'}
            className="text-[9px] leading-none w-4 h-4 rounded shrink-0 flex items-center
                       justify-center transition-colors"
            style={{
              border: `1px solid ${automationOpen ? premium.accent.deep : 'rgba(255,255,255,0.14)'}`,
              color: automationOpen ? premium.accent.base : premium.text.muted,
            }}
          >A</button>
        )}
        {carriesInserts && (
          <button
            onClick={(e) => { e.stopPropagation(); onInserts(); }}
            title={insertCount > 0
              ? `인서트 ${insertCount}개 — 열기`
              : '플러그인 추가 · 편집'}
            className="text-[10px] leading-none w-4 h-4 rounded shrink-0 flex items-center
                       justify-center transition-colors"
            style={{
              border: `1px solid ${insertCount > 0 ? premium.accent.deep : 'rgba(255,255,255,0.14)'}`,
              color: insertCount > 0 ? premium.accent.base : premium.text.muted,
            }}
          >✎</button>
        )}
        <span className="text-[9px] font-mono text-zinc-600 uppercase">{track.kind.slice(0, 3)}</span>
      </div>
      {isFolder && summary && !focused && (
        <span className="text-[8px] text-zinc-600 truncate">{summary}</span>
      )}
      <div className="flex items-center gap-1">
        {(track.kind === 'audio' || track.kind === 'instrument') && (
          <button
            onClick={(e) => { e.stopPropagation(); onArm(); }}
            title={track.recordArm ? '녹음 무장 해제' : '녹음 무장 (R)'}
            className={`w-5 h-5 rounded text-[9px] border ${track.recordArm
              ? (recording
                ? 'bg-red-600 border-red-400 text-white animate-pulse'
                : 'bg-red-600/30 border-red-500/60 text-red-300')
              : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
          >●</button>
        )}
        <button onClick={onSolo}
          className={`w-5 h-5 rounded text-[9px] border ${track.solo
            ? 'bg-yellow-500/30 border-yellow-500/60 text-yellow-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>S</button>
        <button onClick={onMute}
          className={`w-5 h-5 rounded text-[9px] border ${track.mute
            ? 'bg-red-600/30 border-red-500/60 text-red-300'
            : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>M</button>
        {track.frozen && (
          <span className="px-1 rounded text-[8px] bg-sky-600/30 border border-sky-500/50 text-sky-300">FRZ</span>
        )}
        {isFolder && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnpack(); }}
            title="스택 해제 (멤버는 유지)"
            className="w-5 h-5 rounded text-[9px] bg-zinc-900 border border-zinc-700 text-zinc-500"
          >⤫</button>
        )}
        {takes > 1 && (
          <div className="flex items-center gap-0.5 ml-auto">
            <button onClick={() => onCyclePlaylist(-1)}
              className="w-4 h-4 rounded text-[8px] bg-zinc-900 border border-zinc-700 text-zinc-500">▲</button>
            <span className="text-[8px] font-mono text-zinc-500 truncate max-w-[46px]"
                  title={playlist?.name}>{playlist?.name.split('.').pop()}</span>
            <button onClick={() => onCyclePlaylist(1)}
              className="w-4 h-4 rounded text-[8px] bg-zinc-900 border border-zinc-700 text-zinc-500">▼</button>
          </div>
        )}
      </div>
    </div>
  );
}
