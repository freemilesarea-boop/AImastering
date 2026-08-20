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
import { descriptorFor } from '../../../daw/engine/external-device.js';
import { defaultParams } from '../../../daw/engine/plugins.js';
import { presetGroups, resolvePreset } from '../../../daw/engine/plugin-presets.js';
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

/**
 * A parameter that is a list of things is not a knob.
 *
 * Thirty-one rooms on a knob means dragging blind through thirty of them to
 * reach the one you want.  Anything with `choices` gets a picker instead.
 */
function isChoice(def: { choices?: readonly string[] }): boolean {
  return def.choices !== undefined && def.choices.length > 0;
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
  const descriptor = insert ? descriptorFor(insert) : undefined;

  // ── Live level, so the picture shows this performance ────────────────────
  const [level, setLevel] = useState(0);
  const [reduction, setReduction] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<{ lufs: number; peakDb: number } | null>(null);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const insertId = insertIdOf(session, win.trackId, win.slot);
  useEffect(() => {
    if (!isPlaying) { setLevel(0); setReduction(null); setAnalysis(null); return; }
    const timer = setInterval(() => {
      setLevel(dawRuntime.meterLevels().get(win.trackId) ?? 0);
      setReduction(insertId ? dawRuntime.insertReduction(win.trackId, insertId) : null);
      setAnalysis(insertId ? dawRuntime.insertAnalysis(win.trackId, insertId) : null);
    }, 60);
    return () => clearInterval(timer);
  }, [isPlaying, win.trackId, insertId]);

  // ── Presets ──────────────────────────────────────────────────────────────
  //
  // Which preset is loaded is deliberately NOT stored in the session: the
  // moment you move a knob it is no longer that preset, and a session that
  // still claimed it was would be lying the next time it opened.
  const [loadedPreset, setLoadedPreset] = useState<string>('');

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
    setLoadedPreset('');
    applyTransient((s) => setInsert(s, win.trackId, {
      ...insert,
      params: { ...insert.params, [id]: value },
      latencySamples: descriptor.latencyFor(
        { ...params, [id]: value }, session.sampleRate,
      ),
    }));
  };

  // A picker's change is a whole edit, not a drag: commit it directly.
  const commitParam = (id: string, value: number): void => {
    setLoadedPreset('');
    apply((s) => setInsert(s, win.trackId, {
      ...insert,
      params: { ...insert.params, [id]: value },
      latencySamples: descriptor.latencyFor({ ...params, [id]: value }, session.sampleRate),
    }));
  };

  const groups = presetGroups(insert.pluginId);
  const loadPreset = (presetId: string): void => {
    const preset = groups.flatMap((g) => g.presets).find((entry) => entry.id === presetId);
    if (!preset) return;
    const next = resolvePreset(preset, defaultParams(insert.pluginId));
    setLoadedPreset(preset.id);
    apply((s) => setInsert(s, win.trackId, {
      ...insert,
      params: next,
      latencySamples: descriptor.latencyFor(next, session.sampleRate),
    }));
  };
  const activePreset = groups.flatMap((g) => g.presets).find((entry) => entry.id === loadedPreset);

  const toggleBypass = (): void => {
    apply((s) => setInsert(s, win.trackId, { ...insert, bypass: !insert.bypass }));
  };

  const resetAll = (): void => {
    setLoadedPreset('');
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

      {/* Somewhere to start.  Only shown where there is somewhere to start. */}
      {groups.length > 0 && (
        <div
          className="px-3.5 py-2 flex flex-col gap-1"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[9px] tracking-wide shrink-0" style={{ color: premium.text.faint }}>
              프리셋
            </span>
            <select
              value={loadedPreset}
              onChange={(e) => loadPreset(e.target.value)}
              className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
              style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}
            >
              <option value="">— 직접 설정 —</option>
              {groups.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {activePreset && (
            <span className="text-[9px] leading-relaxed" style={{ color: premium.text.faint }}>
              {activePreset.note}
            </span>
          )}
        </div>
      )}

      <div className="p-3.5 flex flex-col gap-3">
        <PluginVisual
          pluginId={insert.pluginId}
          params={params}
          bypassed={insert.bypass}
          level={level}
          reduction={reduction}
          analysis={analysis}
          width={VISUAL_WIDTH}
          height={VISUAL_HEIGHT}
        />

        {descriptor.params.filter(isChoice).map((def) => {
          const index = Math.round(params[def.id] ?? def.default);
          return (
            <div key={def.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[9px] tracking-wide shrink-0 w-10" style={{ color: premium.text.faint }}>
                  {def.name}
                </span>
                <select
                  value={index}
                  onChange={(e) => commitParam(def.id, Number(e.target.value))}
                  className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
                  style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  {def.choices!.map((label, i) => (
                    <option key={label} value={def.min + i}>{label}</option>
                  ))}
                </select>
              </div>
              {def.choiceNotes?.[index - def.min] && (
                <span className="text-[9px] leading-relaxed" style={{ color: premium.text.faint }}>
                  {def.choiceNotes[index - def.min]}
                </span>
              )}
            </div>
          );
        })}

        <div className="flex flex-wrap gap-x-1 gap-y-2 justify-center">
          {descriptor.params.filter((def) => !isChoice(def)).map((def) => (
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

        {descriptor.freeRunning && (
          <p className="text-[10px] text-center" style={{ color: premium.text.faint }}>
            LFO 위상은 재생 위치가 아니라 오디오 컨텍스트를 따릅니다 — 바운스가
            모니터링과 같은 위상에서 시작하지 않습니다
          </p>
        )}
        {descriptor.offline && (
          <p className="text-[10px] text-center" style={{ color: 'rgb(251,191,36)' }}>
            OFFLINE — 이 장치는 바운스/렌더에서 적용됩니다
          </p>
        )}
      </div>
    </div>
  );
}
