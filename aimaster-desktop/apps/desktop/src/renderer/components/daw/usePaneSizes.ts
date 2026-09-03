// usePaneSizes — the panes a DAW lets you resize, and remembers.
//
// A fixed layout is fine for a screenshot and wrong for work: how much of
// the window belongs to the arrange area versus the console depends on what
// the user is doing right now, and on their screen. So the three edges that
// matter are draggable — the inspector's width, the rack's width and the
// console's height — and the sizes persist, because re-dragging them at the
// start of every session is exactly the kind of small tax that makes a tool
// feel unfinished.
//
// Sizes are clamped rather than free. A pane dragged to two pixels is not a
// layout the user meant; it is a pane they will have to hunt for the edge of
// to get back.

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'loui.daw.panes';
const COLLAPSED_KEY = 'loui.daw.panes.collapsed';

export interface PaneSizes {
  inspector: number;
  rack: number;
  console: number;
}

export const PANE_LIMITS = {
  inspector: { min: 170, max: 460, initial: 208 },
  rack:      { min: 170, max: 460, initial: 224 },
  console:   { min: 120, max: 620, initial: 256 },
} as const;

export type PaneKey = keyof PaneSizes;

/**
 * Which panes are folded away.
 *
 * Collapsing is not the same as dragging to the minimum: the pane keeps the
 * width it had, so unfolding puts the layout back exactly as it was rather
 * than at some default the user never chose. That is what makes Alt+I worth
 * pressing twice.
 */
export type Collapsed = Record<PaneKey, boolean>;

export function loadCollapsed(): Collapsed {
  const none: Collapsed = { inspector: false, rack: false, console: false };
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return none;
    const parsed = JSON.parse(raw) as Partial<Collapsed>;
    return {
      inspector: parsed.inspector === true,
      rack: parsed.rack === true,
      console: parsed.console === true,
    };
  } catch {
    return none;
  }
}

/** The width a pane occupies right now — 0 while folded. */
export function paneExtent(sizes: PaneSizes, collapsed: Collapsed, key: PaneKey): number {
  return collapsed[key] ? 0 : sizes[key];
}

function clampPane(key: PaneKey, value: number): number {
  const { min, max } = PANE_LIMITS[key];
  if (!Number.isFinite(value)) return PANE_LIMITS[key].initial;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function loadPaneSizes(): PaneSizes {
  const fallback: PaneSizes = {
    inspector: PANE_LIMITS.inspector.initial,
    rack: PANE_LIMITS.rack.initial,
    console: PANE_LIMITS.console.initial,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PaneSizes>;
    return {
      inspector: clampPane('inspector', parsed.inspector ?? fallback.inspector),
      rack: clampPane('rack', parsed.rack ?? fallback.rack),
      console: clampPane('console', parsed.console ?? fallback.console),
    };
  } catch {
    return fallback;
  }
}

/**
 * Pane sizes plus a drag handler per edge.
 *
 * The drag is tracked on `window` rather than on the handle, so moving the
 * pointer faster than React re-renders — which is most of a real drag —
 * does not drop the gesture the moment the cursor leaves the four-pixel
 * grab strip.
 */
export function usePaneSizes(): {
  sizes: PaneSizes;
  /** Live extents — the same as `sizes`, except a folded pane reads 0. */
  extents: PaneSizes;
  collapsed: Collapsed;
  togglePane: (key: PaneKey) => void;
  setPaneCollapsed: (key: PaneKey, value: boolean) => void;
  startDrag: (key: PaneKey, e: React.PointerEvent) => void;
  dragging: PaneKey | null;
} {
  const [sizes, setSizes] = useState<PaneSizes>(() => loadPaneSizes());
  const [collapsed, setCollapsed] = useState<Collapsed>(() => loadCollapsed());
  const [dragging, setDragging] = useState<PaneKey | null>(null);
  const origin = useRef<{ key: PaneKey; start: number; from: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes)); } catch { /* not fatal */ }
  }, [sizes]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* not fatal */ }
  }, [collapsed]);

  const togglePane = useCallback((key: PaneKey) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const setPaneCollapsed = useCallback((key: PaneKey, value: boolean) => {
    setCollapsed((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const startDrag = useCallback((key: PaneKey, e: React.PointerEvent) => {
    e.preventDefault();
    // Dragging a folded pane's edge unfolds it — the handle is still there,
    // and grabbing it is an unambiguous request for the pane back.
    setCollapsed((prev) => (prev[key] ? { ...prev, [key]: false } : prev));
    origin.current = {
      key,
      start: key === 'console' ? e.clientY : e.clientX,
      from: sizes[key],
    };
    setDragging(key);
  }, [sizes]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent): void => {
      const o = origin.current;
      if (!o) return;
      // Which way the edge grows: the inspector's edge is on its right, the
      // rack's on its left, the console's on its top.
      const delta = o.key === 'console' ? o.start - e.clientY
        : o.key === 'rack' ? o.start - e.clientX
        : e.clientX - o.start;
      setSizes((prev) => ({ ...prev, [o.key]: clampPane(o.key, o.from + delta) }));
    };
    const up = (): void => { origin.current = null; setDragging(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging]);

  const extents: PaneSizes = {
    inspector: paneExtent(sizes, collapsed, 'inspector'),
    rack: paneExtent(sizes, collapsed, 'rack'),
    console: paneExtent(sizes, collapsed, 'console'),
  };

  return { sizes, extents, collapsed, togglePane, setPaneCollapsed, startDrag, dragging };
}
