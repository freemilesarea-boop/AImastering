// The open context menu, if any.
//
// One store and one mounted renderer rather than a popover per surface: four
// surfaces each owning their own portal is four places to get the dismissal,
// the edge-flipping and the stacking wrong, and three of them would be found
// by a user rather than by me.

import { create } from 'zustand';
import type { CommandId } from '../shortcuts/definitions.js';

export type MenuItem =
  /** A command from the keymap: label, accelerator and availability come from the table. */
  | { kind: 'command'; id: CommandId; label?: string }
  /** Something with no command id — a one-off for this surface. */
  | { kind: 'action'; label: string; run: () => void; disabled?: boolean; danger?: boolean }
  | { kind: 'separator' }
  | { kind: 'header'; label: string };

export interface OpenMenu {
  x: number;
  y: number;
  /** What the menu is about, shown as its first line. */
  title: string;
  items: MenuItem[];
}

export interface ContextMenuState {
  menu: OpenMenu | null;
  open: (menu: OpenMenu) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set({ menu: null }),
}));

/**
 * Open a menu from a React mouse event.
 *
 * Takes the event so every caller suppresses the browser's own menu the same
 * way — three of the five places that had an `onContextMenu` before this were
 * doing nothing BUT that, and a fourth forgot it.
 */
export function openContextMenu(
  e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number },
  title: string,
  items: MenuItem[],
): void {
  e.preventDefault();
  e.stopPropagation();
  useContextMenuStore.getState().open({ x: e.clientX, y: e.clientY, title, items });
}
