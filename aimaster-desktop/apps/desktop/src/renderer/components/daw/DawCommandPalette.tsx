// DawCommandPalette — type part of a command's name, press Enter, done.
//
// The DAW has 241 commands and every one of them has a key.  Two surfaces
// already helped: the "?" overlay lists and rebinds them, and the right-click
// menus offer the handful that belong to the thing under the pointer.  What
// was missing is the middle: knowing WHAT you want and not where it lives.
// A student who wants to freeze a track should not have to learn whether that
// lives in the toolbar, a menu or a key.
//
// It teaches rather than replaces.  Every row shows its key, and running a
// command from here goes through `runCommand`, which is also what shows the
// "다음엔 이 키로" chip afterwards — so using the palette three times for the
// same command is how you stop needing the palette for it.
//
// The search is `searchCommands`, shared with the "?" overlay rather than
// copied, and it matches on the key AS PRINTED, so typing ⌘⌥F or Ctrl+Alt+F
// finds the row too.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LAYER } from '../../theme/layers.js';
import { type CommandId } from '../../shortcuts/definitions.js';
import { describeSpec, effectiveChords } from '../../shortcuts/key-overrides.js';
import { searchCommands } from '../../shortcuts/command-search.js';
import { detectPlatform } from '../../shortcuts/keys.js';
import { runCommand } from '../../shortcuts/command-runner.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { useShortcutStore } from '../../stores/shortcutStore.js';

/** How many rows to draw.  Enough to scan, few enough to scan quickly. */
const ROWS = 12;

export default function DawCommandPalette() {
  const setPanel = useWorkspaceStore((s) => s.setPanel);
  const overrides = useShortcutStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = (): void => setPanel('palette', false);

  const rows = useMemo(
    () => searchCommands(query, overrides, platform, ROWS),
    [query, overrides, platform],
  );
  const total = searchCommands(query, overrides, platform).length;

  // A new query means a new list, so the cursor goes back to the top rather
  // than pointing at whatever row happens to be in that position now.
  useEffect(() => { setCursor(0); }, [query]);

  // The field takes the keystrokes, which is also what keeps the global
  // dispatcher out of the way: it stands down while an input has focus.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const chordOf = (id: CommandId): string | null => {
    const def = rows.find((r) => r.id === id);
    if (!def) return null;
    const first = effectiveChords(def, overrides)[0];
    return first === undefined ? null : describeSpec(first, platform);
  };

  const run = (id: CommandId): void => {
    // Closed first: the command may open a window of its own, and a palette
    // still sitting over it reads as the click not having landed.
    close();
    runCommand(id);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = rows[cursor];
      if (picked) run(picked.id);
    }
  };

  return (
    <div
      onClick={close}
      className="fixed inset-0 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[12vh]"
      style={{ zIndex: LAYER.help }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(92vw,620px)] rounded-2xl border border-zinc-700 bg-[#15151d] shadow-2xl
                   overflow-hidden"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="명령 검색 — 이름 · 설명 · 키"
          className="w-full h-11 bg-transparent px-4 text-[13px] text-zinc-200
                     placeholder:text-zinc-600 border-b border-zinc-800 outline-none"
        />

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-[12px] text-zinc-600 text-center">
            찾는 명령이 없습니다 — 다른 말로 해보세요
          </p>
        ) : (
          <ul className="max-h-[52vh] overflow-y-auto py-1">
            {rows.map((def, i) => {
              const chord = chordOf(def.id);
              const active = i === cursor;
              return (
                <li key={def.id}>
                  <button
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => run(def.id)}
                    className={`w-full text-left px-4 py-2 flex items-baseline gap-3
                                ${active ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'}`}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12px] text-zinc-200 truncate">{def.label}</span>
                      <span className="block text-[10px] text-zinc-600 truncate">{def.note}</span>
                    </span>
                    {chord !== null && (
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0
                                       border border-zinc-700 bg-zinc-900 text-zinc-400">
                        {chord}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-600 flex gap-3">
          <span>Enter 실행</span>
          <span>↑ ↓ 이동</span>
          <span>Esc 닫기</span>
          <span className="ml-auto">
            {total > rows.length ? `${rows.length} / ${total}개` : `${total}개`}
          </span>
        </p>
      </div>
    </div>
  );
}
