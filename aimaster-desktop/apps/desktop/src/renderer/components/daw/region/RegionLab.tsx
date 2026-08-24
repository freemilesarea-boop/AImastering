// The region lab — one cut piece, blown up, with its own chain.
//
// The gesture the whole thing exists for: take the scissors, cut a piece out
// of a track, double-click the piece, put a delay on THAT piece only.
//
// Three things this window has to get right, in order of how badly they hurt
// when they are wrong:
//
//   THE TAIL.  A delay on a ten-second piece rings past the ten seconds, and
//   if that ring is discarded at the seam the delay sounds unplugged.  So the
//   tail is not a checkbox in a menu — it is on the front of the window, with
//   the number the chain itself reported, and the waveform draws the zone it
//   will land in.
//
//   THE CONTEXT.  A piece drawn on its own tells you nothing about whether its
//   tail is about to collide with the next phrase.  The neighbours are drawn
//   either side, dimmed, so the collision is visible before it is audible.
//
//   THE WAY BACK.  Applying replaces the clip's audio with a rendered file.
//   The original file reference is kept on the clip, so 되돌리기 is a pointer
//   change rather than a re-render, and re-applying always starts from the
//   untouched audio instead of stacking a second pass on the first.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useRegionLabStore } from '../../../stores/regionLabStore.js';
import { clipEnd, createInsert, findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { PLUGINS, defaultParams, findPlugin } from '../../../daw/engine/plugins.js';
import { getMeta } from '../../../daw/engine/audio-cache.js';
import { chainTailSec, describeTail } from '../../../daw/model/plugin-tail.js';
import {
  applyRegionFx, bodyDurationSec, clipRegionFx, revertRegionFx,
} from '../../../daw/edit/region-fx.js';
import { liveAuxFor, makeRegionLive } from '../../../daw/edit/region-live.js';
import { presetsFor, resolvePreset } from '../../../daw/engine/plugin-presets.js';
import { partitionGenre } from '../../../daw/engine/plugin-presets-genre.js';
import { premium } from '../../../theme/premium.js';
import Knob from '../plugin/Knob.js';
import type { Clip, Insert, TailMode, Track } from '../../../daw/model/types.js';

/** Seconds of the neighbouring material drawn either side of the piece. */
const CONTEXT_SEC = 2;
const WAVE_W = 560;
const WAVE_H = 190;
const SLOTS = 4;

const curveFor = (unit: string, min: number): 'linear' | 'log' =>
  ((unit === 'Hz' || unit === 'ms' || unit === 's') && min > 0 ? 'log' : 'linear');

/**
 * Peak envelope over a window of a file, one value per column.
 *
 * Read from the peak SIDECAR rather than from samples, which is not a detail:
 * `decodeForDisplay` deliberately does not keep PCM resident — a sixteen-track
 * session would be gigabytes — so a file that has only been drawn on the
 * timeline has peaks and no samples at all.  Reading `getCached().buffer` here
 * drew nothing for every file the user had not played, which is most of them.
 */
function envelope(
  peaks: Float32Array, fileDuration: number, fromSec: number, toSec: number, columns: number,
): Float32Array {
  const out = new Float32Array(columns);
  if (fileDuration <= 0 || peaks.length === 0) return out;
  const step = (toSec - fromSec) / Math.max(1, columns);
  for (let c = 0; c < columns; c++) {
    const a = Math.max(0, Math.floor(((fromSec + c * step) / fileDuration) * peaks.length));
    const b = Math.min(peaks.length,
      Math.max(a + 1, Math.ceil(((fromSec + (c + 1) * step) / fileDuration) * peaks.length)));
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, peaks[i] ?? 0);
    out[c] = peak;
  }
  return out;
}

export default function RegionLab() {
  const target = useRegionLabStore((s) => s.target);
  const chain = useRegionLabStore((s) => s.chain);
  const tailMode = useRegionLabStore((s) => s.tailMode);
  const activeSlot = useRegionLabStore((s) => s.activeSlot);
  const busy = useRegionLabStore((s) => s.busy);
  const store = useRegionLabStore;

  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);

  const [pos, setPos] = useState({ x: 90, y: 80 });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const found = useMemo((): { track: Track; clip: Clip } | null => {
    if (!target) return null;
    const track = findTrack(session, target.trackId);
    if (!track) return null;
    const clip = trackClips(track).find((c) => c.id === target.clipId);
    return clip ? { track, clip } : null;
  }, [session, target]);

  // A piece that was deleted while its window was open must not leave the
  // window floating over nothing.
  useEffect(() => {
    if (target && !found) store.getState().close();
  }, [target, found, store]);

  const live = useMemo(() => chain.filter((i) => !i.bypass), [chain]);
  const tailSec = useMemo(
    () => chainTailSec(live, session.sampleRate), [live, session.sampleRate],
  );

  // ── Drawing ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !found) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { clip, track } = found;

    const body = bodyDurationSec(clip);
    const shown = tailMode === 'keep' ? tailSec : 0;
    const total = CONTEXT_SEC + body + Math.max(shown, 0.001) + CONTEXT_SEC;
    const pxPerSec = WAVE_W / total;
    const xOf = (secFromContextStart: number): number => secFromContextStart * pxPerSec;
    const mid = WAVE_H / 2;

    ctx.clearRect(0, 0, WAVE_W, WAVE_H);
    ctx.fillStyle = premium.surface.well;
    ctx.fillRect(0, 0, WAVE_W, WAVE_H);

    const drawClip = (c: Clip, opacity: number): void => {
      const meta = getMeta(c.fileId);
      if (!meta) return;
      // Where this clip sits, measured from the start of the drawn window.
      const windowStart = clip.startSec - CONTEXT_SEC;
      const left = c.startSec - windowStart;
      const right = clipEnd(c) - windowStart;
      const columns = Math.max(1, Math.round((right - left) * pxPerSec));
      const env = envelope(
        meta.peaks, meta.durationSec, c.offsetSec, c.offsetSec + c.durationSec, columns,
      );
      ctx.fillStyle = opacity >= 1 ? premium.accent.base : `rgba(255,255,255,${0.16 * opacity})`;
      for (let i = 0; i < columns; i++) {
        const peak = env[i] ?? 0;
        const x = Math.round(xOf(left)) + i;
        if (x < 0 || x >= WAVE_W) continue;
        const h = peak * (mid - 6);
        ctx.fillRect(x, mid - h, 1, Math.max(1, h * 2));
      }
    };

    // Neighbours first, dimmed — they are the context, not the subject.
    for (const other of trackClips(track)) {
      if (other.id === clip.id) continue;
      if (clipEnd(other) < clip.startSec - CONTEXT_SEC) continue;
      if (other.startSec > clipEnd(clip) + CONTEXT_SEC + shown) continue;
      drawClip(other, 0.9);
    }
    drawClip(clip, 1);

    // The piece's own boundaries.
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.5;
    for (const sec of [CONTEXT_SEC, CONTEXT_SEC + body]) {
      ctx.beginPath();
      ctx.moveTo(xOf(sec), 0);
      ctx.lineTo(xOf(sec), WAVE_H);
      ctx.stroke();
    }

    // The zone the tail will land in.
    if (shown > 0.001) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = premium.accent.deep;
      ctx.lineWidth = 1;
      ctx.strokeRect(xOf(CONTEXT_SEC + body) + 0.5, 0.5, xOf(shown) - 1, WAVE_H - 1);
      ctx.fillStyle = 'rgba(198,167,104,0.07)';
      ctx.fillRect(xOf(CONTEXT_SEC + body), 0, xOf(shown), WAVE_H);
      ctx.restore();
      ctx.fillStyle = premium.accent.base;
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(`꼬리 ${shown.toFixed(2)}초`, xOf(CONTEXT_SEC + body) + 5, 13);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(WAVE_W, mid); ctx.stroke();
  }, [found, tailSec, tailMode, session]);

  // ── Chain editing ──────────────────────────────────────────────────────────

  const setChain = useCallback((next: Insert[]) => {
    store.getState().setChain(next);
  }, [store]);

  const pick = useCallback((slot: number, pluginId: string) => {
    const rest = chain.filter((i) => i.slot !== slot);
    if (!pluginId) { setChain(rest.sort((a, b) => a.slot - b.slot)); return; }
    const descriptor = findPlugin(pluginId);
    if (!descriptor) return;
    const insert = createInsert(slot, pluginId, descriptor.name, {
      params: defaultParams(pluginId),
    });
    setChain([...rest, insert].sort((a, b) => a.slot - b.slot));
    store.getState().setActiveSlot(slot);
  }, [chain, setChain, store]);

  const setParam = useCallback((slot: number, paramId: string, value: number) => {
    setChain(chain.map((i) => (i.slot === slot
      ? { ...i, params: { ...i.params, [paramId]: value } } : i)));
  }, [chain, setChain]);

  const loadPreset = useCallback((slot: number, presetId: string) => {
    const insert = chain.find((i) => i.slot === slot);
    if (!insert) return;
    const preset = presetsFor(insert.pluginId).find((p) => p.id === presetId);
    if (!preset) return;
    setChain(chain.map((i) => (i.slot === slot
      ? { ...i, params: resolvePreset(preset, defaultParams(i.pluginId)) } : i)));
  }, [chain, setChain]);

  // ── Apply / revert ─────────────────────────────────────────────────────────

  const onApply = useCallback(() => {
    if (!target || !found || busy) return;
    if (live.length === 0) { notify('슬롯에 플러그인을 하나 넣으세요', 'warning'); return; }

    // `live` is not a render at all — it is an arrangement change, so it goes
    // through `apply` in one step and returns immediately.
    if (tailMode === 'live') {
      try {
        const result = makeRegionLive(session, target.trackId, target.clipId, live);
        apply(() => result.session);
        notify(result.message);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      }
      return;
    }

    store.getState().setBusy(true);
    void applyRegionFx(session, target.trackId, target.clipId, { inserts: live, tailMode })
      .then((result) => {
        apply(() => result.session);
        notify(result.message);
      })
      .catch((err: unknown) => {
        notify(err instanceof Error ? err.message : String(err), 'error');
      })
      .finally(() => store.getState().setBusy(false));
  }, [target, found, busy, live, tailMode, session, apply, notify, store]);

  const onRevert = useCallback(() => {
    if (!target) return;
    try {
      const result = revertRegionFx(session, target.trackId, target.clipId);
      apply(() => result.session);
      notify(result.message);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [target, session, apply, notify]);

  // ── Window drag ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!dragRef.current) return;
    const move = (e: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      // Clamped so the window cannot be dragged off the right edge, where the
      // chain and the 적용 button would be unreachable.
      const width = WAVE_W + 300;
      setPos({
        x: Math.min(Math.max(0, e.clientX - d.dx), Math.max(0, window.innerWidth - width)),
        y: Math.min(Math.max(0, e.clientY - d.dy), Math.max(0, window.innerHeight - 120)),
      });
    };
    const up = (): void => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  if (!target || !found) return null;
  const { clip } = found;
  const applied = clipRegionFx(clip);
  const liveAux = target ? liveAuxFor(session, target.trackId, target.clipId) : null;
  const active = chain.find((i) => i.slot === activeSlot) ?? null;
  const descriptor = active ? findPlugin(active.pluginId) : null;
  const genreChips = active
    ? partitionGenre(groupsFor(active.pluginId)).genre
    : [];

  return (
    <div
      className="fixed z-40 rounded-lg overflow-hidden select-none"
      style={{
        left: pos.x, top: pos.y, width: WAVE_W + 300,
        background: premium.surface.panel,
        border: `1px solid ${premium.surface.hairlineStrong}`,
        boxShadow: premium.shadow.panel,
      }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2.5 px-3.5 py-2 cursor-move"
        style={{ background: premium.surface.frame, borderBottom: `1px solid ${premium.surface.hairline}` }}
        onMouseDown={(e) => { dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; }}
      >
        <span className="w-[7px] h-[7px] rounded-full"
              style={{ background: premium.accent.base, boxShadow: `0 0 8px ${premium.accent.glow}` }} />
        <span style={{ fontFamily: premium.type.display, fontSize: 16 }}>구간 랩</span>
        <span className="text-[10.5px] font-mono" style={{ color: premium.text.muted }}>
          {found.track.name} · {fmt(clip.startSec)} – {fmt(clip.startSec + bodyDurationSec(clip))}
          {' · '}{bodyDurationSec(clip).toFixed(2)} 초
        </span>
        <span className="flex-1" />
        {applied && (
          <button onClick={onRevert} className="text-[10px] px-2 py-[3px] rounded"
                  style={{ border: `1px solid ${premium.surface.hairlineStrong}`, color: premium.text.secondary }}>
            원본으로 되돌리기
          </button>
        )}
        <button onClick={() => store.getState().close()}
                className="text-[11px] px-2 py-[3px] rounded"
                style={{ border: `1px solid ${premium.surface.hairlineStrong}`, color: premium.text.muted }}>×</button>
      </div>

      <div className="flex">
        {/* Waveform */}
        <div className="p-3">
          <div className="text-[9px] tracking-wider mb-1.5" style={{ color: premium.text.faint }}>
            앞뒤 {CONTEXT_SEC}초는 문맥 · 점선은 꼬리가 떨어질 자리
          </div>
          <canvas
            ref={canvasRef} width={WAVE_W} height={WAVE_H}
            style={{ borderRadius: 5, border: `1px solid ${premium.surface.hairline}`, display: 'block' }}
          />
          <div className="text-[10px] mt-2 leading-relaxed" style={{ color: premium.text.muted }}>
            {describeTail(live, session.sampleRate)}
            {applied && ` · 지금 걸려 있는 처리: ${applied.inserts.map((i) => i.label).join(' → ')}`}
          </div>
        </div>

        {/* Chain */}
        <div className="p-3 flex-1" style={{ borderLeft: `1px solid ${premium.surface.hairline}`,
                                             background: premium.surface.well }}>
          <div className="text-[9px] tracking-wider mb-1.5" style={{ color: premium.text.faint }}>
            이 조각만의 체인
          </div>
          {Array.from({ length: SLOTS }, (_, slot) => {
            const insert = chain.find((i) => i.slot === slot) ?? null;
            const on = slot === activeSlot;
            return (
              <div key={slot} className="flex items-center gap-1.5 mb-1">
                <span className="font-mono text-[9px] w-2.5" style={{ color: premium.text.faint }}>
                  {String.fromCharCode(65 + slot)}
                </span>
                <select
                  value={insert?.pluginId ?? ''}
                  onChange={(e) => pick(slot, e.target.value)}
                  onFocus={() => store.getState().setActiveSlot(slot)}
                  className="flex-1 h-6 px-1 text-[10px] rounded bg-transparent outline-none"
                  style={{
                    color: insert ? premium.accent.light : premium.text.faint,
                    border: `1px solid ${on && insert ? premium.accent.deep : premium.surface.hairline}`,
                  }}
                >
                  <option value="">비어 있음</option>
                  {PLUGINS.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {insert && (
                  <button
                    onClick={() => setChain(chain.map((i) => (i.slot === slot
                      ? { ...i, bypass: !i.bypass } : i)))}
                    title="바이패스"
                    className="h-6 px-1.5 text-[9px] rounded"
                    style={{
                      border: `1px solid ${premium.surface.hairline}`,
                      color: insert.bypass ? premium.accent.danger : premium.text.faint,
                    }}
                  >BYP</button>
                )}
              </div>
            );
          })}

          {/* The selected device */}
          {active && descriptor && (
            <div className="mt-3">
              <div className="text-[9px] tracking-wider mb-1.5" style={{ color: premium.text.faint }}>
                {descriptor.name}
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {genreChips.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => loadPreset(active.slot, preset.id)}
                    title={preset.note}
                    className="h-[18px] px-1.5 rounded text-[9px] leading-none"
                    style={{
                      border: `1px solid ${premium.surface.hairline}`,
                      color: premium.text.muted,
                    }}
                  >{preset.name}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {descriptor.params.map((def) => (
                  <Knob
                    key={def.id}
                    label={def.name}
                    value={active.params[def.id] ?? def.default}
                    min={def.min} max={def.max} defaultValue={def.default}
                    unit={def.unit ?? ''}
                    size={40}
                    curve={curveFor(def.unit ?? '', def.min)}
                    onChange={(v) => setParam(active.slot, def.id, v)}
                    onCommit={() => { /* the draft is not an undo step */ }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The decision */}
      <div className="flex items-center gap-3 px-3.5 py-2.5"
           style={{ background: premium.surface.frame, borderTop: `1px solid ${premium.surface.hairline}` }}>
        <span className="text-[9px] tracking-wider" style={{ color: premium.text.faint }}>꼬리</span>
        <div className="flex rounded overflow-hidden"
             style={{ border: `1px solid ${premium.surface.hairlineStrong}` }}>
          {([
            ['cut', '조각에서 자름'],
            ['keep', `꼬리 남김 · ${tailSec.toFixed(2)}초`],
            ['live', '계속 울림'],
          ] as Array<[TailMode, string]>)
            .map(([mode, label], index) => (
              <button
                key={mode}
                onClick={() => store.getState().setTailMode(mode)}
                className="text-[10px] px-2.5 py-[5px]"
                style={{
                  borderLeft: index > 0 ? `1px solid ${premium.surface.hairline}` : undefined,
                  background: tailMode === mode ? 'rgba(198,167,104,0.16)' : 'transparent',
                  color: tailMode === mode ? premium.accent.base : premium.text.muted,
                }}
              >{label}</button>
            ))}
        </div>
        <span className="text-[10px]" style={{ color: premium.text.muted }}>
          {tailMode === 'keep'
            ? '조각이 꼬리만큼 길어져 뒤 오디오와 겹쳐 울립니다'
            : tailMode === 'live'
              ? (liveAux
                ? '이미 Aux 로 보내고 있습니다 — 다시 누르면 하나 더 생깁니다'
                : 'Aux 를 만들어 이 조각 동안만 센드를 엽니다. 렌더하지 않습니다')
              : '조각 끝에서 잘립니다 — EQ·게인처럼 울리지 않는 체인에만'}
        </span>
        <span className="flex-1" />
        <button
          onClick={onApply}
          disabled={busy}
          className="text-[11px] px-4 py-1.5 rounded font-medium"
          style={{
            background: busy
              ? 'rgba(255,255,255,0.06)'
              : `linear-gradient(180deg, ${premium.accent.light}, ${premium.accent.base})`,
            color: busy ? premium.text.muted : premium.text.onAccent,
          }}
        >{busy ? '렌더 중…' : tailMode === 'live' ? 'Aux 만들기' : '적용'}</button>
      </div>
    </div>
  );
}

/** The preset groups for a device, in the shape `partitionGenre` reads. */
function groupsFor(pluginId: string): Array<{ group: string; presets: ReturnType<typeof presetsFor> }> {
  const out: Array<{ group: string; presets: ReturnType<typeof presetsFor> }> = [];
  for (const preset of presetsFor(pluginId)) {
    const found = out.find((g) => g.group === preset.group);
    if (found) found.presets.push(preset);
    else out.push({ group: preset.group, presets: [preset] });
  }
  return out;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
