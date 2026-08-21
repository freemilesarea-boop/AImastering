// DawTransportBar — the bottom transport / timeline strip (F2).
//
// This is the surface the DAW shortcuts act on: play head, loop locators,
// range selection, horizontal + vertical zoom, snap, and the nine toolbar
// tools.  It renders the decoded waveform of whatever preview player is
// currently registered (ResultPage / TweakPage), or a plain time ruler when
// the decode is unavailable.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  useWorkspaceStore, getTransportElement, snapTime, TOOL_LABELS, type ToolId,
} from '../../stores/workspaceStore.js';
import { useAppStore } from '../../stores/appStore.js';
import { useAudioStore } from '../../stores/audioStore.js';
import { useWaveformPeaks } from '../../hooks/useWaveformPeaks.js';
import { resumeSharedContext } from '../../audio/shared-audio-graph.js';
import { fmtTime } from '../../shortcuts/commands.js';
import { visibleWindow, ratioInWindow, timeAtRatio } from './transport-view.js';

const BUCKETS = 900;

const TOOL_ORDER: ToolId[] = ['select', 'range', 'split', 'glue', 'erase', 'zoom', 'mute', 'draw', 'scrub'];

function IconButton({
  active, title, onClick, children, danger,
}: {
  active?: boolean; title: string; onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode; danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`no-drag h-7 min-w-[28px] px-2 rounded-md text-[11px] font-medium
                  border transition-colors flex items-center justify-center gap-1
                  ${active
                    ? danger
                      ? 'bg-red-600/25 border-red-500/50 text-red-300'
                      : 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
                    : 'bg-zinc-900/60 border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'}`}
    >
      {children}
    </button>
  );
}

export default function DawTransportBar() {
  const notify = useAppStore((s) => s.notify);
  const options = useAudioStore((s) => s.options);
  const updateOptions = useAudioStore((s) => s.updateOptions);

  const tool        = useWorkspaceStore((s) => s.tool);
  const setTool     = useWorkspaceStore((s) => s.setTool);
  const snapEnabled = useWorkspaceStore((s) => s.snapEnabled);
  const toggleSnap  = useWorkspaceStore((s) => s.toggleSnap);
  const loop        = useWorkspaceStore((s) => s.loop);
  const loopEnabled = useWorkspaceStore((s) => s.loopEnabled);
  const selection   = useWorkspaceStore((s) => s.selection);
  const setSelection = useWorkspaceStore((s) => s.setSelection);
  const zoomH       = useWorkspaceStore((s) => s.zoomH);
  const zoomV       = useWorkspaceStore((s) => s.zoomV);
  const isPlaying   = useWorkspaceStore((s) => s.isPlaying);
  const positionSec = useWorkspaceStore((s) => s.positionSec);
  const durationSec = useWorkspaceStore((s) => s.durationSec);
  const muted       = useWorkspaceStore((s) => s.muted);
  const transportSrc = useWorkspaceStore((s) => s.transportSrc);
  const snapMarkers = useWorkspaceStore((s) => s.snapMarkers);

  const peaks = useWaveformPeaks(transportSrc, BUCKETS);
  const laneRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<null | { anchorSec: number; mode: 'range' | 'scrub' }>(null);

  const view = useMemo(
    () => visibleWindow(durationSec, positionSec, zoomH),
    [durationSec, positionSec, zoomH],
  );
  const pctOf = useCallback((sec: number) => ratioInWindow(sec, view) * 100, [view]);

  const secAt = useCallback((clientX: number): number => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    return snapTime(timeAtRatio((clientX - rect.left) / rect.width, view));
  }, [view]);

  const seek = useCallback((sec: number) => {
    const el = getTransportElement();
    if (!el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : durationSec;
    el.currentTime = Math.max(0, dur > 0 ? Math.min(sec, dur) : sec);
    useWorkspaceStore.getState().setTransportState({ positionSec: el.currentTime });
  }, [durationSec]);

  const togglePlay = useCallback(() => {
    const el = getTransportElement();
    if (!el) { notify('재생할 프리뷰가 없습니다', 'warning'); return; }
    if (el.paused) { void resumeSharedContext(); void el.play(); } else { el.pause(); }
  }, [notify]);

  // ── Lane interaction — behaviour depends on the active tool ─────────────
  const onLaneMouseDown = useCallback((e: React.MouseEvent) => {
    if (durationSec <= 0) return;
    const at = secAt(e.clientX);
    const ws = useWorkspaceStore.getState();

    // Shift+drag is the universal "make a range" gesture, whatever the tool.
    if (e.shiftKey || tool === 'range') {
      setSelection({ startSec: at, endSec: at });
      setDragging({ anchorSec: at, mode: 'range' });
      return;
    }

    switch (tool) {
      case 'select':
        seek(at);
        return;
      case 'scrub':
        seek(at);
        setDragging({ anchorSec: at, mode: 'scrub' });
        return;
      case 'split': {
        const range = ws.selection ?? (ws.loop.endSec > ws.loop.startSec ? ws.loop : null);
        if (!range || at <= range.startSec || at >= range.endSec) {
          notify('자를 구간 안을 클릭하세요 (2번 툴로 구간 선택)', 'warning');
          return;
        }
        const head = { startSec: range.startSec, endSec: at };
        setSelection(head);
        if (ws.loopEnabled) ws.setLoop(head);
        notify(`구간 분할 — ${fmtTime(head.startSec)} ~ ${fmtTime(head.endSec)}`);
        return;
      }
      case 'erase':
        setSelection(null);
        ws.setLoopEnabled(false);
        ws.setLoop({ startSec: 0, endSec: 0 });
        notify('선택 / 루프 구간을 지웠습니다');
        return;
      case 'zoom':
        if (e.altKey) ws.zoomOutH(); else ws.zoomInH();
        seek(at);
        return;
      case 'mute':
        ws.setMuted(!ws.muted);
        notify(ws.muted ? '뮤트 OFF' : '뮤트 ON');
        return;
      case 'glue':
      case 'draw':
        notify(`${TOOL_LABELS[tool]} 툴은 이벤트/오토메이션 트랙이 있어야 동작합니다`, 'warning');
        return;
      default:
        return;
    }
  }, [durationSec, secAt, tool, seek, setSelection, notify]);

  const onLaneMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const at = secAt(e.clientX);
    if (dragging.mode === 'range') {
      setSelection({ startSec: Math.min(dragging.anchorSec, at), endSec: Math.max(dragging.anchorSec, at) });
    } else {
      seek(at);
    }
  }, [dragging, secAt, setSelection, seek]);

  const endDrag = useCallback(() => { setDragging(null); }, []);

  // ── Waveform bars for the visible window ────────────────────────────────
  const bars = useMemo(() => {
    const data = peaks.data;
    if (!data || durationSec <= 0) return null;
    const total = data.length;
    const from = Math.floor((view.startSec / durationSec) * total);
    const to   = Math.max(from + 1, Math.ceil((view.endSec / durationSec) * total));
    const slice: number[] = [];
    const target = 220;
    const stepSize = Math.max(1, Math.floor((to - from) / target));
    for (let i = from; i < to; i += stepSize) {
      let max = 0;
      for (let j = i; j < Math.min(i + stepSize, to); j++) {
        const v = data[j] ?? 0;
        if (v > max) max = v;
      }
      slice.push(max);
    }
    return slice;
  }, [peaks.data, durationSec, view.startSec, view.endSec]);

  const rtBypass = options.rt?.masterBypass ?? false;

  return (
    <div
      className="border-t border-zinc-800 bg-[#101018]/95 backdrop-blur px-3 py-2 space-y-2 select-none"
      onMouseLeave={endDrag}
      onMouseUp={endDrag}
    >
      {/* ── Row 1: transport + state readouts ───────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <IconButton title="재생 위치 0점 (Home / Numpad .)"
          onClick={() => seek(loopEnabled ? loop.startSec : 0)}>⏮</IconButton>
        <IconButton title="재생 / 정지 (Space)" active={isPlaying} onClick={togglePlay}>
          {isPlaying ? '❚❚' : '▶'}
        </IconButton>
        <IconButton title="정지" onClick={() => { getTransportElement()?.pause(); seek(loopEnabled ? loop.startSec : 0); }}>■</IconButton>
        <IconButton title="루프 on/off (Numpad /)" active={loopEnabled}
          onClick={() => useWorkspaceStore.getState().toggleLoop()}>LOOP</IconButton>
        <IconButton title="좌측 루프 포인터 (Numpad 1)" onClick={() => seek(loop.startSec)}>L◂</IconButton>
        <IconButton title="우측 루프 포인터 (Numpad 2)" onClick={() => seek(loop.endSec)}>▸R</IconButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <IconButton title="솔로 — 원본(마스터 체인 바이패스) (S) · Alt+클릭으로 전체 해제"
          active={rtBypass}
          onClick={(e) => {
            const rt = options.rt ?? {};
            if (e.altKey) {
              updateOptions({ rt: { ...rt, masterBypass: false } });
              useWorkspaceStore.getState().setMuted(false);
              notify('모든 Solo / Mute 해제');
              return;
            }
            updateOptions({ rt: { ...rt, masterBypass: !rtBypass } });
          }}>S</IconButton>
        <IconButton title="뮤트 (M) · Alt+클릭으로 전체 해제" active={muted} danger
          onClick={(e) => {
            const ws = useWorkspaceStore.getState();
            if (e.altKey) {
              ws.setMuted(false);
              updateOptions({ rt: { ...(options.rt ?? {}), masterBypass: false } });
              notify('모든 Solo / Mute 해제');
              return;
            }
            ws.setMuted(!ws.muted);
          }}>M</IconButton>
        <IconButton title="스냅 on/off (J)" active={snapEnabled} onClick={() => toggleSnap()}>
          SNAP
        </IconButton>

        <span className="w-px h-5 bg-zinc-800 mx-1" />

        <IconButton title="가로 축소 (G)" onClick={() => useWorkspaceStore.getState().zoomOutH()}>G −</IconButton>
        <IconButton title="가로 확대 (H)" onClick={() => useWorkspaceStore.getState().zoomInH()}>H +</IconButton>
        <span className="text-[10px] font-mono text-zinc-600 px-1">×{zoomH}</span>
        <IconButton title="세로 축소 (Shift+G)" onClick={() => useWorkspaceStore.getState().zoomOutV()}>⇕ −</IconButton>
        <IconButton title="세로 확대 (Shift+H)" onClick={() => useWorkspaceStore.getState().zoomInV()}>⇕ +</IconButton>
        <span className="text-[10px] font-mono text-zinc-600 px-1">×{zoomV.toFixed(1)}</span>

        <div className="flex-1" />

        <span className="text-[11px] font-mono text-zinc-300">{fmtTime(positionSec)}</span>
        <span className="text-[11px] font-mono text-zinc-700">/ {fmtTime(durationSec)}</span>
      </div>

      {/* ── Row 2: waveform lane ────────────────────────────────────────── */}
      <div
        ref={laneRef}
        onMouseDown={onLaneMouseDown}
        onMouseMove={onLaneMouseMove}
        className={`relative h-16 rounded-md bg-zinc-900/70 border border-zinc-800 overflow-hidden
                    ${tool === 'range' || tool === 'scrub' ? 'cursor-col-resize' : 'cursor-pointer'}`}
      >
        {/* Snap markers (section boundaries) */}
        {snapEnabled && snapMarkers.map((m) => {
          const left = pctOf(m);
          if (left < 0 || left > 100) return null;
          return (
            <div key={`mark-${m}`} className="absolute top-0 bottom-0 w-px bg-zinc-700/70"
                 style={{ left: `${left}%` }} />
          );
        })}

        {/* Loop band */}
        {loop.endSec > loop.startSec && (
          <div
            className={`absolute top-0 bottom-0 ${loopEnabled ? 'bg-indigo-500/15 border-x border-indigo-400/60' : 'bg-zinc-500/10 border-x border-zinc-600/50'}`}
            style={{
              left:  `${Math.max(0, pctOf(loop.startSec))}%`,
              width: `${Math.min(100, pctOf(loop.endSec)) - Math.max(0, pctOf(loop.startSec))}%`,
            }}
          />
        )}

        {/* Selection band */}
        {selection && selection.endSec > selection.startSec && (
          <div
            className="absolute top-0 bottom-0 bg-emerald-400/12 border-x border-emerald-400/50"
            style={{
              left:  `${Math.max(0, pctOf(selection.startSec))}%`,
              width: `${Math.min(100, pctOf(selection.endSec)) - Math.max(0, pctOf(selection.startSec))}%`,
            }}
          />
        )}

        {/* Waveform */}
        <div className="absolute inset-0 flex items-center gap-px px-px pointer-events-none">
          {bars
            ? bars.map((v, i) => (
                <div
                  key={i}
                  className="flex-1 bg-zinc-500/70 rounded-[1px]"
                  style={{ height: `${Math.min(100, Math.max(2, v * zoomV * 90))}%` }}
                />
              ))
            : (
              <div className="w-full text-center text-[10px] font-mono text-zinc-700">
                {peaks.decoding ? '파형 디코딩 중…' : transportSrc ? '파형 없음 — 시간 눈금만 표시' : '재생 중인 프리뷰 없음'}
              </div>
            )}
        </div>

        {/* Play head */}
        {durationSec > 0 && (
          <div className="absolute top-0 bottom-0 w-px bg-red-400 pointer-events-none"
               style={{ left: `${Math.min(100, Math.max(0, pctOf(positionSec)))}%` }} />
        )}
      </div>

      {/* ── Row 3: tool bar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap">
        {TOOL_ORDER.map((t, i) => (
          <button
            key={t}
            type="button"
            title={`${i + 1} · ${TOOL_LABELS[t]}`}
            onClick={() => setTool(t)}
            className={`no-drag h-6 px-2 rounded text-[10px] border transition-colors
                        ${tool === t
                          ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300'
                          : 'bg-zinc-900/60 border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
          >
            <span className="font-mono mr-1 opacity-60">{i + 1}</span>{TOOL_LABELS[t]}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-zinc-600">
          {selection
            ? `선택 ${fmtTime(selection.startSec)} ~ ${fmtTime(selection.endSec)}`
            : loop.endSec > loop.startSec
              ? `루프 ${fmtTime(loop.startSec)} ~ ${fmtTime(loop.endSec)}`
              : '구간 없음 — 2번 툴 드래그 또는 Shift+드래그'}
        </span>
      </div>
    </div>
  );
}
