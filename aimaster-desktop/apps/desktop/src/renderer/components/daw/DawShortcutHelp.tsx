// DawShortcutHelp — the "?" overlay, rendered straight from definitions.ts.
//
// Generated rather than hand-written so it can never drift from what the
// dispatcher actually does — including the rows marked "해당 없음", which are
// listed on purpose so the DAW muscle memory has an answer instead of silence.

import React, { useMemo } from 'react';
import {
  SHORTCUTS, GROUP_TITLES, displayChords, type ShortcutGroupId,
} from '../../shortcuts/definitions.js';
import { detectPlatform } from '../../shortcuts/keys.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';

const GROUP_ORDER: ShortcutGroupId[] = ['file', 'transport', 'tools', 'edit', 'window'];

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded
                     border border-zinc-700 bg-zinc-800/70 font-mono text-[10px]
                     text-zinc-300 whitespace-nowrap">
      {label}
    </span>
  );
}

export default function DawShortcutHelp() {
  const setPanel = useWorkspaceStore((s) => s.setPanel);
  const platform = useMemo(() => detectPlatform(), []);
  const close = () => setPanel('help', false);

  return (
    <div
      onClick={close}
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,760px)] max-h-[86vh] overflow-y-auto rounded-2xl border border-zinc-700
                   bg-[#15151d] shadow-2xl px-6 py-5"
      >
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <p className="text-base font-semibold text-zinc-100">키보드 단축키</p>
            <p className="text-[11px] text-zinc-600 mt-0.5">
              {platform === 'mac' ? 'macOS — ⌘ / Option' : 'Windows — Ctrl / Alt'} 기준 · 입력창에 포커스가 있을 때는 동작하지 않습니다
            </p>
          </div>
          <button onClick={close} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {GROUP_ORDER.map((g) => (
            <section key={g} className="space-y-2">
              <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">
                {GROUP_TITLES[g]}
              </p>
              <div className="space-y-1.5">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`text-[12px] ${s.available ? 'text-zinc-300' : 'text-zinc-600 line-through'}`}>
                        {s.label}
                      </p>
                      <p className="text-[10px] text-zinc-600 leading-snug">
                        {s.available ? s.note : `해당 없음 — ${s.note}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 pt-0.5">
                      {displayChords(s, platform).map((c, i) => (
                        <React.Fragment key={c}>
                          {i > 0 && <span className="text-[9px] text-zinc-700">/</span>}
                          <Chip label={c} />
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-5 pt-3 border-t border-zinc-800 text-[10px] font-mono text-zinc-600 text-center">
          ESC · ? · F1 로 닫기
        </p>
      </div>
    </div>
  );
}
