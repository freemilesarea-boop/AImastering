// LayoutMenu — the saved rooms, and the way back into one.
//
// `workspace-view.ts` opens by arguing for these: "a tracking layout and a
// mixing layout are different rooms, and switching by hand is a minute each
// time."  Everything needed to honour that was written and tested —
// saveLayout, findLayout, removeLayout, describeLayout — and nothing called
// any of it, so `dawStore.layouts` stayed `[]` for the life of the app.
//
// Each row says what recalling WOULD change before you press it, for the same
// reason the mix snapshots do: switching room is a large visual jump, and a
// button whose effect you only learn afterwards is one people stop pressing.

import React, { useLayoutEffect, useRef, useState } from 'react';
import { useDawStore } from '../../stores/dawStore.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { usePanelWindowStore } from '../../stores/panelWindowStore.js';
import { useAppStore } from '../../stores/appStore.js';
import { MAX_LAYOUTS, describeLayout } from '../../daw/model/workspace-view.js';
import { describeLayoutDiff, layoutDiff } from '../../daw/edit/layout-ops.js';
import { askText } from '../../ui/text-prompt.js';
import { LAYER } from '../../theme/layers.js';
import { dropdownOffset } from '../../ui/dropdown-place.js';

/** Wide enough for a name, a difference and two buttons without wrapping. */
const MENU_WIDTH = 320;

export default function LayoutMenu() {
  const layouts = useDawStore((s) => s.layouts);
  const open = useDawStore((s) => s.layoutsOpen);
  const setOpen = useDawStore((s) => s.setLayoutsOpen);
  const currentLayout = useDawStore((s) => s.currentLayout);
  const notify = useAppStore((s) => s.notify);
  const [confirming, setConfirming] = useState<string | null>(null);

  // The toolbar wraps, so where this button sits is not fixed.  Measured when
  // the menu opens rather than assumed: `left-0` put the delete buttons past
  // the right edge of a 1100 px window.
  const anchor = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    if (!anchor.current) return;
    setOffset(dropdownOffset(
      anchor.current.getBoundingClientRect().left, MENU_WIDTH, window.innerWidth));
  }, [open]);

  // Subscribed rather than read through getState: the difference on each row
  // has to move when the room does, and a menu left open while a panel is
  // toggled would otherwise keep describing the screen from a minute ago.
  const windowMode = useDawStore((s) => s.window);
  const pxPerSec = useDawStore((s) => s.pxPerSec);
  const scrollSec = useDawStore((s) => s.scrollSec);
  const panels = useWorkspaceStore((s) => s.panels);
  const floatingWindows = usePanelWindowStore((s) => s.windows);

  const shot = {
    window: windowMode,
    panels,
    view: { pxPerSec, scrollSec },
    floating: floatingWindows.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
  };

  const save = (): void => {
    void askText('레이아웃 이름', currentLayout ?? `작업 ${layouts.length + 1}`).then((name) => {
      if (name === null) return;
      if (name.trim() === '') { notify('이름은 비울 수 없습니다', 'warning'); return; }
      const replacing = layouts.some((l) => l.name === name.trim());
      useDawStore.getState().saveWindowLayout(name);
      notify(replacing ? `${name.trim()} 덮어씀` : `${name.trim()} 저장`, 'success');
    });
  };

  const recall = (name: string): void => {
    const diff = useDawStore.getState().recallWindowLayout(name);
    if (!diff) { notify(`${name} 을(를) 찾을 수 없습니다`, 'warning'); return; }
    notify(diff.same ? `${name} — 화면은 이미 그대로입니다`
      : `${name} — ${describeLayoutDiff(diff)}`, 'success');
  };

  return (
    <div className="relative" ref={anchor}>
      <button
        onClick={() => setOpen(!open)}
        title="작업 화면을 이름 붙여 저장하고 한 번에 되돌립니다 (Mod+Alt+Shift+L)"
        className={`h-7 px-2 rounded border text-[11px] ${open
          ? 'bg-zinc-800 border-zinc-600 text-zinc-200'
          : 'bg-zinc-900 border-zinc-700 text-zinc-400'}`}
        data-testid="layout-menu-button"
      >화면 {layouts.length}</button>

      {open && (
        <div
          className="absolute mt-1 rounded border border-zinc-700 bg-[#15151d] shadow-xl"
          style={{ left: offset, width: MENU_WIDTH, zIndex: LAYER.popover }}
          data-testid="layout-menu"
        >
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-800">
            <span className="text-[10px] text-zinc-500">작업 화면</span>
            <span className="text-[9px] text-zinc-700">창 · 패널 · 띄운 창 · 줌</span>
            <div className="flex-1" />
            <button
              onClick={save}
              disabled={layouts.length >= MAX_LAYOUTS && currentLayout === null}
              title={layouts.length >= MAX_LAYOUTS && currentLayout === null
                ? `${MAX_LAYOUTS}개가 한도입니다 — 하나 지우거나 같은 이름으로 덮어쓰세요`
                : '지금 화면을 저장합니다'}
              className={`px-2 h-5 rounded text-[10px] border ${
                layouts.length >= MAX_LAYOUTS && currentLayout === null
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-700'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-300'}`}
              data-testid="layout-save"
            >+ 지금 화면</button>
          </div>

          {layouts.length === 0 ? (
            <p className="px-2.5 py-2 text-[10px] text-zinc-600">
              저장된 화면이 없습니다 — 트래킹용과 믹싱용을 따로 저장해 두면 한 번에 오갈 수 있습니다.
            </p>
          ) : (
            <div className="py-1">
              {layouts.map((layout) => {
                const diff = layoutDiff(shot, layout);
                const armed = confirming === layout.name;
                return (
                  <div
                    key={layout.name}
                    data-testid={`layout-row-${layout.name}`}
                    className="flex items-center gap-2 px-2.5 py-1"
                  >
                    <span
                      className="text-[10px] truncate"
                      style={{ width: 92, color: layout.name === currentLayout ? '#c6a768' : '#d4d4d8' }}
                      title={describeLayout(layout)}
                    >{layout.name}</span>
                    <span className={`text-[9px] flex-1 truncate ${diff.same ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      {describeLayoutDiff(diff)}
                    </span>
                    <button
                      onClick={() => recall(layout.name)}
                      disabled={diff.same}
                      title={diff.same ? '지금 화면과 같습니다' : describeLayout(layout)}
                      className={`px-1.5 h-5 rounded text-[9px] border shrink-0 ${diff.same
                        ? 'bg-zinc-900 border-zinc-800 text-zinc-700'
                        : 'bg-zinc-800 border-zinc-600 text-zinc-200'}`}
                    >이동</button>
                    <button
                      onClick={() => {
                        if (!armed) { setConfirming(layout.name); return; }
                        setConfirming(null);
                        useDawStore.getState().dropWindowLayout(layout.name);
                        notify(`${layout.name} 삭제`, 'info');
                      }}
                      onBlur={() => setConfirming((c) => (c === layout.name ? null : c))}
                      title="이 화면을 버립니다"
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
      )}
    </div>
  );
}
