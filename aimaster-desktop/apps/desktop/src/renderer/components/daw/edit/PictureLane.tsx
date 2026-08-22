// The picture lane — where the film sits, and how it gets moved.
//
// A picture that cannot be dragged is a picture that is always at zero, and
// zero is almost never right: the reel has a head, the music starts eight
// bars in, the cut being scored is forty seconds into the file.  So this is
// a strip you can grab.
//
// Two things make it a picture lane rather than a coloured rectangle:
//
//   IT SNAPS TO FRAMES, NEVER TO THE GRID.  A bar line is a musical idea and
//   a frame is a physical one; snapping the picture to a bar would put it
//   between frames, which shows the wrong image for up to 42 ms at 23.976
//   and quietly poisons every hit point measured afterwards.
//
//   THE READ-OUT IS FRAMES AND TIMECODE, NOT SECONDS.  While dragging you
//   are told how far you have moved in frames and what timecode now lands on
//   the play head, because those are the two numbers a spotting session is
//   conducted in.

import React, { useCallback, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useVideoStore } from '../../../stores/videoStore.js';
import {
  frameSec, snapToFrame, timecodeAt, videoOf, videoSpan,
} from '../../../daw/model/video.js';
import {
  describeVideoPosition, moveVideoTo, nudgeVideoFrames, resetVideoPosition,
} from '../../../daw/edit/video-move.js';
import { premium } from '../../../theme/premium.js';

export const PICTURE_LANE_HEIGHT = 26;

interface Viewport { scrollSec: number; pxPerSec: number; width: number }

export function PictureLaneHeader() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const notify = useAppStore((s) => s.notify);
  const video = videoOf(session);

  const run = (fn: (s: typeof session) => ReturnType<typeof resetVideoPosition>): void => {
    let reason: string | null = null;
    apply((s) => { const r = fn(s); reason = r.reason; return r.applied ? r.session : s; });
    if (reason) notify(reason, 'warning');
  };

  return (
    <div
      className="flex items-center gap-1 px-2 border-b border-zinc-800"
      style={{ height: PICTURE_LANE_HEIGHT, background: '#14141c' }}
    >
      <span className="text-[9px] tracking-wide flex-1 truncate"
            style={{ color: video ? premium.accent.base : premium.text.faint }}
            title={video ? describeVideoPosition(session) : '픽처를 먼저 불러오세요'}>
        픽처
      </span>
      {video && (
        <>
          <button
            onClick={() => run((s) => nudgeVideoFrames(s, -1))}
            title="한 프레임 앞으로"
            className="w-4 h-4 rounded text-[9px] leading-none border"
            style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
          >◀</button>
          <button
            onClick={() => run((s) => nudgeVideoFrames(s, 1))}
            title="한 프레임 뒤로"
            className="w-4 h-4 rounded text-[9px] leading-none border"
            style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
          >▶</button>
          <button
            onClick={() => run((s) => moveVideoTo(s, playheadSec))}
            title="픽처의 시작을 재생헤드로"
            className="px-1 h-4 rounded text-[8px] leading-none border"
            style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
          >재생헤드</button>
          <button
            onClick={() => run(resetVideoPosition)}
            title="픽처를 0 으로 되돌리고 트림도 해제"
            className="px-1 h-4 rounded text-[8px] leading-none border"
            style={{ borderColor: 'rgba(255,255,255,0.14)', color: premium.text.muted }}
          >0</button>
        </>
      )}
    </div>
  );
}

export default function PictureLane({ viewport }: { viewport: Viewport }) {
  const session = useDawStore((s) => s.session);
  const applyTransient = useDawStore((s) => s.applyTransient);
  const commitEdit = useDawStore((s) => s.commitEdit);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const notify = useAppStore((s) => s.notify);
  const dropFrame = useVideoStore((s) => s.dropFrame);

  const boxRef = useRef<HTMLDivElement>(null);
  const [dragFrames, setDragFrames] = useState<number | null>(null);
  const { scrollSec, pxPerSec, width } = viewport;

  const video = videoOf(session);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const current = videoOf(useDawStore.getState().session);
    if (!current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startAt = current.startSec;
    const frame = frameSec(current.fps);

    const move = (ev: PointerEvent): void => {
      const deltaSec = (ev.clientX - startX) / pxPerSec;
      // Snap the RESULT, not the delta: snapping the delta accumulates a
      // rounding error over a long drag and lands the picture off-frame.
      const wanted = snapToFrame(startAt + deltaSec, current.fps);
      const clamped = Math.max(0, wanted);
      setDragFrames(Math.round((clamped - startAt) / frame));
      applyTransient((s) => {
        const r = moveVideoTo(s, clamped);
        return r.applied ? r.session : s;
      });
    };
    const up = (): void => {
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
      setDragFrames(null);
      commitEdit();
      const after = videoOf(useDawStore.getState().session);
      if (after) notify(describeVideoPosition(useDawStore.getState().session));
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  }, [pxPerSec, applyTransient, commitEdit, notify]);

  if (!video) {
    return (
      <div className="relative border-b border-zinc-900"
           style={{ height: PICTURE_LANE_HEIGHT, background: '#0e0e14' }} />
    );
  }

  const span = videoSpan(video);
  const left = (span.startSec - scrollSec) * pxPerSec;
  const right = (span.endSec - scrollSec) * pxPerSec;
  const visible = right > 0 && left < width;

  return (
    <div
      ref={boxRef}
      className="relative border-b border-zinc-900 overflow-hidden"
      style={{ height: PICTURE_LANE_HEIGHT, background: '#0e0e14' }}
    >
      {visible && (
        <div
          onPointerDown={onPointerDown}
          title={`${video.name} — 끌어서 픽처를 옮깁니다 (프레임 단위)`}
          style={{
            position: 'absolute',
            left: Math.max(-4, left),
            width: Math.max(6, Math.min(width + 8, right) - Math.max(-4, left)),
            top: 3,
            bottom: 3,
            cursor: 'ew-resize',
            borderRadius: 3,
            background: 'linear-gradient(180deg, rgba(110,155,214,0.35), rgba(110,155,214,0.16))',
            border: `1px solid ${premium.accent.cool}`,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: 6,
            overflow: 'hidden',
          }}
        >
          <span style={{
            fontSize: 9, fontFamily: premium.type.mono, color: premium.text.primary,
            whiteSpace: 'nowrap',
          }}>{video.name}</span>
          <span style={{
            fontSize: 9, fontFamily: premium.type.mono, color: premium.text.muted,
            whiteSpace: 'nowrap',
          }}>{timecodeAt(video, playheadSec, dropFrame)}</span>
        </div>
      )}
      {/* While dragging, the number that matters is frames — not pixels and
          not seconds. */}
      {dragFrames !== null && (
        <span style={{
          position: 'absolute', right: 6, top: 5,
          fontSize: 9, fontFamily: premium.type.mono, color: premium.accent.light,
        }}>{dragFrames > 0 ? '+' : ''}{dragFrames}프레임</span>
      )}
    </div>
  );
}
