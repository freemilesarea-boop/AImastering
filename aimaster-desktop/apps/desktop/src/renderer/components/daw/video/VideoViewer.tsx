// The picture — a floating viewer, over whatever window you are in.
//
// Not a tab.  Scoring means watching the picture WHILE arranging, and a
// picture you have to leave the timeline to see is a picture you stop looking
// at.  So it floats, it is draggable, it stays up across EDIT / KEY / MIX, and
// closing it is one click.
//
// The element is muted and always will be.  Its audio, if you want the guide
// track, is imported as a normal audio track — trimmed, faded, metered and
// bounced like everything else, instead of a second sound path with none of
// that.  An audible `<video>` would also be a second clock, and there is
// exactly one clock here.
//
// Nothing in this file decides WHERE the picture should be.  It hands the
// transport's position to the follower and draws what came back.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { useVideoStore, videoFollower } from '../../../stores/videoStore.js';
import {
  FRAME_RATES, describeVideo, formatTimecode, frameSec, nearestFrameRate,
  parseTimecode, videoOf, videoTimeAt, withVideo, type VideoRef,
} from '../../../daw/model/video.js';
import { describeSync } from '../../../daw/engine/video-sync.js';
import { toFileUrl } from '../../../utils/fileUrl.js';
import { nextId } from '../../../daw/model/ids.js';
import { premium } from '../../../theme/premium.js';
import {
  describeVideoPosition, nudgeVideoFrames, spotVideoTimecode,
} from '../../../daw/edit/video-move.js';

interface ProbeResult {
  path: string; name: string; durationSec: number; fps: number;
  width: number; height: number; startTimecodeSec: number; hasAudio: boolean;
}

export default function VideoViewer() {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const seek = useDawStore((s) => s.seek);
  const notify = useAppStore((s) => s.notify);
  const { open, width, dropFrame, showDrift, probing } = useVideoStore();
  const setOpen = useVideoStore((s) => s.setOpen);
  const setWidth = useVideoStore((s) => s.setWidth);
  const setDropFrame = useVideoStore((s) => s.setDropFrame);
  const setShowDrift = useVideoStore((s) => s.setShowDrift);
  const setProbing = useVideoStore((s) => s.setProbing);

  const videoRef = useRef<HTMLVideoElement>(null);
  // Opens clear of the toolbars, not over them.  A viewer whose first act is
  // to cover the buttons you were about to press is a viewer you drag before
  // you ever look at it.
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, (globalThis.innerWidth || 1280) - 460),
    y: 150,
  }));
  const [tcDraft, setTcDraft] = useState<string | null>(null);
  const [spotDraft, setSpotDraft] = useState<string | null>(null);

  const video = videoOf(session);

  // The element only exists while the viewer is open, so attaching is tied to
  // both.  Detaching pauses it — a hidden video that keeps decoding is a
  // hidden video that keeps burning battery.
  useEffect(() => {
    if (open && video && videoRef.current) videoFollower.attach(videoRef.current);
    else videoFollower.detach();
    return () => videoFollower.detach();
  }, [open, video?.id]);

  // The transport reports; the follower decides.  This runs on every position
  // report, which is why the ladder in video-sync.ts holds most of the time.
  useEffect(() => {
    if (!open || !video) return;
    videoFollower.follow(videoTimeAt(video, playheadSec), isPlaying);
  }, [open, video, playheadSec, isPlaying]);

  const loadVideo = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) { notify('electronAPI를 사용할 수 없습니다', 'error'); return; }
    const paths = await api.invoke('file:open-dialog-multi') as string[] | null;
    const first = paths?.[0];
    if (!first) return;
    setProbing('영상 분석 중…');
    try {
      const probe = await api.invoke('video:probe', first) as ProbeResult;
      const ref: VideoRef = {
        id: nextId('video'),
        path: probe.path,
        name: probe.name,
        startSec: 0,
        offsetSec: 0,
        durationSec: probe.durationSec,
        fps: probe.fps > 0 ? probe.fps : 25,
        startTimecodeSec: probe.startTimecodeSec,
        width: probe.width,
        height: probe.height,
      };
      apply((s) => withVideo(s, ref));
      setOpen(true);
      if (probe.fps <= 0) {
        notify('프레임 레이트를 읽지 못했습니다 — 25 로 두었습니다. 헤더에서 고치세요', 'warning');
      } else if (probe.hasAudio) {
        notify(`${probe.name} — 영상의 소리는 나지 않습니다. 필요하면 오디오로 따로 가져오세요`);
      } else {
        notify(`${probe.name} 을 불러왔습니다`, 'success');
      }
    } catch (err) {
      notify(`영상을 읽지 못했습니다: ${(err as Error).message}`, 'error');
    } finally { setProbing(null); }
  }, [apply, notify, setOpen, setProbing]);

  if (!open) return null;

  const rate = video ? nearestFrameRate(video.fps) : null;
  const canDrop = rate?.dropFrame ?? false;
  const into = video ? videoTimeAt(video, playheadSec) : null;
  const timecode = video && into !== null
    ? formatTimecode(video.startTimecodeSec + into, video.fps, dropFrame && canDrop)
    : '--:--:--:--';
  const aspect = video && video.width > 0 && video.height > 0
    ? video.height / video.width : 9 / 16;

  const onTitleDown = (e: React.PointerEvent): void => {
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    const move = (ev: PointerEvent): void =>
      setPos({ x: Math.max(0, ev.clientX - startX), y: Math.max(0, ev.clientY - startY) });
    const up = (): void => {
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  /** Typing a timecode locates there — the spotting note says 01:02:14:07. */
  const goToTimecode = (text: string): void => {
    if (!video) return;
    const parsed = parseTimecode(text, video.fps);
    setTcDraft(null);
    if (parsed === null) { notify('타임코드를 읽지 못했습니다 (01:02:14:07)', 'warning'); return; }
    const timeline = parsed - video.startTimecodeSec - video.offsetSec + video.startSec;
    if (timeline < 0) { notify('그 타임코드는 픽처 앞입니다', 'warning'); return; }
    seek(timeline);
  };

  const nudgeFrames = (frames: number): void => {
    if (!video) return;
    seek(Math.max(0, playheadSec + frames * frameSec(video.fps)));
  };

  /**
   * Spot the reel: move the PICTURE so this timecode lands on the play head.
   *
   * The inverse of locating.  Both operations start from the same number a
   * spotting note carries — "the door slams at 01:02:14:07" — and which one
   * you want depends on whether the picture is already placed.  Locating
   * moves you; spotting moves the film.
   */
  const spotHere = (text: string): void => {
    if (!video) return;
    const parsed = parseTimecode(text, video.fps);
    setSpotDraft(null);
    if (parsed === null) { notify('타임코드를 읽지 못했습니다 (01:02:14:07)', 'warning'); return; }
    let reason: string | null = null;
    apply((s) => {
      const r = spotVideoTimecode(s, parsed, playheadSec);
      reason = r.reason;
      return r.applied ? r.session : s;
    });
    if (reason) { notify(reason, 'warning'); return; }
    notify(`픽처를 옮겼습니다 — ${describeVideoPosition(useDawStore.getState().session)}`, 'success');
  };

  const shiftPicture = (frames: number): void => {
    let reason: string | null = null;
    apply((s) => {
      const r = nudgeVideoFrames(s, frames);
      reason = r.reason;
      return r.applied ? r.session : s;
    });
    if (reason) notify(reason, 'warning');
  };

  return (
    <div
      className="fixed z-40 rounded shadow-2xl overflow-hidden"
      style={{
        left: pos.x, top: pos.y, width,
        background: premium.surface.panel,
        border: `1px solid ${premium.surface.hairline}`,
      }}
    >
      {/* Title bar — also the drag handle. */}
      <div
        onPointerDown={onTitleDown}
        className="flex items-center gap-1 px-2 py-1 cursor-move select-none"
        style={{ background: '#14141c', borderBottom: `1px solid ${premium.surface.hairline}` }}
      >
        <span style={{ fontSize: 9.5, letterSpacing: '0.12em', color: premium.text.faint }}>PICTURE</span>
        <span className="truncate" style={{ fontSize: 10, color: premium.text.muted, maxWidth: 140 }}>
          {video?.name ?? '없음'}
        </span>
        <div className="flex-1" />
        <button onClick={() => setWidth(width - 80)} style={chip}>−</button>
        <button onClick={() => setWidth(width + 80)} style={chip}>+</button>
        <button onClick={() => setOpen(false)} title="닫기" style={chip}>×</button>
      </div>

      {video ? (
        <video
          ref={videoRef}
          src={toFileUrl(video.path)}
          muted
          playsInline
          preload="auto"
          style={{ width: '100%', height: width * aspect, background: '#000', display: 'block' }}
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-2"
             style={{ height: width * aspect, background: '#000' }}>
          <span style={{ fontSize: 11, color: premium.text.muted }}>픽처가 없습니다</span>
          <button onClick={() => { void loadVideo(); }} style={{ ...chip, height: 24, padding: '0 10px' }}>
            영상 불러오기
          </button>
          {probing && <span style={{ fontSize: 10, color: premium.accent.base }}>{probing}</span>}
        </div>
      )}

      {/* Timecode strip.  Monospace and large, because it is read at a glance
          from across a room while somebody else talks about the scene. */}
      <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap"
           style={{ background: '#0C0C12', borderTop: `1px solid ${premium.surface.hairline}` }}>
        {tcDraft === null ? (
          <span
            onDoubleClick={() => setTcDraft(timecode)}
            title="더블클릭해서 타임코드로 이동"
            style={{
              fontFamily: premium.type.mono, fontSize: 15, letterSpacing: '0.04em',
              color: into === null ? premium.text.faint : premium.accent.light, cursor: 'text',
            }}
          >{timecode}</span>
        ) : (
          <input
            autoFocus
            defaultValue={tcDraft}
            onBlur={(e) => goToTimecode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setTcDraft(null);
            }}
            style={{
              fontFamily: premium.type.mono, fontSize: 15, width: 130,
              background: 'transparent', color: premium.text.primary,
              border: `1px solid ${premium.accent.deep}`, borderRadius: 3, padding: '0 4px',
            }}
          />
        )}

        <button onClick={() => nudgeFrames(-1)} title="한 프레임 뒤로" style={chip}>◀</button>
        <button onClick={() => nudgeFrames(1)} title="한 프레임 앞으로" style={chip}>▶</button>

        {/* Moving the PICTURE, not the play head.  Deliberately a separate
            pair of buttons from the two above: one moves you through the
            film, the other moves the film, and a spotting session needs both
            within reach without them looking like the same control. */}
        {video && (
          <>
            <span style={{ fontSize: 9, color: premium.text.faint, marginLeft: 4 }}>픽처</span>
            <button onClick={() => shiftPicture(-1)} title="픽처를 한 프레임 앞으로" style={chip}>−1</button>
            <button onClick={() => shiftPicture(1)} title="픽처를 한 프레임 뒤로" style={chip}>+1</button>
            {spotDraft === null ? (
              <button
                onClick={() => setSpotDraft(timecode === '--:--:--:--' ? '01:00:00:00' : timecode)}
                title="타임코드를 입력하면 그 프레임이 재생헤드에 오도록 픽처를 옮깁니다"
                style={chip}
              >스팟</button>
            ) : (
              <input
                autoFocus
                defaultValue={spotDraft}
                onBlur={(e) => spotHere(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setSpotDraft(null);
                }}
                title="이 타임코드가 재생헤드에 오도록"
                style={{
                  fontFamily: premium.type.mono, fontSize: 11, width: 104,
                  background: 'transparent', color: premium.accent.light,
                  border: `1px solid ${premium.accent.base}`, borderRadius: 3, padding: '0 4px',
                }}
              />
            )}
          </>
        )}

        <div className="flex-1" />

        {video && (
          <select
            value={rate?.label ?? '25'}
            onChange={(e) => {
              const picked = FRAME_RATES.find((r) => r.label === e.target.value);
              if (!picked) return;
              setDropFrame(picked.dropFrame);
              apply((s) => {
                const current = videoOf(s);
                return current ? withVideo(s, { ...current, fps: picked.fps }) : s;
              });
            }}
            title="프레임 레이트 — ffprobe 가 읽은 값입니다"
            style={{
              height: 18, fontSize: 9, borderRadius: 2, background: 'transparent',
              color: premium.text.muted, border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            {FRAME_RATES.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
          </select>
        )}
        <button onClick={() => setShowDrift(!showDrift)}
                title="동기 상태 표시" style={chip}>SYNC</button>
        {video && (
          <button onClick={() => { apply((s) => withVideo(s, null)); }}
                  title="픽처 제거" style={chip}>비우기</button>
        )}
      </div>

      {showDrift && (
        <div className="px-2 py-0.5" style={{ background: '#0C0C12' }}>
          <span style={{ fontFamily: premium.type.mono, fontSize: 9.5, color: premium.text.faint }}>
            {describeSync(videoFollower.decision)}
            {video ? ` · ${describeVideo(video)}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

const chip: React.CSSProperties = {
  height: 17, padding: '0 5px', borderRadius: 2, fontSize: 9,
  fontFamily: premium.type.mono, background: 'transparent',
  color: premium.text.muted, border: '1px solid rgba(255,255,255,0.14)',
};
