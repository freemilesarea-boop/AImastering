// SnapshotPanel — the mixer snapshots, as a list you can go back to.
//
// Taking one was already possible (Mod+Alt+Shift+M) and going back to one was
// not: `restoreSnapshot` and `removeSnapshot` existed, tested, with no caller
// in the app.  Twelve saved mixes you can neither recall nor delete is a
// worse feature than none, because it looks like it worked.
//
// Each row says what it WOULD change before you press anything.  That is the
// whole point of A/B: "restore" with no preview is a coin flip, and the one
// thing a snapshot cannot give back is the mix you had a second before you
// pressed it — which is why restoring goes through `apply`, so Mod+Z undoes
// it like any other edit.

import React, { useMemo, useState } from 'react';
import type { DawSession } from '../../../daw/model/types.js';
import {
  describeRestore, describeSnapshot, diffSnapshot, restoreSnapshot, snapshotAge,
  takeSnapshot, type MixSnapshot,
} from '../../../daw/model/mix-snapshot.js';
import { nextId } from '../../../daw/model/ids.js';
import { useDawStore } from '../../../stores/dawStore.js';
import { askText } from '../../../ui/text-prompt.js';

export default function SnapshotPanel({ session, onApply, onNotify }: {
  session: DawSession;
  onApply: (fn: (s: DawSession) => DawSession) => void;
  onNotify: (m: string, t?: 'info' | 'success' | 'warning' | 'error') => void;
}) {
  const snapshots = useDawStore((s) => s.snapshots);
  const addSnapshot = useDawStore((s) => s.addSnapshot);
  const dropSnapshot = useDawStore((s) => s.dropSnapshot);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Read once per render rather than per row, so every age on screen is
  // measured from the same instant — rows a second apart otherwise disagree.
  const now = Date.now();

  // Newest first: the one you are most likely to want back is the one you
  // just left.  `pushSnapshot` appends, so the store order is oldest first.
  const rows = useMemo(() => [...snapshots].reverse().map((snapshot) => ({
    snapshot,
    diff: diffSnapshot(session, snapshot),
  })), [snapshots, session]);

  const capture = (): void => {
    void askText('스냅샷 이름', `믹스 ${snapshots.length + 1}`).then((name) => {
      if (name === null) return;
      // The session is read again inside: the dialog was open, and a fader
      // could have moved behind it.  A snapshot of a mix nobody was looking
      // at is the one thing this must not save.
      const snapshot = takeSnapshot(useDawStore.getState().session, name, nextId('snap'));
      addSnapshot(snapshot);
      onNotify(`스냅샷 저장 — ${snapshot.name} (채널 ${snapshot.channels.length}개)`, 'success');
    });
  };

  const restore = (snapshot: MixSnapshot): void => {
    // Computed against the session on screen, then applied as that exact
    // result: reading the diff from one session and restoring onto another
    // would report a change the user never saw.
    const result = restoreSnapshot(session, snapshot);
    onApply(() => result.session);
    onNotify(`${snapshot.name} 복구 — ${describeRestore(result)}`, 'success');
  };

  return (
    <div className="px-3 py-2 border-b border-zinc-800 bg-[#101018]" data-testid="snapshot-panel">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] text-zinc-500">믹스 스냅샷</span>
        <span className="text-[9px] text-zinc-700">
          페이더 · 팬 · 뮤트 · 인서트 · 센드 · 라우팅 — 오토메이션과 편집은 그대로
        </span>
        <div className="flex-1" />
        <button
          onClick={capture}
          title="지금 믹스를 저장합니다 (Mod+Alt+Shift+M)"
          className="px-2 h-5 rounded text-[10px] border border-zinc-700 bg-zinc-900 text-zinc-300"
        >+ 지금 믹스</button>
      </div>

      {snapshots.length === 0 ? (
        <p className="text-[10px] text-zinc-600">
          저장된 스냅샷이 없습니다 — 믹스를 하나 저장해 두면 나중에 그 버전과 비교할 수 있습니다.
        </p>
      ) : (
        <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 176 }}>
          {rows.map(({ snapshot, diff }) => {
            const armed = confirming === snapshot.id;
            return (
              <div
                key={snapshot.id}
                data-testid={`snapshot-row-${snapshot.id}`}
                className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1"
              >
                <span className="text-[10px] text-zinc-200 truncate" style={{ width: 120 }}
                      title={snapshot.name}>
                  {snapshot.name}
                </span>
                <span className="text-[9px] font-mono text-zinc-600 shrink-0" style={{ width: 56 }}>
                  {snapshotAge(snapshot.takenAt, now)}
                </span>
                <span
                  className={`text-[9px] flex-1 truncate ${diff.same ? 'text-zinc-600' : 'text-zinc-400'}`}
                  title={diff.same ? '' : [
                    diff.levels.length ? `레벨: ${diff.levels.join(', ')}` : '',
                    diff.inserts.length ? `인서트: ${diff.inserts.join(', ')}` : '',
                    diff.routing.length ? `라우팅: ${diff.routing.join(', ')}` : '',
                  ].filter(Boolean).join('\n')}
                >
                  {describeSnapshot(diff)}
                </span>
                <button
                  onClick={() => restore(snapshot)}
                  disabled={diff.same}
                  title={diff.same
                    ? '지금 믹스와 같아서 복구할 것이 없습니다'
                    : '이 믹스로 되돌립니다 — Mod+Z 로 취소할 수 있습니다'}
                  className={`px-1.5 h-5 rounded text-[9px] border shrink-0 ${diff.same
                    ? 'bg-zinc-900 border-zinc-800 text-zinc-700'
                    : 'bg-zinc-800 border-zinc-600 text-zinc-200'}`}
                >복구</button>
                <button
                  onClick={() => {
                    if (!armed) { setConfirming(snapshot.id); return; }
                    setConfirming(null);
                    dropSnapshot(snapshot.id);
                    onNotify(`${snapshot.name} 삭제`, 'info');
                  }}
                  onBlur={() => setConfirming((c) => (c === snapshot.id ? null : c))}
                  title="이 스냅샷을 버립니다"
                  className={`px-1 h-5 rounded text-[9px] border shrink-0 ${armed
                    ? 'bg-red-600/40 border-red-500/70 text-red-200'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-500'}`}
                >{armed ? '삭제?' : '×'}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
