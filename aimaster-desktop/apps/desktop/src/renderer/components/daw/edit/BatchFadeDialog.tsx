// BatchFadeDialog — the same fade on everything selected, previewed first.
//
// A key that silently puts 5 ms on forty clips is one nobody presses twice:
// the length and which edges ARE the decision, and they need to be visible
// while being made.  So the dialog says how many clips it will touch and how
// many of them are too short to take the fade whole, before anything happens.

import React, { useMemo, useState } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { useAppStore } from '../../../stores/appStore.js';
import { premium } from '../../../theme/premium.js';
import {
  DEFAULT_BATCH_FADE, EDGE_LABELS, MAX_BATCH_FADE_SEC, MIN_BATCH_FADE_SEC,
  batchFade, clampFadeSec, countSelectedClips, describeBatchFade,
  type BatchFadeOptions, type FadeEdges,
} from '../../../daw/edit/batch-fade.js';
import type { FadeShape } from '../../../daw/model/types.js';
import type { TimeSelection } from '../../../daw/edit/clip-edit.js';

const SHAPES: { id: FadeShape; label: string }[] = [
  { id: 'equalPower', label: '등파워' },
  { id: 'linear', label: '직선' },
  { id: 'sCurve', label: 'S 커브' },
];

export default function BatchFadeDialog({
  selection, onClose,
}: { selection: TimeSelection; onClose: () => void }) {
  const session = useDawStore((s) => s.session);
  const apply = useDawStore((s) => s.apply);
  const notify = useAppStore((s) => s.notify);
  const [options, setOptions] = useState<BatchFadeOptions>(DEFAULT_BATCH_FADE);

  const clips = useMemo(() => countSelectedClips(session, selection), [session, selection]);
  // Run it against a throwaway copy to get the real summary — the same code
  // that will do the work, so the preview cannot disagree with the result.
  const preview = useMemo(
    () => batchFade(session, selection, options).summary,
    [session, selection, options],
  );

  const run = (): void => {
    const { session: next, summary } = batchFade(session, selection, options);
    if (summary.fades === 0) { notify('넣을 페이드가 없습니다', 'warning'); return; }
    apply(() => next);
    notify(describeBatchFade(summary), 'success');
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
        data-testid="batch-fade"
      >
        <h2 style={{ fontFamily: premium.type.display, fontSize: 17, marginBottom: 2 }}>
          일괄 페이드 — 클립 {clips}개
        </h2>
        <p style={{ fontSize: 11, color: premium.text.muted, marginBottom: 14 }}>
          클립보다 긴 페이드는 <b>절반으로 줄여서</b> 넣습니다 — 거절하면 어느 게 들어갔는지
          알 수 없으니까요.
        </p>

        <div className="flex items-center gap-3 mb-2">
          <label style={{ width: 60, fontSize: 12, color: premium.text.secondary }}>길이</label>
          <input
            type="range" className="flex-1"
            min={MIN_BATCH_FADE_SEC} max={0.5} step={0.001}
            value={Math.min(options.durationSec, 0.5)}
            onChange={(e) => setOptions((o) => ({ ...o, durationSec: clampFadeSec(Number(e.target.value)) }))}
            data-testid="fade-length"
          />
          <input
            type="number" step={0.001} min={MIN_BATCH_FADE_SEC} max={MAX_BATCH_FADE_SEC}
            value={options.durationSec}
            style={{
              width: 76, background: '#1d1d28', border: '1px solid #3a3a48',
              borderRadius: 4, padding: '2px 6px', fontSize: 11,
              color: premium.accent.light, fontFamily: 'monospace',
            }}
            onChange={(e) => setOptions((o) => ({ ...o, durationSec: clampFadeSec(Number(e.target.value)) }))}
          />
          <span style={{ fontSize: 11, color: premium.text.muted, width: 46 }}>
            {(options.durationSec * 1000).toFixed(0)} ms
          </span>
        </div>

        <div className="flex items-center gap-3 mb-2">
          <label style={{ width: 60, fontSize: 12, color: premium.text.secondary }}>모양</label>
          <div className="flex gap-1">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                className="px-2 py-1 rounded text-[11px]"
                style={{
                  background: options.shape === s.id ? premium.accent.base : '#2a2a36',
                  color: options.shape === s.id ? '#101018' : premium.text.secondary,
                }}
                onClick={() => setOptions((o) => ({ ...o, shape: s.id }))}
              >{s.label}</button>
            ))}
          </div>
        </div>

        <div className="flex items-start gap-3 mb-3">
          <label style={{ width: 60, fontSize: 12, color: premium.text.secondary }}>위치</label>
          <div className="flex flex-col gap-1">
            {(Object.keys(EDGE_LABELS) as FadeEdges[]).map((e) => (
              <label key={e} className="flex items-center gap-2" style={{ fontSize: 11 }}>
                <input
                  type="radio" checked={options.edges === e}
                  onChange={() => setOptions((o) => ({ ...o, edges: e }))}
                  data-testid={`fade-edge-${e}`}
                />
                {EDGE_LABELS[e]}
              </label>
            ))}
          </div>
        </div>

        <div className="rounded px-3 py-2 mb-3" style={{ background: '#1d1d28', fontSize: 12 }}
          data-testid="fade-preview">
          {describeBatchFade(preview)}
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: '#2a2a36', color: premium.text.secondary }}
            onClick={() => setOptions(DEFAULT_BATCH_FADE)}
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
            data-testid="fade-apply"
          >적용</button>
        </div>
      </div>
    </div>
  );
}
