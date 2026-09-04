// workspace-view.ts — remembering where you were looking.
//
// Three small things that share a shape: they are all "the view, saved".
//
//   ZOOM PRESETS — five slots you set with one key and recall with another.
//   Editing a vocal means going between "the whole song" and "these four
//   syllables" constantly, and rebuilding the second one by scrolling is the
//   work this replaces.  Pro Tools has these on the number row; ours are on
//   the function keys because the number row is memory locations now.
//
//   WINDOW LAYOUTS — which panels are open and how big.  A tracking layout and
//   a mixing layout are different rooms, and switching by hand is a minute
//   each time.
//
//   LINKED SELECTION — whether moving the edit selection also moves the
//   timeline selection.  Pro Tools makes this a toggle because the two are
//   genuinely different when you are spotting to picture: you want to keep
//   looking at one place while editing another.
//
// All pure.  The store holds the values; this decides what they mean.

import type { DawWindow } from './view-window.js';

/** Five slots — enough for the views a session actually has, few enough to remember. */
export const ZOOM_SLOTS = 5;

export interface ZoomView {
  pxPerSec: number;
  scrollSec: number;
  /** Track heights are part of "where I was looking" — a squashed lane is a different view. */
  trackHeights?: Record<string, number>;
}

export type ZoomSlots = Record<number, ZoomView | undefined>;

export function isZoomSlot(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= ZOOM_SLOTS;
}

export function storeZoom(slots: ZoomSlots, slot: number, view: ZoomView): ZoomSlots {
  if (!isZoomSlot(slot)) return slots;
  return { ...slots, [slot]: { ...view } };
}

export function recallZoom(slots: ZoomSlots, slot: number): ZoomView | null {
  return isZoomSlot(slot) ? slots[slot] ?? null : null;
}

export function clearZoom(slots: ZoomSlots, slot: number): ZoomSlots {
  if (!isZoomSlot(slot) || !slots[slot]) return slots;
  const next = { ...slots };
  delete next[slot];
  return next;
}

export function filledZoomSlots(slots: ZoomSlots): number[] {
  const out: number[] = [];
  for (let n = 1; n <= ZOOM_SLOTS; n++) if (slots[n]) out.push(n);
  return out;
}

export function describeZoom(view: ZoomView): string {
  // px/s is the number that actually says how zoomed in you are; seconds on
  // screen is the number a person recognises.
  return `${view.pxPerSec.toFixed(0)} px/s · ${view.scrollSec.toFixed(1)}s 부터`;
}

// ── Window layouts ──────────────────────────────────────────────────────────

export interface WindowLayout {
  name: string;
  /** Which DAW window is on screen. */
  window: DawWindow;
  /** Side panels, by the workspace store's own names. */
  panels: Record<string, boolean>;
  /** The zoom that goes with the layout, when one was captured. */
  view?: ZoomView;
}

export const MAX_LAYOUTS = 8;

/**
 * Save a layout under a name, replacing one of the same name.
 *
 * Replacing rather than appending: saving "Mixing" twice means "this is what
 * Mixing looks like now", and a list with three entries called Mixing is a
 * list nobody can use.
 */
export function saveLayout(layouts: readonly WindowLayout[], layout: WindowLayout): WindowLayout[] {
  const name = layout.name.trim();
  if (name === '') return [...layouts];
  const without = layouts.filter((l) => l.name !== name);
  const next = [...without, { ...layout, name }];
  // Oldest goes when the cap is hit — a layout you have not re-saved in eight
  // layouts' time is not one you are using.
  return next.length > MAX_LAYOUTS ? next.slice(next.length - MAX_LAYOUTS) : next;
}

export function removeLayout(layouts: readonly WindowLayout[], name: string): WindowLayout[] {
  return layouts.filter((l) => l.name !== name);
}

export function findLayout(layouts: readonly WindowLayout[], name: string): WindowLayout | null {
  return layouts.find((l) => l.name === name) ?? null;
}

export function describeLayout(layout: WindowLayout): string {
  const open = Object.entries(layout.panels).filter(([, v]) => v).map(([k]) => k);
  return open.length === 0
    ? `${layout.window.toUpperCase()} · 패널 없음`
    : `${layout.window.toUpperCase()} · ${open.join(', ')}`;
}

// ── Linked selection ────────────────────────────────────────────────────────

/**
 * What the timeline selection becomes when the edit selection moves.
 *
 * Returns null when nothing should change — either the link is off, or the
 * two already agree.  Returning the same value would still be a store write,
 * and a store write on every selection change is a re-render on every mouse
 * move during a drag.
 */
export function linkedTimeline(
  linked: boolean,
  timeline: { startSec: number; endSec: number },
  edit: { startSec: number; endSec: number },
): { startSec: number; endSec: number } | null {
  if (!linked) return null;
  if (timeline.startSec === edit.startSec && timeline.endSec === edit.endSec) return null;
  return { startSec: edit.startSec, endSec: edit.endSec };
}
