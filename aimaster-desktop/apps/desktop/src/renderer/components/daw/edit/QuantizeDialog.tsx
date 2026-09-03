// Audio quantize — see what it will move before it moves it.
//
// Auto-Warp (Mod+Shift+W) is still there and still snaps hard to a
// sixteenth; this is the same machinery with the four controls that make it
// usable on a performance rather than on a loop.  The preview is the point:
// "17 of 42 hits move, 12 ms on average, 38 ms at worst" tells you whether
// the take needs quantizing at all, and a take that does not need it is the
// most common answer.
//
// It works on the SELECTION, so with an edit group a whole kit quantizes to
// the same grid in one press — which is the only way multitrack drums can be
// quantized without smearing the phase between the mics.

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import { transientsFor } from '../../../daw/engine/audio-cache.js';
import { findTrack, trackClips } from '../../../daw/model/session-ops.js';
import type { TimeSelection } from '../../../daw/edit/clip-edit.js';
import { clipsInSelection, quantizeClips } from '../../../daw/edit/warp-actions.js';
import {
  clampQuantize, describeQuantize, quantizeHits, summariseQuantize,
  DEFAULT_QUANTIZE, GRID_CHOICES, QUANTIZE_LIMITS, type QuantizeOptions,
} from '../../../daw/edit/audio-quantize.js';

const KEYS: Array<'strength' | 'swing' | 'toleranceMs'> = ['strength', 'swing', 'toleranceMs'];

export default function QuantizeDialog({
  selection, onClose,
}: { selection: TimeSelection; onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const [options, setOptions] = useState<QuantizeOptions>(DEFAULT_QUANTIZE);

  const targets = useMemo(
    () => clipsInSelection(session, selection.trackIds, selection.startSec, selection.endSec),
    [session, selection],
  );

  // Re-analysed on every change of the numbers.  The transients are cached by
  // the audio cache, so this is arithmetic over a few hundred marks rather
  // than a re-scan of the audio.
  const summary = useMemo(() => {
    const held = clampQuantize(options);
    const hits = targets.flatMap(({ trackId, clipId }) => {
      const track = findTrack(session, trackId);
      const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
      if (!clip) return [];
      const from = clip.offsetSec;
      const to = clip.offsetSec + clip.durationSec;
      const marks = transientsFor(clip.fileId).filter((t) => t > from && t < to);
      return quantizeHits(marks, session.tempoBpm, from, clip.durationSec, held);
    });
    return summariseQuantize(hits);
  }, [session, targets, options]);

  const run = (): void => {
    if (summary.moved === 0) { notify(describeQuantize(summary), 'warning'); return; }
    let done = summary;
    apply((s) => {
      const result = quantizeClips(s, targets, clampQuantize(options));
      done = result.summary;
      return result.session;
    });
    notify(`오디오 퀀타이즈 — ${describeQuantize(done)}`, 'success');
    onClose();
  };

  const show = (key: 'strength' | 'swing' | 'toleranceMs'): string =>
    key === 'toleranceMs'
      ? `${options[key].toFixed(0)} ms`
      : `${(options[key] * 100).toFixed(0)} %`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        className="rounded-lg border p-5"
        style={{
          minWidth: 440, background: '#15151d', borderColor: '#3a3a48',
          fontFamily: premium.type.sans, color: premium.text.primary,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontFamily: premium.type.display, fontSize: 17, marginBottom: 2 }}>
          오디오 퀀타이즈
        </h2>
        <p style={{ fontSize: 11, color: premium.text.muted, marginBottom: 14 }}>
          선택한 클립의 트랜지언트를 그리드로 당깁니다. 워프 마커로 들어가므로 나중에
          <b> Warp 에디터</b>에서 눈으로 보고 손으로 고칠 수 있습니다.
        </p>

        <div className="flex items-center gap-3 mb-3">
          <label style={{ width: 110, fontSize: 12, color: premium.text.secondary }}>그리드</label>
          <div className="flex gap-1 flex-wrap">
            {GRID_CHOICES.map((g) => (
              <button
                key={g.label}
                onClick={() => setOptions((o) => ({ ...o, gridBeats: g.beats }))}
                className="px-2 py-1 rounded text-[11px] border"
                style={Math.abs(options.gridBeats - g.beats) < 1e-9
                  ? { background: 'rgba(129,140,248,0.25)', borderColor: 'rgba(129,140,248,0.5)', color: premium.accent.light }
                  : { background: '#1d1d28', borderColor: '#3a3a48', color: premium.text.muted }}
              >{g.label}</button>
            ))}
          </div>
        </div>

        {KEYS.map((key) => {
          const limit = QUANTIZE_LIMITS[key];
          return (
            <div key={key} className="flex items-center gap-3 mb-2">
              <label style={{ width: 110, fontSize: 12, color: premium.text.secondary }}>
                {limit.label}
              </label>
              <input
                type="range"
                min={limit.min} max={limit.max} step={limit.step} value={options[key]}
                className="flex-1"
                onChange={(e) => setOptions((o) => ({ ...o, [key]: Number(e.target.value) }))}
              />
              <span style={{
                width: 62, textAlign: 'right', fontSize: 12, color: premium.accent.light,
              }}>{show(key)}</span>
            </div>
          );
        })}

        <div className="mt-3 mb-3 rounded px-3 py-2" style={{ background: '#1d1d28', fontSize: 13 }}>
          {describeQuantize(summary)}
          <div style={{ fontSize: 11, color: premium.text.muted, marginTop: 4 }}>
            클립 {targets.length}개 · {session.tempoBpm.toFixed(1)} BPM 기준
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: '#2a2a36', color: premium.text.secondary }}
            onClick={() => setOptions(DEFAULT_QUANTIZE)}
          >기본값</button>
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: '#2a2a36', color: premium.text.secondary }}
            onClick={onClose}
          >취소</button>
          <button
            className="px-4 py-1.5 rounded text-sm"
            style={{ background: premium.accent.base, color: '#101018', fontWeight: 600 }}
            onClick={run}
          >적용</button>
        </div>
      </div>
    </div>
  );
}
