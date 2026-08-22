// The Spot dialog — where does this go?
//
// It opens instead of a drag, because that is what Spot mode is for: the
// position is known to the frame and the mouse cannot express it.
//
// Three decisions shape it:
//
//   IT OPENS ON THE CLIP'S CURRENT POSITION, SELECTED.  The common gesture
//   is "nearly right, nudge it" as often as "here is a number from a note",
//   and starting from where the clip is means both work by typing over it.
//
//   EVERY FORMAT IS SHOWN, ALWAYS.  A position typed in bars reads back in
//   timecode underneath, which is how you notice that bar 17 is not where
//   the spotting note said before you commit it.
//
//   IT SAYS HOW FAR IT WILL MOVE.  "+412 ms" is the number that tells you a
//   typo happened; the destination on its own does not.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useVideoStore } from '../../../stores/videoStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import { tempoMapOf } from '../../../daw/model/tempo-map.js';
import { videoOf } from '../../../daw/model/video.js';
import {
  DEFAULT_FPS, TIME_FORMATS, describeAllFormats, formatHint, formatLabel,
  formatPosition, parsePosition, type SpotContext, type TimeFormat,
} from '../../../daw/model/spot-time.js';
import {
  anchorLabel, anchorSec, describeDelta, findClip, spotClip, spotDeltaSec,
  spotProblem, type SpotAnchor,
} from '../../../daw/edit/spot-actions.js';

export interface SpotTarget { trackId: string; clipId: string }

export default function SpotDialog({
  target, onClose,
}: { target: SpotTarget; onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const dropFrame = useVideoStore((s) => s.dropFrame);

  const [format, setFormat] = useState<TimeFormat>('timecode');
  const [anchor, setAnchor] = useState<SpotAnchor>('start');
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const clip = findClip(session, target.trackId, target.clipId);
  const video = videoOf(session);

  const ctx: SpotContext = useMemo(() => ({
    sampleRate: session.sampleRate,
    tempoMap: tempoMapOf(session),
    fps: video?.fps ?? DEFAULT_FPS,
    dropFrame,
    timecodeOffsetSec: video ? video.startTimecodeSec - video.startSec + video.offsetSec : 0,
  }), [session, video, dropFrame]);

  // Opening, and every change of format or anchor, refills from where the
  // clip actually is — the dialog is never showing a stale number.
  useEffect(() => {
    if (!clip) return;
    setText(formatPosition(anchorSec(clip, anchor), format, ctx));
    const input = inputRef.current;
    if (input) { input.focus(); input.select(); }
  }, [clip?.id, format, anchor]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!clip) return null;

  const parsed = parsePosition(text, format, ctx);
  const delta = parsed === null ? null : spotDeltaSec(clip, parsed, anchor);
  const problem = parsed === null ? null : spotProblem(clip, parsed, anchor);

  const commit = (): void => {
    if (parsed === null) { notify(`${formatLabel(format)} 형식이 아닙니다 (${formatHint(format)})`, 'warning'); return; }
    const result = spotClip(session, target.trackId, target.clipId, parsed, anchor);
    if (!result.applied) {
      if (result.reason) { notify(result.reason, 'warning'); return; }
      onClose();
      return;
    }
    apply(() => result.session);
    notify(`${clip.name} → ${formatPosition(parsed, format, ctx)} (${describeDelta(delta ?? 0)})`, 'success');
    onClose();
  };

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-24"
         style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[440px] max-w-[92vw] rounded overflow-hidden"
        style={{
          background: premium.surface.panel,
          border: `1px solid ${premium.surface.hairlineStrong}`,
          boxShadow: premium.shadow.panel,
        }}
      >
        <div className="px-4 py-2 flex items-baseline gap-2"
             style={{ borderBottom: `1px solid ${premium.surface.hairline}` }}>
          <span style={{ fontFamily: premium.type.display, fontSize: 16, color: premium.accent.light }}>
            Spot
          </span>
          <span className="truncate" style={{ fontSize: 11, color: premium.text.muted }}>
            {clip.name}
          </span>
        </div>

        <div className="px-4 py-3 space-y-2">
          <div className="flex gap-1">
            {TIME_FORMATS.map((f) => (
              <button key={f} onClick={() => setFormat(f)}
                style={{
                  flex: 1, height: 22, borderRadius: 3, fontSize: 10,
                  color: format === f ? premium.text.onAccent : premium.text.muted,
                  background: format === f ? premium.accent.base : premium.surface.well,
                  border: `1px solid ${premium.surface.hairline}`,
                }}>{formatLabel(f)}</button>
            ))}
          </div>

          <div className="flex gap-1">
            {(['start', 'end'] as SpotAnchor[]).map((a) => (
              <button key={a} onClick={() => setAnchor(a)}
                title={a === 'end' ? '이 시각에 클립이 끝나도록 놓습니다' : '이 시각에 클립이 시작하도록 놓습니다'}
                style={{
                  flex: 1, height: 20, borderRadius: 3, fontSize: 10,
                  color: anchor === a ? premium.accent.light : premium.text.muted,
                  background: premium.surface.well,
                  border: `1px solid ${anchor === a ? premium.accent.deep : premium.surface.hairline}`,
                }}>{anchorLabel(a)}</button>
            ))}
          </div>

          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            placeholder={formatHint(format)}
            spellCheck={false}
            style={{
              width: '100%', height: 34, borderRadius: 3, padding: '0 8px',
              fontFamily: premium.type.mono, fontSize: 17, letterSpacing: '0.04em',
              background: premium.surface.well,
              color: parsed === null ? premium.accent.danger : premium.text.primary,
              border: `1px solid ${parsed === null ? premium.accent.danger : premium.accent.deep}`,
            }}
          />

          {/* The same position in every language, so a number typed in one
              can be checked against the one the note was written in. */}
          <p style={{ fontSize: 9, fontFamily: premium.type.mono, color: premium.text.faint }}>
            {parsed === null ? `${formatLabel(format)} 형식이 아닙니다 — 예: ${formatHint(format)}`
              : describeAllFormats(parsed, ctx)}
          </p>
          <p style={{ fontSize: 10, color: problem ? premium.accent.danger : premium.text.muted }}>
            {parsed === null ? ' '
              : problem ? problem
              : `${anchorLabel(anchor)} · ${describeDelta(delta ?? 0)}`}
            {video || problem ? '' : '  ·  픽처가 없어 타임코드는 25 fps 기준입니다'}
          </p>
        </div>

        <div className="px-4 py-2 flex justify-end gap-1"
             style={{ borderTop: `1px solid ${premium.surface.hairline}` }}>
          <Small onClick={onClose}>취소</Small>
          <Small onClick={commit} accent>놓기</Small>
        </div>
      </div>
    </div>
  );
}

function Small({ onClick, children, accent }: {
  onClick: () => void; children: React.ReactNode; accent?: boolean;
}) {
  return (
    <button onClick={onClick} className="h-6 px-3 rounded"
      style={{
        fontSize: 10,
        color: accent ? premium.text.onAccent : premium.text.secondary,
        background: accent ? premium.accent.base : premium.surface.overlay,
        border: `1px solid ${premium.surface.hairline}`,
      }}>{children}</button>
  );
}
