// Detect Silence — look before you cut.
//
// The command existed and worked, but it ran on four numbers nobody could
// reach and cut the moment it was pressed.  Both halves of that are wrong for
// this particular job: a threshold that suits a close vocal shreds a room
// mic, and a strip is destructive enough that "let me see how much that takes
// out" is the first thing anyone asks.
//
// So the dialog re-analyses on every change and shows the answer — how many
// clips, how many pieces, how much time removed — while the numbers are still
// being dragged.  Nothing is cut until 적용 is pressed.
//
// It works on the SELECTION, not the clip under the play head.  The routine
// this belongs to is "clean the take, then bounce it" (V), and doing that one
// clip at a time is the hand editing the command exists to replace.

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import { getCached, monoSum } from '../../../daw/engine/audio-cache.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import { overlapsSelection, type TimeSelection } from '../../../daw/edit/clip-edit.js';
import {
  clampStrip, describeSummary, findSoundRegions, stripClipsSilence, summariseStrip,
  DEFAULT_STRIP, STRIP_LIMITS, type ClipRegions, type StripOptions,
} from '../../../daw/edit/strip-silence.js';

const KEYS: Array<keyof StripOptions> = ['thresholdDb', 'minSilenceSec', 'minSoundSec', 'padSec'];

export default function StripSilenceDialog({
  selection, onClose,
}: { selection: TimeSelection; onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const [options, setOptions] = useState<StripOptions>(DEFAULT_STRIP);

  // Re-analysed on every change.  A vocal take is a few million samples and
  // the envelope walks it at 10 ms hops, which is fast enough to keep up with
  // a slider — and a preview that lags the number it is previewing is worse
  // than none.
  const plan = useMemo<ClipRegions[]>(() => {
    const held = clampStrip(options);
    const out: ClipRegions[] = [];
    for (const trackId of selection.trackIds) {
      const track = findTrack(session, trackId);
      if (!track) continue;
      for (const clip of trackClips(track)) {
        if (clip.kind !== 'audio' || !overlapsSelection(clip, selection)) continue;
        const cached = getCached(clip.fileId);
        if (!cached) continue;
        const rate = cached.buffer.sampleRate;
        const mono = monoSum(cached.buffer);
        // Analysed over the clip's own span of the file, so trimming a take
        // does not drag the neighbouring phrase into the decision.
        const from = Math.max(0, Math.round(clip.offsetSec * rate));
        const to = Math.min(mono.length, Math.round((clip.offsetSec + clip.durationSec) * rate));
        if (to <= from) continue;
        out.push({
          trackId, clipId: clip.id, clipDurationSec: clip.durationSec,
          regions: findSoundRegions(mono.subarray(from, to), rate, held),
        });
      }
    }
    return out;
  }, [session, selection, options]);

  const summary = useMemo(() => summariseStrip(plan), [plan]);
  const undecoded = useMemo(() => {
    let n = 0;
    for (const trackId of selection.trackIds) {
      const track = findTrack(session, trackId);
      if (!track) continue;
      for (const clip of trackClips(track)) {
        if (clip.kind === 'audio' && overlapsSelection(clip, selection) && !getCached(clip.fileId)) n += 1;
      }
    }
    return n;
  }, [session, selection]);

  const run = (): void => {
    if (summary.clips === 0) { notify('자를 무음이 없습니다 — 임계값을 올려 보세요', 'warning'); return; }
    apply((s) => stripClipsSilence(s, plan).session);
    notify(`무음 제거 — ${describeSummary(summary)}`, 'success');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        className="rounded-lg border p-5"
        style={{
          minWidth: 420, background: '#15151d', borderColor: '#3a3a48',
          fontFamily: premium.type.sans, color: premium.text.primary,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontFamily: premium.type.display, fontSize: 17, marginBottom: 2 }}>
          무음 제거 (Detect Silence)
        </h2>
        <p style={{ fontSize: 11, color: premium.text.muted, marginBottom: 14 }}>
          선택한 클립에서 숨소리·잡음 구간을 잘라냅니다. 클립은 제자리에 남고, 잘린 자리는
          빈칸이 됩니다 — 이어서 <b>V</b>(바운스)를 누르면 그 빈칸이 완전한 무음으로 채워져
          하나의 파일이 됩니다.
        </p>

        {KEYS.map((key) => {
          const limit = STRIP_LIMITS[key];
          const value = options[key];
          return (
            <div key={key} className="flex items-center gap-3 mb-2">
              <label style={{ width: 110, fontSize: 12, color: premium.text.secondary }}>
                {limit.label}
              </label>
              <input
                type="range"
                min={limit.min} max={limit.max} step={limit.step} value={value}
                className="flex-1"
                onChange={(e) => setOptions((o) => ({ ...o, [key]: Number(e.target.value) }))}
              />
              <span style={{
                width: 78, textAlign: 'right', fontSize: 12,
                fontFamily: premium.type.mono ?? 'monospace', color: premium.accent.light,
              }}>
                {key === 'thresholdDb' ? value.toFixed(0) : value.toFixed(key === 'padSec' ? 3 : 2)} {limit.unit}
              </span>
            </div>
          );
        })}

        <div
          className="mt-3 mb-3 rounded px-3 py-2"
          style={{ background: '#1d1d28', fontSize: 13 }}
        >
          {describeSummary(summary)}
          {undecoded > 0 && (
            <div style={{ fontSize: 11, color: premium.text.muted, marginTop: 4 }}>
              읽히지 않은 클립 {undecoded}개는 분석에서 빠졌습니다.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: '#2a2a36', color: premium.text.secondary }}
            onClick={() => setOptions(DEFAULT_STRIP)}
          >
            기본값
          </button>
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: '#2a2a36', color: premium.text.secondary }}
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="px-4 py-1.5 rounded text-sm"
            style={{ background: premium.accent.base, color: '#101018', fontWeight: 600 }}
            onClick={run}
          >
            적용
          </button>
        </div>
      </div>
    </div>
  );
}
