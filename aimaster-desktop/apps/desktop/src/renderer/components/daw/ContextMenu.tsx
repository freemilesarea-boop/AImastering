// 우클릭 메뉴 — the second doorway into the command map.
//
// Before this, five files in the renderer had an `onContextMenu` and three of
// them only called `preventDefault()`.  So the clip, the track header, the
// mixer strip, the insert slot, the markers and the automation lanes had no
// right-click at all, and every one of three hundred commands was reachable
// only by a key you had to already know or a panel you had to already have
// found.  Logic's manual describes Control-click as a primary path; here it
// was not a path.
//
// ── Why items are command ids ───────────────────────────────────────────────
//
// An item names a command and nothing else: the label comes from the same
// table the dispatcher reads, the accelerator from the same resolver the help
// overlay reads, and the click runs the same function the keystroke runs.  So
// a remapped key shows its new chord here without this file knowing that
// remapping exists, and a menu entry can never be a second implementation of
// the thing it is named after.
//
// Showing the accelerator is not decoration either: it is the only place the
// app teaches a shortcut at the moment somebody wants the action.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LAYER } from '../../theme/layers.js';
import { SHORTCUTS, type CommandId } from '../../shortcuts/definitions.js';
import { describeSpec, effectiveChords } from '../../shortcuts/key-overrides.js';
import { hasCommand, runCommand } from '../../shortcuts/command-runner.js';
import { detectPlatform } from '../../shortcuts/keys.js';
import { useContextMenuStore, type MenuItem } from '../../stores/contextMenuStore.js';
import { useShortcutStore } from '../../stores/shortcutStore.js';

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s] as const));

/** Keep the menu on screen: flip rather than clip. */
function place(x: number, y: number, w: number, h: number): { left: number; top: number } {
  const pad = 6;
  const vw = typeof window === 'undefined' ? 1920 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 1080 : window.innerHeight;
  return {
    left: x + w + pad > vw ? Math.max(pad, x - w) : x,
    top: y + h + pad > vh ? Math.max(pad, y - h) : y,
  };
}

export default function ContextMenu() {
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);
  const overrides = useShortcutStore((s) => s.overrides);
  const platform = detectPlatform();
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measured after mount, because the height depends on how many items this
  // surface offered.  Hidden until placed — a menu that appears at the
  // pointer and jumps up is worse than one that appears a frame later.
  useLayoutEffect(() => {
    if (!menu) { setPos(null); return; }
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(place(menu.x, menu.y, r.width, r.height));
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return;
      // Captured, so Escape closes the menu rather than reaching the command
      // layer underneath it and closing the panel the menu was opened from.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onDown = (): void => close();
    window.addEventListener('keydown', onKey, { capture: true });
    // `mousedown`, not `click`: a press anywhere else should dismiss before
    // that press reaches whatever it landed on.
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onDown);
    };
  }, [menu, close]);

  if (!menu) return null;

  const accel = (id: CommandId): string | null => {
    const def = BY_ID.get(id);
    if (!def) return null;
    const chords = effectiveChords(def, overrides);
    const first = chords[0];
    return first === undefined ? null : describeSpec(first, platform);
  };

  const render = (item: MenuItem, i: number): React.ReactNode => {
    if (item.kind === 'separator') {
      return <div key={`sep-${i}`} className="my-1 border-t border-zinc-800" />;
    }
    if (item.kind === 'header') {
      return (
        <p key={`head-${i}`} className="px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase
                                        tracking-[0.12em] text-zinc-600">
          {item.label}
        </p>
      );
    }
    if (item.kind === 'action') {
      return (
        <button
          key={`act-${i}-${item.label}`}
          disabled={item.disabled === true}
          onClick={() => { close(); item.run(); }}
          className={`w-full text-left px-2.5 py-1 text-[11px] rounded-sm flex items-center
                      justify-between gap-6 ${item.disabled
                        ? 'text-zinc-600 cursor-default'
                        : item.danger
                          ? 'text-red-300 hover:bg-red-600/20'
                          : 'text-zinc-300 hover:bg-zinc-700/60'}`}
        >
          <span className="truncate">{item.label}</span>
        </button>
      );
    }
    const def = BY_ID.get(item.id);
    // A command the table does not have is a bug in whoever built the menu,
    // and showing nothing would hide it.  Shown, disabled, named.
    const label = item.label ?? def?.label ?? item.id;
    const runnable = def?.available !== false && hasCommand(item.id);
    const chord = accel(item.id);
    return (
      <button
        key={`cmd-${item.id}`}
        disabled={!runnable}
        title={def?.note ?? undefined}
        onClick={() => { close(); runCommand(item.id); }}
        className={`w-full text-left px-2.5 py-1 text-[11px] rounded-sm flex items-center
                    justify-between gap-6 ${runnable
                      ? 'text-zinc-300 hover:bg-zinc-700/60'
                      : 'text-zinc-600 cursor-default'}`}
      >
        <span className="truncate">{label}</span>
        {chord !== null && (
          <span className={`font-mono text-[10px] shrink-0 ${runnable ? 'text-zinc-500' : 'text-zinc-700'}`}>
            {chord}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      ref={boxRef}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed min-w-[220px] max-w-[320px] max-h-[70vh] overflow-y-auto py-1
                 rounded-lg border border-zinc-700 bg-[#1a1a22] shadow-2xl"
      style={{
        zIndex: LAYER.contextMenu,
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <p className="px-2.5 pb-1 pt-0.5 text-[10px] text-zinc-500 truncate border-b border-zinc-800 mb-1">
        {menu.title}
      </p>
      {menu.items.map(render)}
    </div>
  );
}
