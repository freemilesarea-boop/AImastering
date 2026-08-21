// SpectralEditor — the spectrogram as an editing surface.
//
// Waveform editing can only answer "when"; a click that sits under a vocal
// needs "when AND where in the spectrum".  So the clip is drawn as
// frequency × time, the user drags a box around the problem, and one of three
// verbs is applied:
//
//   REPAIR     rebuild the box from the frames either side of it
//   ATTENUATE  pull the box down by N dB
//   REPLACE    paste the same band from another moment in the take
//
// The suspects list on the right is spectral flux — the app's own guess at
// where the clicks are, so the common case is two clicks and done.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { getCached, monoSum } from '../../../daw/engine/audio-cache.js';
import { stft, hzToBin } from '../../../daw/audio/stft.js';
import {
  spectrogramGrid, findAnomalies, describeSpectralEdit,
  type SpectralOp, type SpectralRegion, type SpectralAnomaly,
} from '../../../daw/audio/spectral-edit.js';
import { repairClipSpectrum } from '../../../daw/edit/spectral-repair.js';
import { premium } from '../../../theme/premium.js';
import type { Clip, Track } from '../../../daw/model/types.js';

/** Analysis window shown at once.  Long enough to find a click, short enough
 *  that the STFT is instant. */
const VIEW_SEC = 8;
const FFT = 2048;
const HOP = 512;
const MIN_HZ = 20;

// Frequency axis is logarithmic — that is where the ear and the problems are.
const yToHz = (y: number, height: number, maxHz: number): number =>
  MIN_HZ * Math.pow(maxHz / MIN_HZ, 1 - y / height);
const hzToY = (hz: number, height: number, maxHz: number): number =>
  height * (1 - Math.log(Math.max(MIN_HZ, hz) / MIN_HZ) / Math.log(maxHz / MIN_HZ));

interface Box { x0: number; y0: number; x1: number; y1: number }

export default function SpectralEditor() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const focusedTrackId = useDawStore((s) => s.focusedTrackId);
  const playheadSec = useDawStore((s) => s.playheadSec);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [gainDb, setGainDb] = useState(-24);
  const [replaceFromSec, setReplaceFromSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const [viewStartSec, setViewStartSec] = useState(0);

  // The clip under the playhead on the focused track, else the first audio clip.
  const target = useMemo((): { track: Track; clip: Clip } | null => {
    const tracks = focusedTrackId
      ? [findTrack(session, focusedTrackId)].filter(Boolean) as Track[]
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

  const cached = target ? getCached(target.clip.fileId) : undefined;
  const sampleRate = cached?.buffer.sampleRate ?? session.sampleRate;
  const fileDuration = cached?.buffer.duration ?? 0;
  const maxHz = sampleRate / 2;

  // Follow the playhead into view when it leaves the window.
  useEffect(() => {
    if (!target) return;
    const fileSec = playheadSec - target.clip.startSec + target.clip.offsetSec;
    if (fileSec < viewStartSec || fileSec > viewStartSec + VIEW_SEC) {
      setViewStartSec(Math.max(0, fileSec - VIEW_SEC / 2));
    }
  }, [playheadSec, target, viewStartSec]);

  const viewEndSec = Math.min(fileDuration, viewStartSec + VIEW_SEC);

  // The spectrogram of the visible window only.
  const spec = useMemo(() => {
    if (!cached) return null;
    const mono = monoSum(cached.buffer);
    const from = Math.max(0, Math.floor(viewStartSec * sampleRate));
    const to = Math.min(mono.length, Math.ceil(viewEndSec * sampleRate));
    if (to <= from) return null;
    return stft(mono.subarray(from, to), sampleRate, { fftSize: FFT, hopSize: HOP });
  }, [cached, viewStartSec, viewEndSec, sampleRate]);

  const anomalies = useMemo((): SpectralAnomaly[] => (
    spec ? findAnomalies(spec).slice(0, 8) : []
  ), [spec]);

  // Paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spec) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    const grid = spectrogramGrid(spec, -84, 0);
    const image = ctx.createImageData(width, height);

    for (let y = 0; y < height; y++) {
      const hz = yToHz(y, height, maxHz);
      const bin = Math.round(hzToBin(hz, spec.fftSize, sampleRate));
      const row = Math.max(0, Math.min(grid.height - 1, bin));
      for (let x = 0; x < width; x++) {
        const frame = Math.min(grid.width - 1, Math.round((x / width) * (grid.width - 1)));
        const v = grid.data[row * grid.width + frame] ?? 0;
        // Black → brass → white: one accent family, brightness carries level.
        const c = colorFor(v);
        const i = (y * width + x) * 4;
        image.data[i] = c[0];
        image.data[i + 1] = c[1];
        image.data[i + 2] = c[2];
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [spec, maxHz, sampleRate]);

  const canvasSize = { width: 900, height: 340 };

  const toRegion = useCallback((b: Box): SpectralRegion => {
    const { width, height } = canvasSize;
    const span = viewEndSec - viewStartSec;
    return {
      startSec: viewStartSec + (Math.min(b.x0, b.x1) / width) * span,
      endSec: viewStartSec + (Math.max(b.x0, b.x1) / width) * span,
      lowHz: yToHz(Math.max(b.y0, b.y1), height, maxHz),
      highHz: yToHz(Math.min(b.y0, b.y1), height, maxHz),
    };
  }, [viewStartSec, viewEndSec, maxHz, canvasSize.width, canvasSize.height]);

  const region = box ? toRegion(box) : null;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvasSize.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvasSize.height;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvasSize.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvasSize.height;
    setDrag({ ...drag, x1: x, y1: y });
  };
  const onPointerUp = (): void => {
    if (!drag) return;
    // A click without a drag clears the selection instead of making a sliver.
    const isBox = Math.abs(drag.x1 - drag.x0) > 3 && Math.abs(drag.y1 - drag.y0) > 3;
    setBox(isBox ? drag : null);
    setDrag(null);
  };

  const run = useCallback(async (op: SpectralOp) => {
    if (!target || !region) return;
    setBusy(true);
    try {
      const result = await repairClipSpectrum(
        useDawStore.getState().session, target.track.id, target.clip.id, region, op);
      apply(() => result.session);
      notify(`${describeSpectralEdit(region, op)} 적용`, 'success');
      setBox(null);
    } catch (err) {
      notify(`스펙트럴 편집 실패: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [target, region, apply, notify]);

  if (!target) return <Empty message="오디오 클립이 있는 트랙이 필요합니다" />;
  if (!cached) return <Empty message="오디오를 디코딩하는 중입니다 — Edit 창에서 클립을 먼저 여세요" />;

  const drawn = drag ?? box;

  return (
    <div className="flex-1 flex overflow-hidden" style={{ background: premium.surface.abyss }}>
      <div className="flex-1 flex flex-col overflow-auto">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2"
             style={{ borderBottom: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
          <span style={{ fontFamily: premium.type.display, fontSize: 17, color: premium.accent.light }}>
            Spectral Repair
          </span>
          <span style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
            {target.track.name} · {target.clip.name}
          </span>
          <div className="flex-1" />
          <button onClick={() => setViewStartSec(Math.max(0, viewStartSec - VIEW_SEC / 2))}
                  style={navStyle}>◀</button>
          <span style={{ fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary }}>
            {viewStartSec.toFixed(2)}s – {viewEndSec.toFixed(2)}s
          </span>
          <button onClick={() => setViewStartSec(Math.min(Math.max(0, fileDuration - VIEW_SEC), viewStartSec + VIEW_SEC / 2))}
                  style={navStyle}>▶</button>
        </div>

        {/* Spectrogram */}
        <div className="relative m-4" style={{ width: canvasSize.width, maxWidth: '100%' }}>
          <canvas
            ref={canvasRef}
            width={canvasSize.width}
            height={canvasSize.height}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              width: '100%', height: canvasSize.height, display: 'block', cursor: 'crosshair',
              border: `1px solid ${premium.surface.hairlineStrong}`, borderRadius: 4,
              boxShadow: premium.shadow.frame,
            }}
          />
          {drawn && (
            <div style={{
              position: 'absolute', pointerEvents: 'none',
              left: `${(Math.min(drawn.x0, drawn.x1) / canvasSize.width) * 100}%`,
              width: `${(Math.abs(drawn.x1 - drawn.x0) / canvasSize.width) * 100}%`,
              top: Math.min(drawn.y0, drawn.y1),
              height: Math.abs(drawn.y1 - drawn.y0),
              border: `1px solid ${premium.accent.base}`,
              background: premium.accent.glow,
              boxShadow: `0 0 12px ${premium.accent.glow}`,
            }} />
          )}
          {/* Frequency ruler */}
          <div className="absolute left-1 top-0 h-full pointer-events-none">
            {[100, 500, 1000, 5000, 10000].filter((hz) => hz < maxHz).map((hz) => (
              <div key={hz} style={{
                position: 'absolute', top: hzToY(hz, canvasSize.height, maxHz) - 6,
                fontFamily: premium.type.mono, fontSize: 9, color: premium.text.faint,
              }}>{hz >= 1000 ? `${hz / 1000}k` : hz}</div>
            ))}
          </div>
        </div>

        {/* Verbs */}
        <div className="flex items-center gap-2 px-4 pb-4 flex-wrap">
          <ActionButton disabled={!region || busy} onClick={() => void run({ kind: 'repair' })}>
            REPAIR
          </ActionButton>
          <ActionButton disabled={!region || busy} onClick={() => void run({ kind: 'attenuate', gainDb })}>
            ATTENUATE
          </ActionButton>
          <input type="range" min={-72} max={-1} step={1} value={gainDb}
                 onChange={(e) => setGainDb(Number(e.target.value))}
                 style={{ width: 120 }} />
          <span style={{ fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary, width: 52 }}>
            {gainDb} dB
          </span>
          <ActionButton disabled={!region || busy} onClick={() => void run({ kind: 'replace', sourceSec: replaceFromSec })}>
            REPLACE
          </ActionButton>
          <input type="number" step={0.05} min={0} value={replaceFromSec}
                 onChange={(e) => setReplaceFromSec(Number(e.target.value))}
                 style={{
                   width: 78, background: premium.surface.well, color: premium.text.primary,
                   border: `1px solid ${premium.surface.hairline}`, borderRadius: 3,
                   fontFamily: premium.type.mono, fontSize: 11, padding: '3px 6px',
                 }} />
          <span style={{ fontFamily: premium.type.sans, fontSize: 10, color: premium.text.muted }}>
            에서 복사
          </span>
          {busy && <span style={{ fontSize: 11, color: premium.accent.base }}>처리 중…</span>}
        </div>

        {region && (
          <div className="px-4 pb-4" style={{
            fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary,
          }}>
            선택: {(region.endSec - region.startSec) * 1000 < 1000
              ? `${Math.round((region.endSec - region.startSec) * 1000)} ms`
              : `${(region.endSec - region.startSec).toFixed(2)} s`}
            {' × '}{Math.round(region.lowHz)}–{Math.round(region.highHz)} Hz
            {' @ '}{region.startSec.toFixed(3)} s
          </div>
        )}
      </div>

      {/* Suspects */}
      <div className="w-56 shrink-0 overflow-auto"
           style={{ borderLeft: `1px solid ${premium.surface.hairline}`, background: premium.surface.panel }}>
        <div className="px-3 py-2" style={{
          fontFamily: premium.type.display, fontSize: 13, color: premium.accent.light,
          borderBottom: `1px solid ${premium.surface.hairline}`,
        }}>의심 지점</div>
        {anomalies.length === 0 && (
          <p className="px-3 py-3" style={{ fontFamily: premium.type.sans, fontSize: 11, color: premium.text.muted }}>
            이 구간에서 클릭성 이벤트를 찾지 못했습니다.
          </p>
        )}
        {anomalies.map((a, i) => (
          <button
            key={`${a.startSec}-${i}`}
            onClick={() => {
              const span = viewEndSec - viewStartSec;
              const x0 = ((a.startSec) / span) * canvasSize.width;
              const x1 = ((a.endSec) / span) * canvasSize.width;
              setBox({
                x0, x1,
                y0: hzToY(a.highHz, canvasSize.height, maxHz),
                y1: hzToY(a.lowHz, canvasSize.height, maxHz),
              });
            }}
            className="w-full text-left px-3 py-2"
            style={{
              borderBottom: `1px solid ${premium.surface.hairline}`,
              fontFamily: premium.type.mono, fontSize: 11, color: premium.text.secondary,
              background: 'transparent',
            }}
          >
            {(viewStartSec + a.startSec).toFixed(3)} s
            <span style={{ color: premium.accent.base, marginLeft: 8 }}>×{a.strength.toFixed(1)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Level → colour.  Dark ground, brass mid, near-white peaks. */
function colorFor(v: number): [number, number, number] {
  if (v <= 0) return [6, 6, 10];
  if (v < 0.5) {
    const t = v / 0.5;
    return [Math.round(6 + t * 92), Math.round(6 + t * 74), Math.round(10 + t * 44)];
  }
  const t = (v - 0.5) / 0.5;
  return [Math.round(98 + t * 157), Math.round(80 + t * 165), Math.round(54 + t * 175)];
}

const navStyle: React.CSSProperties = {
  height: 22, padding: '0 8px', borderRadius: 3,
  background: premium.surface.well, color: premium.text.secondary,
  border: `1px solid ${premium.surface.hairline}`, fontSize: 11,
};

function ActionButton(
  { children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean },
) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 28, padding: '0 14px', borderRadius: 4,
        fontFamily: premium.type.sans, fontSize: 11, letterSpacing: '0.08em',
        color: disabled ? premium.text.faint : premium.text.onAccent,
        background: disabled ? premium.surface.well : premium.accent.base,
        border: `1px solid ${disabled ? premium.surface.hairline : premium.accent.deep}`,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >{children}</button>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ background: premium.surface.abyss }}>
      <p style={{ fontFamily: premium.type.sans, fontSize: 12, color: premium.text.muted }}>{message}</p>
    </div>
  );
}
