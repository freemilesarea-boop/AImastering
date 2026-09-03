// Undo history — the stack, as a list you can jump around in.
//
// Pressing Mod+Z nine times and watching the screen to work out where you are
// is the thing this replaces.  The labels are DERIVED from the snapshots (see
// daw/edit/history-log.ts) rather than recorded at each of the two hundred
// call sites, so a step cannot be mislabelled by a call site that forgot.
//
// Jumping goes through `undo`/`redo` one step at a time rather than setting
// the history directly.  Slower, and deliberately so: those two are what
// re-sync the audio graph, and a jump that skipped them would leave the
// timeline showing one session while the engine plays another.

import React, { useMemo } from 'react';
import { useDawStore } from '../../../stores/dawStore.js';
import { premium } from '../../../theme/premium.js';
import { focusSecOf, historyEntries, stepsTo } from '../../../daw/edit/history-log.js';

export default function HistoryPanel({ onClose }: { onClose: () => void }) {
  const history = useDawStore((s) => s.history);
  const undo = useDawStore((s) => s.undo);
  const redo = useDawStore((s) => s.redo);
  const seek = useDawStore((s) => s.seek);

  const entries = useMemo(() => historyEntries(history), [history]);
  const chain = useMemo(
    () => [...history.past, history.present, ...history.future],
    [history],
  );

  const jumpTo = (index: number): void => {
    const steps = stepsTo(history.past.length, index);
    for (let i = 0; i < Math.abs(steps); i++) {
      if (steps < 0) undo(); else redo();
    }
    // Land the play head on what the step touched, so the jump is visible
    // rather than something you have to go looking for.
    const before = chain[Math.max(0, index - 1)];
    const after = chain[index];
    if (before && after) {
      const at = focusSecOf(before, after);
      if (at !== null) seek(at);
    }
  };

  return (
    <div
      className="absolute right-3 rounded-lg border overflow-hidden"
      style={{
        top: 56, width: 260, maxHeight: 400, zIndex: 40,
        background: '#15151d', borderColor: '#3a3a48',
        fontFamily: premium.type.sans, color: premium.text.primary,
      }}
      data-testid="history-panel"
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: '#2a2a36' }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>실행취소 히스토리</span>
        <button
          className="text-xs px-2 py-0.5 rounded"
          style={{ background: '#2a2a36', color: premium.text.secondary }}
          onClick={onClose}
        >
          닫기
        </button>
      </div>

      <div className="overflow-auto" style={{ maxHeight: 340 }}>
        {entries.map((entry) => (
          <button
            key={entry.index}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2"
            style={{
              fontSize: 12,
              background: entry.current ? '#26263a' : 'transparent',
              color: entry.future ? premium.text.muted : premium.text.primary,
              opacity: entry.future ? 0.55 : 1,
              cursor: entry.current ? 'default' : 'pointer',
            }}
            onClick={() => { if (!entry.current) jumpTo(entry.index); }}
            data-testid={`history-step-${entry.index}`}
          >
            <span
              style={{
                width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                background: entry.current ? premium.accent.base : 'transparent',
                border: `1px solid ${entry.current ? premium.accent.base : '#3a3a48'}`,
              }}
            />
            <span style={{ flex: 1 }}>{entry.label}</span>
          </button>
        ))}
      </div>

      <div
        className="px-3 py-1.5 border-t"
        style={{ borderColor: '#2a2a36', fontSize: 11, color: premium.text.muted }}
      >
        되돌리기 {history.past.length} · 다시하기 {history.future.length}
      </div>
    </div>
  );
}
