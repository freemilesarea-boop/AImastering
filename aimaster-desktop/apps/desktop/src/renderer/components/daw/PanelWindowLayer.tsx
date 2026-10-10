// The panels that have been torn off the tab strip, drawn where they were put.
//
// Same chrome as a floating plugin window on purpose — drag by the title bar,
// click to bring to front, × to close — because a person who has learnt one
// floating window in this app has learnt all of them.
//
// The panel INSIDE the frame is the ordinary component, not a copy of it.  It
// reads the same stores and writes through the same actions as the docked
// one, so a fader moved here moves there, and closing the window leaves
// nothing behind to reconcile.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePanelWindowStore, PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT } from '../../stores/panelWindowStore.js';
import { panelLabel, type DawWindow } from '../../daw/model/view-window.js';
import { pluginWindowLayer } from '../../theme/layers.js';
import { premium } from '../../theme/premium.js';

const TITLE_H = 30;
const GRIP = 14;

/**
 * Drag state lives in a ref, not in React state.
 *
 * A pointer move fires far more often than a frame, and routing every one
 * through `setState` makes the window trail the cursor.  The ref holds the
 * grab offset; only the store position, which is what anything else reads,
 * goes through React.
 */
interface Grab { dx: number; dy: number; }

function PanelFrame(
  { win, children }: { win: { id: DawWindow; x: number; y: number; width: number; height: number; z: number };
    children: React.ReactNode },
): React.ReactElement {
  const focus  = usePanelWindowStore((s) => s.focus);
  const close  = usePanelWindowStore((s) => s.close);
  const move   = usePanelWindowStore((s) => s.move);
  const resize = usePanelWindowStore((s) => s.resize);

  const grab = useRef<Grab | null>(null);
  const sizeGrab = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onTitleDown = useCallback((e: React.PointerEvent) => {
    // Buttons in the title bar are not handles — otherwise pressing × starts a
    // drag and the click never lands.
    if ((e.target as HTMLElement).closest('button')) return;
    focus(win.id);
    grab.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
    setDragging(true);
  }, [focus, win.id, win.x, win.y]);

  const onGripDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    focus(win.id);
    sizeGrab.current = { x: e.clientX, y: e.clientY, w: win.width, h: win.height };
  }, [focus, win.id, win.width, win.height]);

  // Listeners on the WINDOW, not the frame: a fast drag outsprints the element
  // and the pointer ends up over whatever is underneath, which would drop the
  // window mid-move.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (grab.current) move(win.id, e.clientX - grab.current.dx, e.clientY - grab.current.dy);
      else if (sizeGrab.current) {
        const g = sizeGrab.current;
        resize(win.id, g.w + (e.clientX - g.x), g.h + (e.clientY - g.y));
      }
    };
    const onUp = (): void => { grab.current = null; sizeGrab.current = null; setDragging(false); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [move, resize, win.id]);

  return (
    <div
      onPointerDown={() => focus(win.id)}
      className="fixed rounded-xl overflow-hidden flex flex-col"
      style={{
        left: win.x, top: win.y, width: win.width, height: win.height,
        zIndex: pluginWindowLayer(win.z),
        background: premium.surface.frame,
        border: `1px solid ${premium.accent.deep}`,
        boxShadow: premium.shadow.panel,
      }}
    >
      <div
        onPointerDown={onTitleDown}
        className="flex items-center gap-2 px-3 select-none shrink-0"
        style={{
          height: TITLE_H,
          cursor: dragging ? 'grabbing' : 'grab',
          background: premium.gradient.frame,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <span
          className="text-[11px] font-medium tracking-wide flex-1 truncate"
          style={{ fontFamily: premium.type.display, color: premium.accent.light }}
        >{panelLabel(win.id)}</span>
        <button
          onClick={() => close(win.id)}
          title="닫기 — 탭에서는 그대로 열립니다"
          className="hit-target h-5 w-5 rounded text-[11px] leading-none"
          style={{ color: premium.text.muted }}
        >×</button>
      </div>

      {/* The panel itself.  `min-h-0` so a flex child that scrolls actually
          scrolls instead of pushing the frame open. */}
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">{children}</div>

      {/* Resize grip.  Bottom-right only: a panel torn off to be read beside
          something else is resized from the corner nearest the empty screen. */}
      <div
        onPointerDown={onGripDown}
        title="크기 조절"
        className="absolute"
        style={{
          right: 0, bottom: 0, width: GRIP, height: GRIP,
          cursor: 'nwse-resize',
          background: `linear-gradient(135deg, transparent 50%, ${premium.accent.deep} 50%)`,
        }}
      />
    </div>
  );
}

export default function PanelWindowLayer(
  { render }: { render: (id: DawWindow) => React.ReactNode },
): React.ReactElement | null {
  const windows = usePanelWindowStore((s) => s.windows);
  if (windows.length === 0) return null;
  return (
    <>
      {windows.map((win) => (
        <PanelFrame key={win.id} win={win}>{render(win.id)}</PanelFrame>
      ))}
    </>
  );
}

export { PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT };
