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
import { resolvePreset } from '../../../daw/engine/plugin-presets.js';
import { partitionGenre } from '../../../daw/engine/plugin-presets-genre.js';
import {
  allPresetGroups, canSaveUserPreset, deleteUserPreset, exportUserPresets,
  importUserPresets, isUserPresetId, overwriteUserPreset, saveUserPreset, describeImport,
} from '../../../daw/engine/user-presets.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useAutomationStore } from '../../../stores/automationStore.js';
import { automatableParamsOf } from '../../../daw/edit/automation-lanes.js';
import { adviseFor, canAdvise, LOW_CONFIDENCE } from '../../../daw/ai/plugin-advice.js';
import { describeWindow, profileForInsert } from '../../../daw/ai/advice-runner.js';
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
      // What arrives AT this device, not what leaves the channel.  The channel
      // meter is post-fader and post-everything; reading it here put the dot
      // on the input axis using an output number, so the picture and the GR
      // meter next to it were describing two different signals.
      const arriving = insertId ? dawRuntime.insertInputLevel(win.trackId, insertId) : null;
      setLevel(arriving ?? dawRuntime.meterLevels().get(win.trackId) ?? 0);
      setReduction(insertId ? dawRuntime.insertReduction(win.trackId, insertId) : null);
      setAnalysis(insertId ? dawRuntime.insertAnalysis(win.trackId, insertId) : null);
    }, 60);
    return () => clearInterval(timer);
  }, [isPlaying, win.trackId, insertId]);

  // ── AI 추천 ──────────────────────────────────────────────────────────────
  //
  // Renders the audio that ARRIVES at this insert, measures it, and asks the
  // device's advisor what it should be.  One press, one undo step — and a
  // line saying what it read, because a setting you cannot argue with is a
  // setting you cannot trust.
  const [advising, setAdvising] = useState(false);
  const [advice, setAdvice] = useState<null | {
    headline: string; evidence: string[]; confidence: number; window: string;
  }>(null);
  const [adviceError, setAdviceError] = useState<string | null>(null);

  // ── Presets ──────────────────────────────────────────────────────────────
  //
  // Which preset is loaded is deliberately NOT stored in the session: the
  // moment you move a knob it is no longer that preset, and a session that
  // still claimed it was would be lying the next time it opened.
  const [loadedPreset, setLoadedPreset] = useState<string>('');
  // The preset store lives outside React, so a save or a delete has to say so.
  const [presetTick, setPresetTick] = useState(0);
  const [savingName, setSavingName] = useState<string | null>(null);
  const notify = useAppStore((s) => s.notify);

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

  /** The automation target for a knob, when the device can ramp that knob. */
  const targetFor = (id: string): { kind: 'plugin'; insertId: string; paramId: string } | null =>
    automatableParamsOf(insert).some((p) => p.id === id)
      ? { kind: 'plugin', insertId: insert.id, paramId: id }
      : null;

  const setParam = (id: string, value: number): void => {
    setLoadedPreset('');
    const target = targetFor(id);
    if (target) {
      // An automatable knob is ridden, not just set: `grab` is a no-op unless
      // the transport is rolling in a writing mode, and `move` applies the
      // value either way.  No automatable parameter changes the device's
      // reported latency (the selftest holds every device to that), so this
      // path does not need to recompute it.
      const automation = useAutomationStore.getState();
      automation.grab(win.trackId, target);
      automation.move(win.trackId, target, value);
      return;
    }
    applyTransient((s) => setInsert(s, win.trackId, {
      ...insert,
      params: { ...insert.params, [id]: value },
      latencySamples: descriptor.latencyFor(
        { ...params, [id]: value }, session.sampleRate,
      ),
    }));
  };

  /** Pointer up: a ridden knob ends its pass, an ordinary one ends its edit. */
  const commitParamEdit = (id: string): void => {
    const target = targetFor(id);
    if (target) { useAutomationStore.getState().release(win.trackId, target); return; }
    commitEdit();
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

  // `presetTick` is read so the list rebuilds after a save, an overwrite, a
  // delete or an import — none of which go through React state.
  void presetTick;
  const groups = allPresetGroups(insert.pluginId);
  // The ten genres get their own row of chips; everything else stays in the
  // dropdown.  See `partitionGenre` for why they are not the same control.
  const { genre: genrePresets, rest: menuGroups } = partitionGenre(groups);
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
  const userPresetActive = activePreset !== undefined && isUserPresetId(activePreset.id);
  // A third-party device reached through the external host declares no
  // parameters here, so there is nothing to validate a preset against.
  const canSave = !insert.external && canSaveUserPreset(insert.pluginId);

  // Saving stores the FULL current parameter map — `params`, which already has
  // the device's default filled in for anything the insert never set.  A user
  // preset means "this exact sound", not "the bits I happened to move".
  const commitSave = (): void => {
    const name = savingName ?? '';
    const result = saveUserPreset({ pluginId: insert.pluginId, name, params });
    if (!result.ok) { notify(result.reason, 'warning'); return; }
    setSavingName(null);
    setLoadedPreset(result.preset.id);
    setPresetTick((n) => n + 1);
    notify(`프리셋 "${result.preset.name}" 저장`);
  };

  const overwriteActive = (): void => {
    if (!activePreset) return;
    const result = overwriteUserPreset(activePreset.id, params);
    if (!result.ok) { notify(result.reason, 'warning'); return; }
    setPresetTick((n) => n + 1);
    notify(`"${result.preset.name}" 덮어썼습니다`);
  };

  const deleteActive = (): void => {
    if (!activePreset) return;
    const name = activePreset.name;
    if (!deleteUserPreset(activePreset.id)) { notify('프리셋을 지울 수 없습니다', 'warning'); return; }
    setLoadedPreset('');
    setPresetTick((n) => n + 1);
    notify(`"${name}" 삭제`);
  };

  // Export and import go through a real file dialog: localStorage does not
  // survive a reinstall, and a sound worth naming is worth keeping.
  const exportPresets = async (): Promise<void> => {
    const api = globalThis.window?.electronAPI;
    if (!api) { notify('파일 저장을 사용할 수 없습니다', 'warning'); return; }
    const json = exportUserPresets();
    if (JSON.parse(json).items.length === 0) { notify('내보낼 프리셋이 없습니다', 'warning'); return; }
    try {
      const dest = await api.invoke('daw:presets-export', json) as string | null;
      if (dest) notify(`프리셋을 내보냈습니다 — ${dest}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const importPresets = async (): Promise<void> => {
    const api = globalThis.window?.electronAPI;
    if (!api) { notify('파일 열기를 사용할 수 없습니다', 'warning'); return; }
    try {
      const json = await api.invoke('daw:presets-import') as string | null;
      if (!json) return;
      const report = importUserPresets(json);
      setPresetTick((n) => n + 1);
      notify(describeImport(report), report.added === 0 ? 'warning' : 'info');
      for (const reason of report.reasons.slice(0, 3)) notify(reason, 'warning');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const runAdvice = async (): Promise<void> => {
    if (!insert) return;
    setAdvising(true);
    setAdviceError(null);
    try {
      const { profile, window } = await profileForInsert({
        session: useDawStore.getState().session,
        trackId: win.trackId,
        slot: insert.slot,
        selection: useDawStore.getState().selection,
      });
      const result = adviseFor(insert.pluginId, profile);
      if (!result.ok) {
        setAdvice(null);
        setAdviceError(result.reason);
        return;
      }
      const next = result.advice.params;
      apply((s) => setInsert(s, win.trackId, {
        ...insert,
        params: next,
        latencySamples: descriptor.latencyFor(next, session.sampleRate),
      }));
      setLoadedPreset('');
      setAdvice({
        headline: result.advice.headline,
        evidence: result.advice.evidence,
        confidence: result.advice.confidence,
        window: describeWindow(window),
      });
    } catch (err) {
      setAdvice(null);
      setAdviceError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdvising(false);
    }
  };

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

        {canAdvise(insert.pluginId) && (
          <button
            onClick={() => void runAdvice()}
            disabled={advising}
            title="이 인서트에 도착하는 오디오를 분석해서 값을 추천합니다"
            className="h-5 px-1.5 rounded text-[9px] tracking-wide border"
            style={{
              borderColor: premium.accent.deep,
              color: advising ? premium.text.muted : premium.accent.base,
              background: advising ? 'transparent' : 'rgba(198,167,104,0.10)',
            }}
          >{advising ? '분석 중…' : 'AI'}</button>
        )}
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

      {/* Somewhere to start — and somewhere to keep what you arrived at.
          Always shown, including for a device with no factory presets: that
          is exactly the device you would want to save your own settings for. */}
      <div
        className="px-3.5 py-2 flex flex-col gap-1"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        {/* The ten genres, as a row you can read rather than a list you open.
            Every device has the same ten in the same order, so the row becomes
            a place on the window rather than a menu to search — after a few
            sessions you reach for 힙합 without looking. */}
        {genrePresets.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] tracking-wide shrink-0 pt-0.5"
                  style={{ color: premium.text.faint }}>장르</span>
            <div className="flex flex-wrap gap-1">
              {genrePresets.map((preset) => {
                const on = preset.id === loadedPreset;
                return (
                  <button
                    key={preset.id}
                    onClick={() => loadPreset(preset.id)}
                    title={preset.note}
                    className="h-[18px] px-1.5 rounded text-[9px] leading-none
                               transition-colors shrink-0"
                    style={{
                      border: `1px solid ${on ? premium.accent.deep : 'rgba(255,255,255,0.12)'}`,
                      background: on ? 'rgba(198,167,104,0.14)' : 'transparent',
                      color: on ? premium.accent.base : premium.text.muted,
                    }}
                  >{preset.name}</button>
                );
              })}
            </div>
          </div>
        )}

        {(menuGroups.length > 0 || canSave) && (
          <div className="flex items-center gap-2">
            <span className="text-[9px] tracking-wide shrink-0" style={{ color: premium.text.faint }}>
              프리셋
            </span>
            <select
              value={loadedPreset}
              onChange={(e) => loadPreset(e.target.value)}
              disabled={menuGroups.length === 0}
              className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
              style={{ color: premium.text.primary, border: '1px solid rgba(255,255,255,0.12)' }}
            >
              <option value="">— 직접 설정 —</option>
              {menuGroups.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {canSave && (
              <button
                onClick={() => setSavingName(savingName === null ? '' : null)}
                title="지금 설정을 내 프리셋으로 저장"
                className="h-6 w-6 rounded text-[13px] leading-none shrink-0"
                style={{
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: savingName === null ? premium.text.muted : premium.accent.base,
                }}
              >+</button>
            )}
          </div>
        )}

        {savingName !== null && (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={savingName}
              maxLength={60}
              placeholder="프리셋 이름"
              onChange={(e) => setSavingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSave();
                if (e.key === 'Escape') setSavingName(null);
              }}
              className="flex-1 h-6 px-1.5 text-[10px] rounded bg-transparent outline-none"
              style={{ color: premium.text.primary, border: `1px solid ${premium.accent.deep}` }}
            />
            <button onClick={commitSave} style={miniButton(premium.accent.base)}>저장</button>
            <button onClick={() => setSavingName(null)} style={miniButton(premium.text.muted)}>취소</button>
          </div>
        )}

        {activePreset?.note && (
          <span className="text-[9px] leading-relaxed" style={{ color: premium.text.faint }}>
            {activePreset.note}
          </span>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {userPresetActive && (
            <>
              <button onClick={overwriteActive} title="지금 설정으로 이 프리셋을 갱신합니다"
                      style={linkButton(premium.text.muted)}>덮어쓰기</button>
              <button onClick={deleteActive} title="이 프리셋을 지웁니다"
                      style={linkButton(premium.accent.danger)}>삭제</button>
            </>
          )}
          <button onClick={() => void exportPresets()} title="내 프리셋 전체를 파일로 저장합니다"
                  style={linkButton(premium.text.faint)}>내보내기</button>
          <button onClick={() => void importPresets()} title="프리셋 파일을 읽어 옵니다"
                  style={linkButton(premium.text.faint)}>가져오기</button>
        </div>
      </div>

      {(advice || adviceError) && (
        <div
          className="px-3.5 py-2 flex flex-col gap-1"
          style={{
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            background: adviceError ? 'rgba(212,106,106,0.06)' : 'rgba(198,167,104,0.06)',
          }}
        >
          {adviceError ? (
            <span className="text-[10px] leading-relaxed" style={{ color: premium.accent.danger }}>
              {adviceError}
            </span>
          ) : advice && (
            <>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-mono shrink-0" style={{ color: premium.accent.base }}>AI</span>
                <span className="text-[10px] leading-relaxed flex-1"
                      style={{ color: premium.text.secondary }}>{advice.headline}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {advice.evidence.map((item) => (
                  <span
                    key={item}
                    className="text-[9px] font-mono px-1 rounded"
                    style={{
                      border: '1px solid rgba(255,255,255,0.10)',
                      color: premium.text.muted,
                    }}
                  >{item}</span>
                ))}
              </div>
              <span className="text-[9px]" style={{ color: premium.text.faint }}>
                {advice.window} 구간 측정
                {advice.confidence < LOW_CONFIDENCE
                  ? ' · 출발점입니다, 정답이 아닙니다'
                  : ''}
              </span>
            </>
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
              onCommit={() => commitParamEdit(def.id)}
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

/** A small filled button for the save row. */
function miniButton(color: string): React.CSSProperties {
  return {
    height: 24, padding: '0 8px', borderRadius: 3, fontSize: 9.5,
    border: '1px solid rgba(255,255,255,0.14)', color, background: 'transparent',
  };
}

/** A text-weight action, so the row does not read as four more controls. */
function linkButton(color: string): React.CSSProperties {
  return {
    fontSize: 9, letterSpacing: '0.04em', color,
    background: 'transparent', border: 'none', padding: 0,
    textDecoration: 'underline', textUnderlineOffset: 2,
  };
}
