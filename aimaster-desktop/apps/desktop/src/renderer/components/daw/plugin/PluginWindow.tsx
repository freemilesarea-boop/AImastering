// One floating plugin window.
//
// Draggable by its title bar, several open at once, and alive while the
// transport runs: every knob movement goes into the graph on the way past, so
// you set a compressor by listening to it rather than by reading it.
//
// Parameter changes are transient until the pointer comes up.  A two-second
// sweep of a threshold is one undo step, which is what an engineer means by
// "undo that" — not four hundred.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { usePluginWindowStore, type PluginWindowState } from '../../../stores/pluginWindowStore.js';
import { findTrack, setInsert } from '../../../daw/model/session-ops.js';
import { findPlugin } from '../../../daw/engine/plugins.js';
import { dawRuntime } from '../../../daw/engine/daw-runtime.js';
import { premium } from '../../../theme/premium.js';
import Knob from './Knob.js';
import PluginVisual from './PluginVisual.js';

const VISUAL_WIDTH = 300;
const VISUAL_HEIGHT = 132;

/** The insert in this slot, for asking the engine what it is doing. */
function insertIdOf(
  session: ReturnType<typeof useDawStore.getState>['session'],
  trackId: string, slot: number,
): string | null {
  const track = findTrack(session, trackId);
  return track?.inserts.find((i) => i.slot === slot)?.id ?? null;
}

/** Frequency and time knobs feel wrong linear — an octave is a ratio. */
function curveFor(unit: string, min: number): 'linear' | 'log' {
  return (unit === 'Hz' || unit === 'ms') && min > 0 ? 'log' : 'linear';
}

export default function PluginWindow({ window: win }: { window: PluginWindowState }) {
  const session = useDawStore((s) => s.session);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit = useDawStore((s) => s.commitEdit);
  const apply = useDawStore((s) => s.apply);
  const close = usePluginWindowStore((s) => s.close);
  const focus = usePluginWindowStore((s) => s.focus);
  const move = usePluginWindowStore((s) => s.move);

  const track = findTrack(session, win.trackId);
  const insert = track?.inserts.find((i) => i.slot === win.slot);
  const descriptor = insert ? findPlugin(insert.pluginId) : undefined;

  // ── Live level, so the picture shows this performance ────────────────────
  const [level, setLevel] = useState(0);
  const [reduction, setReduction] = useState<number | null>(null);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const insertId = insertIdOf(session, win.trackId, win.slot);
  useEffect(() => {
    if (!isPlaying) { setLevel(0); setReduction(null); return; }
    const timer = setInterval(() => {
      setLevel(dawRuntime.meterLevels().get(win.trackId) ?? 0);
      setReduction(insertId ? dawRuntime.insertReduction(win.trackId, insertId) : null);
    }, 60);
    return () => clearInterval(timer);
  }, [isPlaying, win.trackId, insertId]);

  // ── Dragging the window ──────────────────────────────────────────────────
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onTitleDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    focus(win.id);
    drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
    setDragging(true);
  }, [focus, win.id, win.x, win.y]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => {
      const state = drag.current;
      if (!state) return;
      // Keep the title bar reachable: a window dragged off the top edge can
      // never be dragged back.
      move(win.id, Math.max(-160, e.clientX - state.dx), Math.max(0, e.clientY - state.dy));
    };
    const onUp = (): void => { drag.current = null; setDragging(false); };
    globalThis.addEventListener('pointermove', onMove);
    globalThis.addEventListener('pointerup', onUp);
    return () => {
      globalThis.removeEventListener('pointermove', onMove);
      globalThis.removeEventListener('pointerup', onUp);
    };
  }, [dragging, move, win.id]);

  // The insert or its track went away while the window was open.
  useEffect(() => {
    if (!track || !insert) close(win.id);
  }, [track, insert, close, win.id]);
  if (!track || !insert || !descriptor) return null;

  const params: Record<string, number> = {};
  for (const def of descriptor.params) {
    params[def.id] = insert.params[def.id] ?? def.default;
  }

  const setParam = (id: string, value: number): void => {
    applyTransient((s) => setInsert(s, win.trackId, {
      ...insert,
      params: { ...insert.params, [id]: value },
      latencySamples: descriptor.latencyFor(
        { ...params, [id]: value }, session.sampleRate,
      ),
    }));
  };

  const toggleBypass = (): void => {
    apply((s) => setInsert(s, win.trackId, { ...insert, bypass: !insert.bypass }));
  };

  const resetAll = (): void => {
    apply((s) => setInsert(s, win.trackId, { ...insert, params: {} }));
  };

  return (
    <div
      onPointerDown={() => focus(win.id)}
      className="fixed rounded-xl overflow-hidden"
      style={{
        left: win.x, top: win.y, zIndex: 200 + win.z,
        width: VISUAL_WIDTH + 28,
        background: premium.surface.frame,
        border: `1px solid ${insert.bypass ? 'rgba(120,120,140,0.35)' : premium.accent.deep}`,
        boxShadow: premium.shadow.panel,
        opacity: insert.bypass ? 0.72 : 1,
      }}
    >
      {/* Title bar */}
      <div
        onPointerDown={onTitleDown}
        className="flex items-center gap-2 px-3 h-9 select-none"
        style={{
          cursor: dragging ? 'grabbing' : 'grab',
          background: premium.gradient.frame,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: track.color }}
        />
        <span
          className="text-[11px] truncate"
          style={{ color: premium.text.muted }}
        >{track.name}</span>
        <span className="text-[11px] opacity-40">/</span>
        <span
          className="text-[12px] font-medium truncate flex-1"
          style={{ fontFamily: premium.type.display, color: premium.accent.light }}
        >{descriptor.name}</span>

        <button
          onClick={toggleBypass}
          title="바이패스 — 원본과 비교"
          className="h-5 px-1.5 rounded text-[9px] tracking-wide border"
          style={{
            borderColor: insert.bypass ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.14)',
            color: insert.bypass ? 'rgb(248,113,113)' : premium.text.muted,
          }}
        >BYP</button>
        <button
          onClick={resetAll}
          title="모든 파라미터를 기본값으로"
          className="h-5 px-1.5 rounded text-[9px] border"
          style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
        >RESET</button>
        <button
          onClick={() => close(win.id)}
          title="닫기"
          className="h-5 w-5 rounded text-[12px] leading-none"
          style={{ color: premium.text.muted }}
        >×</button>
      </div>

      <div className="p-3.5 flex flex-col gap-3">
        <PluginVisual
          pluginId={insert.pluginId}
          params={params}
          bypassed={insert.bypass}
          level={level}
          reduction={reduction}
          width={VISUAL_WIDTH}
          height={VISUAL_HEIGHT}
        />

        <div className="flex flex-wrap gap-x-1 gap-y-2 justify-center">
          {descriptor.params.map((def) => (
            <Knob
              key={def.id}
              label={def.name}
              value={params[def.id] ?? def.default}
              min={def.min}
              max={def.max}
              defaultValue={def.default}
              unit={def.unit}
              curve={curveFor(def.unit, def.min)}
              onChange={(v) => setParam(def.id, v)}
              onCommit={commitEdit}
            />
          ))}
        </div>

        {descriptor.offline && (
          <p className="text-[10px] text-center" style={{ color: 'rgb(251,191,36)' }}>
            OFFLINE — 이 장치는 바운스/렌더에서 적용됩니다
          </p>
        )}
      </div>
    </div>
  );
}
