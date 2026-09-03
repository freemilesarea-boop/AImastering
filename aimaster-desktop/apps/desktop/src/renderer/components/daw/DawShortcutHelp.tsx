// DawShortcutHelp — the "?" overlay, rendered straight from definitions.ts.
//
// Generated rather than written out, so it cannot drift from what the
// dispatcher does. The rows the app has no counterpart for are listed too,
// greyed, with the reason — DAW muscle memory deserves an answer rather than
// silence, and "이 앱에는 없습니다" is an answer.

import React, { useMemo } from 'react';
import {
  SHORTCUTS, GROUP_TITLES, displayChords, type ShortcutGroupId,
} from '../../shortcuts/definitions.js';
import { detectPlatform } from '../../shortcuts/keys.js';

const GROUP_ORDER: ShortcutGroupId[] = ['file', 'transport', 'tools', 'edit', 'window'];

function Chip({ label, dim }: { label: string; dim: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded
                  border font-mono text-[10px] whitespace-nowrap ${
                    dim
                      ? 'border-slate-200 bg-slate-50 text-slate-400'
                      : 'border-slate-300 bg-slate-100 text-slate-700'}`}
    >
      {label}
    </span>
  );
}

export interface DawShortcutHelpProps {
  onClose: () => void;
}

export default function DawShortcutHelp({ onClose }: DawShortcutHelpProps): React.ReactElement {
  const platform = useMemo(() => detectPlatform(), []);
  const available = SHORTCUTS.filter((s) => s.available).length;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,860px)] max-h-[88vh] overflow-y-auto rounded-xl border border-slate-300
                   bg-white shadow-2xl px-6 py-5"
      >
        <div className="flex items-baseline gap-3 mb-4">
          <h2 className="text-[15px] font-semibold text-slate-900">키보드 단축키</h2>
          <span className="text-[11px] text-slate-500">
            {available} / {SHORTCUTS.length}개 동작 · {platform === 'mac' ? 'macOS' : 'Windows'}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-[11px] text-slate-500 hover:text-slate-800 px-2 py-1"
          >닫기 (Esc)</button>
        </div>

        {GROUP_ORDER.map((group) => {
          const rows = SHORTCUTS.filter((s) => s.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group} className="mb-5">
              <h3 className="text-[11px] uppercase tracking-widest text-slate-500 mb-2">
                {GROUP_TITLES[group]}
              </h3>
              <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                {rows.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-start gap-3 px-3 py-1.5 ${s.available ? '' : 'bg-slate-50/60'}`}
                  >
                    <div className="w-40 shrink-0 flex flex-wrap gap-1 pt-0.5">
                      {displayChords(s, platform).map((c) => (
                        <Chip key={c} label={c} dim={!s.available} />
                      ))}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`text-[12px] ${s.available ? 'text-slate-800' : 'text-slate-400'}`}>
                        {s.label}
                        {!s.available && (
                          <span className="ml-2 text-[10px] text-slate-400">해당 없음</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 leading-relaxed">{s.note}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        <p className="text-[10px] text-slate-500 leading-relaxed">
          텍스트를 입력하는 중에는 단축키가 동작하지 않습니다 — 이름을 고치다가 트랙이 사라지지 않도록.
          회색 줄은 이 앱에 대응하는 기능이 없는 항목이고, 눌러 보면 이유를 알려줍니다.
        </p>
      </div>
    </div>
  );
}
