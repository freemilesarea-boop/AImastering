// DawShortcutHelp — the "?" overlay, rendered straight from definitions.ts,
// and since the overrides layer landed, the place you change a binding too.
//
// Generated rather than hand-written so it can never drift from what the
// dispatcher actually does — including the rows marked "해당 없음", which are
// listed on purpose so the DAW muscle memory has an answer instead of silence.
//
// The editor lives HERE rather than in settings for one reason: this is the
// list.  Cubase gives key commands their own window and then has to repeat
// the whole table inside it; the table was already on screen, so what was
// missing was the ability to press one of its rows.

import React, { useEffect, useMemo, useState } from 'react';
import { LAYER } from '../../theme/layers.js';
import {
  SHORTCUTS, GROUP_TITLES, type CommandId, type ShortcutGroupId, type ShortcutDef,
} from '../../shortcuts/definitions.js';
import {
  describeSpec, effectiveChords, isOverridden, specFromEvent,
} from '../../shortcuts/key-overrides.js';
import { detectPlatform } from '../../shortcuts/keys.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { useShortcutStore } from '../../stores/shortcutStore.js';
import { useAppStore } from '../../stores/appStore.js';

const GROUP_ORDER: ShortcutGroupId[] = ['file', 'transport', 'tools', 'edit', 'window', 'daw'];

function Chip({ label, changed }: { label: string; changed?: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded
                     border font-mono text-[10px] whitespace-nowrap ${changed
                       ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300'
                       : 'border-zinc-700 bg-zinc-800/70 text-zinc-300'}`}>
      {label}
    </span>
  );
}

export default function DawShortcutHelp() {
  const setPanel = useWorkspaceStore((s) => s.setPanel);
  const notify = useAppStore((s) => s.notify);
  const overrides = useShortcutStore((s) => s.overrides);
  const setChords = useShortcutStore((s) => s.setChords);
  const reset = useShortcutStore((s) => s.reset);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const platform = useMemo(() => detectPlatform(), []);
  const [filter, setFilter] = useState('');
  /** The command waiting for a keypress, or null. */
  const [capturing, setCapturing] = useState<CommandId | null>(null);
  const close = () => setPanel('help', false);

  /**
   * Capture the next keypress for `capturing`.
   *
   * On the window in CAPTURE phase, so it runs before the global dispatcher —
   * which is itself a window capture listener and would otherwise run the
   * command being rebound.  Pressing ⌘S to assign it would save the session.
   */
  useEffect(() => {
    if (!capturing) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { setCapturing(null); return; }
      const spec = specFromEvent(e, platform);
      // A bare modifier is not a binding — keep waiting rather than refusing,
      // because holding ⌘ before pressing the key is how a chord is typed.
      if (!spec) return;
      const result = setChords(capturing, [spec]);
      setCapturing(null);
      if (!result.ok) notify(result.reason ?? '단축키를 바꾸지 못했습니다', 'warning');
      else notify(`${describeSpec(spec, platform)} 로 바꿨습니다`, 'success');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, platform, setChords, notify]);

  const needle = filter.trim().toLowerCase();
  const matches = (s: ShortcutDef): boolean => {
    if (!needle) return true;
    if (s.label.toLowerCase().includes(needle)) return true;
    if (s.note.toLowerCase().includes(needle)) return true;
    return effectiveChords(s, overrides)
      .some((c) => describeSpec(c, platform).toLowerCase().includes(needle));
  };

  const changedCount = Object.keys(overrides).length;
  const shown = SHORTCUTS.filter(matches);

  return (
    <div
      onClick={close}
      className="fixed inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      style={{ zIndex: LAYER.help }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,760px)] max-h-[86vh] overflow-y-auto rounded-2xl border border-zinc-700
                   bg-[#15151d] shadow-2xl px-6 py-5"
      >
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <p className="text-base font-semibold text-zinc-100">키보드 단축키</p>
            <p className="text-[11px] text-zinc-600 mt-0.5">
              {platform === 'mac' ? 'macOS — ⌘ / Option' : 'Windows — Ctrl / Alt'} 기준 · 입력창에 포커스가 있을 때는 동작하지 않습니다
            </p>
          </div>
          <button onClick={close} title="닫기"
                  className="hit-target text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>

        {/* Search, because the table is three hundred rows and the question is
            always about one of them. */}
        <div className="flex items-center gap-2 mb-4">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="기능 · 설명 · 키 검색"
            className="flex-1 min-w-0 h-7 rounded-lg bg-zinc-900 border border-zinc-700 px-2
                       text-[11px] text-zinc-300 placeholder:text-zinc-600
                       focus:outline-none focus:border-zinc-500"
          />
          <span className="text-[10px] text-zinc-600 shrink-0">
            {shown.length} / {SHORTCUTS.length}
          </span>
          {changedCount > 0 && (
            <button
              onClick={() => {
                const r = resetAll();
                notify(r.ok ? `바꾼 단축키 ${changedCount}개를 기본값으로 되돌렸습니다`
                  : (r.reason ?? '되돌리지 못했습니다'), r.ok ? 'success' : 'warning');
              }}
              className="shrink-0 h-7 px-2 rounded-lg border border-zinc-700 text-[10px]
                         text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
            >전체 기본값 ({changedCount})</button>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {GROUP_ORDER.map((g) => {
            const rows = shown.filter((s) => s.group === g);
            if (rows.length === 0) return null;
            return (
              <section key={g} className="space-y-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">
                  {GROUP_TITLES[g]}
                </p>
                <div className="space-y-1.5">
                  {rows.map((s) => {
                    const chords = effectiveChords(s, overrides);
                    const changed = isOverridden(s.id, overrides);
                    return (
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
                          {capturing === s.id ? (
                            <span className="px-1.5 py-0.5 rounded border border-emerald-500/60
                                             bg-emerald-600/20 font-mono text-[10px] text-emerald-300
                                             whitespace-nowrap animate-pulse">
                              키를 누르세요 · ESC 취소
                            </span>
                          ) : (
                            <>
                              {chords.length === 0 ? (
                                <span className="text-[10px] text-zinc-600 font-mono">없음</span>
                              ) : chords.map((c, i) => (
                                <React.Fragment key={c}>
                                  {i > 0 && <span className="text-[9px] text-zinc-700">/</span>}
                                  <Chip label={describeSpec(c, platform)} changed={changed} />
                                </React.Fragment>
                              ))}
                              <button
                                onClick={() => setCapturing(s.id)}
                                title="이 기능의 단축키를 다른 키로 바꿉니다"
                                className="hit-target w-5 h-5 rounded text-[10px] leading-none
                                           text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
                              >✎</button>
                              {changed && (
                                <button
                                  onClick={() => {
                                    const r = reset(s.id);
                                    notify(r.ok ? `"${s.label}" 를 기본값으로 되돌렸습니다`
                                      : (r.reason ?? '되돌리지 못했습니다'), r.ok ? 'success' : 'warning');
                                  }}
                                  title="기본값으로"
                                  className="hit-target w-5 h-5 rounded text-[10px] leading-none
                                             text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
                                >↺</button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        {shown.length === 0 && (
          <p className="text-[11px] text-zinc-600 text-center py-6">
            "{filter}" 에 해당하는 기능이 없습니다
          </p>
        )}

        <p className="mt-5 pt-3 border-t border-zinc-800 text-[10px] font-mono text-zinc-600 text-center">
          ✎ 로 키 변경 · ESC · ? · F1 로 닫기
        </p>
      </div>
    </div>
  );
}
