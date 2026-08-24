// WarpEditor — the clip drawn in MUSICAL time.
//
// The waveform is rendered through the warp map, so what you see is what
// plays: the grid is fixed and the audio moves against it.  Dragging a marker
// onto a grid line is then literally "pull this hit onto the beat", and the
// waveform stretches under your cursor as you do it.
//
//   drag a marker      move that moment to a new beat
//   double-click       add a marker at the nearest transient
//   alt-click a marker remove it

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { getCached, transientsFor } from '../../../daw/engine/audio-cache.js';
import {
  extractClipGroove, matchSessionTempo,
} from '../../../daw/edit/tempo-groove-actions.js';
import { describeDetection } from '../../../daw/model/tempo-detect.js';
import { describeGroove } from '../../../daw/model/groove.js';
import {
  DEFAULT_WARP, beatSeconds, buildWarpMap, clipWarp, destToSource, describeWarp,
  moveMarker, removeMarker, addMarker, resolveBpm, sourceToDest, validateWarp,
  setSessionTempo, type WarpMode,
} from '../../../daw/model/warp.js';
import {
  autoWarpClip, setFollowTempo, setWarpEnabled, setWarpMode, unwarpClip, updateWarp,
  warpClipToTempo,
} from '../../../daw/edit/warp-actions.js';
import { premium } from '../../../theme/premium.js';
import type { Clip, Track } from '../../../daw/model/types.js';

const MODES: { id: WarpMode; label: string; note: string }[] = [
  { id: 'beats',   label: 'BEATS',   note: '드럼 · 짧은 창으로 어택 유지' },
  { id: 'tones',   label: 'TONES',   note: '단선율 · 기본값' },
  { id: 'texture', label: 'TEXTURE', note: '패드 · 검색 없이 부드럽게' },
  { id: 'complex', label: 'COMPLEX', note: '풀믹스 · 넓은 검색' },
];

const CANVAS = { width: 940, height: 220 };

export default function WarpEditor() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const playheadSec = useDawStore((s) => s.playheadSec);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [bpmDraft, setBpmDraft] = useState<string>('');
  const [detected, setDetected] = useState<string>('');
  const setGroove = useDawStore((st) => st.setGroove);

  const target = useMemo((): { track: Track; clip: Clip } | null => {
    const tracks = focusedTrackId
      ? ([findTrack(session, focusedTrackId)].filter(Boolean) as Track[])
      : session.tracks;
    for (const track of tracks) {
      const clips = trackClips(track).filter((c) => c.kind === 'audio');
      const under = clips.find((c) => playheadSec >= c.startSec && playheadSec < c.startSec + c.durationSec);
      const clip = under ?? clips[0];
      if (clip) return { track, clip };
    }
    for (const track of session.tracks) {
      const clip = trackClips(track).find((c) => c.kind === 'audio');
      if (clip) return { track, clip };
    }
    return null;
  }, [session, focusedTrackId, playheadSec]);

  const clip = target?.clip ?? null;
  const warp = clip ? (clip.warp ?? DEFAULT_WARP) : DEFAULT_WARP;
  const active = clip ? clipWarp(clip) : null;
  const cached = clip ? getCached(clip.fileId) : undefined;
  const bpm = resolveBpm(warp, session.tempoBpm);
  const beatSec = beatSeconds(bpm);

  const map = useMemo(() => buildWarpMap(warp, session.tempoBpm), [warp, session.tempoBpm]);
  const destStart = clip ? sourceToDest(map, clip.offsetSec) : 0;
  const duration = clip?.durationSec ?? 1;
  const problems = useMemo(
    () => (clip ? validateWarp(warp, session.tempoBpm) : []), [clip, warp, session.tempoBpm]);

  // ── Paint ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !clip) return;
    const { width, height } = canvas;
    const mid = height / 2;

    ctx.fillStyle = premium.surface.well;
    ctx.fillRect(0, 0, width, height);

    // Beat grid, in destination time — it never moves.
    const firstBeat = Math.floor(destStart / beatSec);
    const lastBeat = Math.ceil((destStart + duration) / beatSec);
    const beatsPerBar = session.timeSignature[0];
    for (let b = firstBeat; b <= lastBeat; b++) {
      const x = ((b * beatSec - destStart) / duration) * width;
      if (x < 0 || x > width) continue;
      const bar = b % beatsPerBar === 0;
      ctx.strokeStyle = bar ? premium.surface.hairlineStrong : premium.surface.hairline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
    }

    // Waveform, read through the map so it is drawn where it plays.
    const peaks = cached?.peaks;
    const fileDuration = cached?.buffer.duration ?? 0;
    if (peaks && fileDuration > 0) {
      ctx.fillStyle = premium.accent.base;
      for (let x = 0; x < width; x++) {
        const destSec = destStart + (x / width) * duration;
        const sourceSec = destToSource(map, destSec);
        const index = Math.floor((sourceSec / fileDuration) * peaks.length);
        if (index < 0 || index >= peaks.length) continue;
        const peak = peaks[index] ?? 0;
        const h = Math.max(1, peak * (height * 0.42));
        ctx.fillRect(x, mid - h, 1, h * 2);
      }
    }

    ctx.strokeStyle = premium.surface.hairlineStrong;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();
  }, [clip, cached, map, destStart, duration, beatSec, session.timeSignature]);

  // ── Geometry ─────────────────────────────────────────────────────────────
  const markerX = useCallback((sourceSec: number): number =>
    ((sourceToDest(map, sourceSec) - destStart) / duration) * CANVAS.width,
  [map, destStart, duration]);

  const beatAtX = useCallback((x: number): number =>
    (destStart + (x / CANVAS.width) * duration) / beatSec,
  [destStart, duration, beatSec]);

  const localX = (e: React.PointerEvent | React.MouseEvent, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * CANVAS.width;
  };

  const write = useCallback((fn: Parameters<typeof updateWarp>[3]) => {
    if (!target) return;
    apply((s) => updateWarp(s, target.track.id, target.clip.id, fn));
  }, [apply, target]);

  // ── Marker interaction ───────────────────────────────────────────────────
  const onMarkerDown = (e: React.PointerEvent<HTMLDivElement>, id: string): void => {
    e.stopPropagation();
    if (e.altKey) {
      write((w) => removeMarker(w, id));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragId(id);
  };

  const onCanvasMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragId) return;
    const beat = beatAtX(localX(e, e.currentTarget));
    write((w) => moveMarker(w, dragId, beat));
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!clip || !cached) return;
    const x = localX(e, e.currentTarget);
    const destSec = destStart + (x / CANVAS.width) * duration;
    const sourceSec = destToSource(map, destSec);
    // Snap to the nearest transient within 40 ms — that is the moment the
    // user is aiming at, not the pixel they hit.
    const onsets = transientsFor(clip.fileId);
    let snapped = sourceSec;
    let bestGap = 0.04;
    for (const onset of onsets) {
      const gap = Math.abs(onset - sourceSec);
      if (gap < bestGap) { bestGap = gap; snapped = onset; }
    }
    write((w) => addMarker(w, snapped, Math.round(beatAtX(x) * 4) / 4));
  };

  // ── Actions ──────────────────────────────────────────────────────────────
  const runSetup = (kind: 'auto' | 'tempo'): void => {
    if (!target) return;
    try {
      const current = useDawStore.getState().session;
      const explicit = bpmDraft.trim() ? Number(bpmDraft) : undefined;
      const sourceBpm = explicit !== undefined && Number.isFinite(explicit) && explicit > 0
        ? explicit : undefined;
      const result = kind === 'auto'
        ? autoWarpClip(current, target.track.id, target.clip.id,
            sourceBpm === undefined ? {} : { sourceBpm })
        : warpClipToTempo(current, target.track.id, target.clip.id, sourceBpm);
      apply(() => result.session);
      notify(
        `${kind === 'auto' ? 'Auto-Warp' : 'Warp to Tempo'} · ${result.sourceBpm.toFixed(1)} BPM`
        + `${result.estimated ? ' (추정)' : ''} · 마커 ${result.markerCount}개`, 'success');
    } catch (err) {
      notify((err as Error).message, 'warning');
    }
  };

  /**
   * Read the tempo off the recording and take the session to it.
   *
   * The refusal is the point: a reading the detector does not trust is shown
   * and nothing moves, because setting the tempo drags every clip in the
   * project along with it.  The number is still on screen — the user can type
   * it into the SESSION field if they know better than the measurement.
   */
  const detect = (): void => {
    if (!target) return;
    const current = useDawStore.getState().session;
    const result = matchSessionTempo(current, target.track.id, target.clip.id);
    setDetected(describeDetection(result.detection));
    if (!result.applied) { notify(result.message, 'warning'); return; }
    apply(() => result.session);
    notify(result.message, 'success');
  };

  const lift = (): void => {
    if (!target) return;
    const current = useDawStore.getState().session;
    const result = extractClipGroove(current, target.track.id, target.clip.id);
    if (!result.groove) { notify(result.reason ?? '그루브를 추출할 수 없습니다', 'warning'); return; }
    setGroove(result.groove);
    notify(`그루브 추출 — ${describeGroove(result.groove)} · Key Editor 에서 적용하세요`, 'success');
  };

  const changeTempo = (value: number): void => {
    if (!Number.isFinite(value) || value <= 0) return;
    const { session: next, unwarpedClipIds } = setSessionTempo(useDawStore.getState().session, value);
    apply(() => next);
    notify(unwarpedClipIds.length > 0
      ? `${next.tempoBpm} BPM — 워프가 꺼진 클립 ${unwarpedClipIds.length}개는 길이가 그대로입니다`
      : `${next.tempoBpm} BPM`, unwarpedClipIds.length > 0 ? 'warning' : 'success');
  };

  if (!target || !clip) {
    return <Empty message="오디오 클립이 있는 트랙이 필요합니다" />;
  }

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: premium.surface.abyss }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 flex-wrap"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>Warp</span>
        <span style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
          {target.track.name} · {clip.name}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5"
               style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted }}>
          SESSION
          <input type="number" min={20} max={300} step={0.5} value={session.tempoBpm}
                 onChange={(e) => changeTempo(Number(e.target.value))}
                 style={numberStyle} />
          BPM
        </label>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 px-4 py-2 flex-wrap"
           style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
        <Toggle on={warp.enabled} onClick={() => apply((s) =>
          setWarpEnabled(s, target.track.id, clip.id, !warp.enabled))}>WARP</Toggle>
        <Toggle on={warp.followTempo} onClick={() => apply((s) =>
          setFollowTempo(s, target.track.id, clip.id, !warp.followTempo))}>FOLLOW TEMPO</Toggle>

        <span className="w-px h-5" style={{ background: premium.surface.hairline }} />

        {MODES.map((m) => (
          <button key={m.id} title={m.note}
            onClick={() => apply((s) => setWarpMode(s, target.track.id, clip.id, m.id))}
            style={{
              height: 24, padding: '0 10px', borderRadius: 3,
              fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.08em',
              color: warp.mode === m.id ? premium.text.onAccent : premium.text.muted,
              background: warp.mode === m.id ? premium.accent.base : premium.surface.well,
              border: `1px solid ${premium.surface.hairline}`,
            }}>{m.label}</button>
        ))}

        <span className="w-px h-5" style={{ background: premium.surface.hairline }} />

        <input placeholder="소스 BPM" value={bpmDraft} onChange={(e) => setBpmDraft(e.target.value)}
               style={{ ...numberStyle, width: 78 }} />
        <Action onClick={() => runSetup('tempo')}>Warp to Tempo</Action>
        <Action onClick={() => runSetup('auto')}>Auto-Warp</Action>
        <Action onClick={() => apply((s) => unwarpClip(s, target.track.id, clip.id))}>Unwarp</Action>

        <span className="w-px h-5" style={{ background: premium.surface.hairline }} />

        <Action onClick={detect}>템포 검출</Action>
        <Action onClick={lift}>그루브 추출</Action>
        {detected && (
          <span style={{ fontFamily: premium.type.mono, fontSize: 10, color: premium.text.secondary }}>
            {detected}
          </span>
        )}
      </div>

      {/* Canvas */}
      <div
        className="relative m-4"
        style={{ width: CANVAS.width, maxWidth: '100%' }}
        onPointerMove={onCanvasMove}
        onPointerUp={() => setDragId(null)}
        onDoubleClick={onDoubleClick}
      >
        <canvas ref={canvasRef} width={CANVAS.width} height={CANVAS.height}
                style={{
                  width: '100%', height: CANVAS.height, display: 'block',
                  border: `1px solid ${premium.surface.hairlineStrong}`, borderRadius: 4,
                  boxShadow: premium.shadow.frame,
                }} />
        {warp.markers.map((m) => {
          const x = markerX(m.sourceSec);
          if (x < -4 || x > CANVAS.width + 4) return null;
          const problem = problems.find((p) => p.markerId === m.id);
          const color = problem
            ? (problem.severity === 'error' ? premium.accent.danger : premium.accent.cool)
            : premium.accent.light;
          return (
            <div
              key={m.id}
              onPointerDown={(e) => onMarkerDown(e, m.id)}
              title={`${m.beat.toFixed(3)} 비트 · 소스 ${m.sourceSec.toFixed(3)} s${problem ? ` — ${problem.message}` : ''}`}
              style={{
                position: 'absolute', top: 0, height: '100%',
                left: `${(x / CANVAS.width) * 100}%`,
                width: 11, marginLeft: -5, cursor: 'ew-resize',
                display: 'flex', justifyContent: 'center',
              }}
            >
              <span style={{ width: 1, height: '100%', background: color, boxShadow: `0 0 6px ${color}` }} />
              <span style={{
                position: 'absolute', top: 2, width: 9, height: 9, borderRadius: 2,
                background: color, transform: 'rotate(45deg)',
              }} />
            </div>
          );
        })}
      </div>

      {/* Status */}
      <div className="px-4 pb-4 flex flex-col gap-1">
        <span style={{ fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary }}>
          {describeWarp(active, session.tempoBpm)}
          {' · '}클립 {duration.toFixed(3)} s · 소스 {(clip.offsetSec).toFixed(3)} s 부터
        </span>
        {problems.map((p, i) => (
          <span key={`${p.message}-${i}`} style={{
            fontFamily: premium.type.sans, fontSize: 11,
            color: p.severity === 'error' ? premium.accent.danger : premium.accent.cool,
          }}>{p.severity === 'error' ? '✕' : '!'} {p.message}</span>
        ))}
        <span style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.faint }}>
          마커 드래그 = 그 순간을 다른 비트로 · 더블클릭 = 트랜지언트에 마커 추가 · Alt+클릭 = 삭제
        </span>
      </div>
    </div>
  );
}

const numberStyle: React.CSSProperties = {
  width: 64, background: premium.surface.well, color: premium.text.primary,
  border: `1px solid ${premium.surface.hairline}`, borderRadius: 3,
  fontFamily: premium.type.mono, fontSize: 11, padding: '3px 6px',
};

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      height: 24, padding: '0 12px', borderRadius: 3,
      fontFamily: premium.type.sans, fontSize: 10, letterSpacing: '0.1em',
      color: on ? premium.text.onAccent : premium.text.muted,
      background: on ? premium.accent.base : premium.surface.well,
      border: `1px solid ${on ? premium.accent.deep : premium.surface.hairline}`,
    }}>{children}</button>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      height: 24, padding: '0 12px', borderRadius: 3,
      fontFamily: premium.type.sans, fontSize: 11, color: premium.text.secondary,
      background: premium.surface.well, border: `1px solid ${premium.surface.hairline}`,
    }}>{children}</button>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ background: premium.surface.abyss }}>
      <p style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted }}>{message}</p>
    </div>
  );
}
