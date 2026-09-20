// layout-ops.ts — capturing a room, and saying what walking into another one
// would change.
//
// `workspace-view.ts` has had `saveLayout`, `findLayout`, `removeLayout` and
// `describeLayout` since it was written, all four tested, none with a caller:
// `dawStore.layouts` was initialised to `[]` and `setLayouts` was never
// invoked from anywhere in the app, so the list could not stop being empty.
// A tracking layout and a mixing layout were a paragraph of documentation.
//
// The glue is here rather than in the store because capturing a layout reads
// TWO stores — the DAW's window and zoom, the workspace's panels, and the
// floating panels' geometry from a third — and a function that takes those as
// values can be checked without mounting any of them.
//
// RECALLING PREVIEWS FIRST, like the mix snapshots do.  Switching room is a
// bigger visual jump than restoring a fader, and "what is about to happen to
// my screen" is the question you have the moment before you press it.

import type {
  FloatingPlace, WindowLayout, ZoomView,
} from '../model/workspace-view.js';
import type { DawWindow } from '../model/view-window.js';

/** Everything a layout is made of, read off the live stores. */
export interface WorkspaceShot {
  window: DawWindow;
  panels: Record<string, boolean>;
  view: ZoomView;
  floating: readonly FloatingPlace[];
}

/**
 * Freeze the room under a name.
 *
 * Everything is copied out: a layout that shared the panels object with the
 * store would follow every later toggle, which is the one thing a saved
 * layout must not do — the same trap `mix-snapshot.ts` documents for inserts.
 */
export function captureLayout(name: string, shot: WorkspaceShot): WindowLayout {
  return {
    name: name.trim(),
    window: shot.window,
    panels: { ...shot.panels },
    view: { ...shot.view, ...(shot.view.trackHeights
      ? { trackHeights: { ...shot.view.trackHeights } } : {}) },
    floating: shot.floating.map((f) => ({ ...f })),
  };
}

export interface LayoutDiff {
  /** True when the docked window would change. */
  window: boolean;
  /** Panels the layout has open and the screen does not. */
  opening: string[];
  /** Panels the screen has open and the layout does not. */
  closing: string[];
  /** Panels that would be torn off, by id. */
  floatingOn: DawWindow[];
  /** Floated panels that would be put away, by id. */
  floatingOff: DawWindow[];
  /** True when the zoom would move. */
  zoom: boolean;
  /** True when nothing at all would change. */
  same: boolean;
}

export function layoutDiff(shot: WorkspaceShot, layout: WindowLayout): LayoutDiff {
  const opening: string[] = [];
  const closing: string[] = [];
  // Over the union of both sides' keys: a panel added to the workspace since
  // the layout was saved appears in one and not the other, and skipping it
  // would silently drop it from the comparison.
  for (const id of new Set([...Object.keys(shot.panels), ...Object.keys(layout.panels)])) {
    const now = shot.panels[id] === true;
    const then = layout.panels[id] === true;
    if (then && !now) opening.push(id);
    if (now && !then) closing.push(id);
  }

  const nowFloating = new Set(shot.floating.map((f) => f.id));
  const thenFloating = new Set((layout.floating ?? []).map((f) => f.id));
  const floatingOn = [...thenFloating].filter((id) => !nowFloating.has(id));
  const floatingOff = [...nowFloating].filter((id) => !thenFloating.has(id));

  const zoom = layout.view !== undefined
    && (layout.view.pxPerSec !== shot.view.pxPerSec
      || layout.view.scrollSec !== shot.view.scrollSec);

  const window = layout.window !== shot.window;
  return {
    window, opening, closing, floatingOn, floatingOff, zoom,
    same: !window && opening.length === 0 && closing.length === 0
      && floatingOn.length === 0 && floatingOff.length === 0 && !zoom,
  };
}

/**
 * What recalling would do, in one line.
 *
 * Counts rather than names: eight panel ids do not fit on a menu row, and the
 * number is the part that tells you whether this is the room you meant.
 */
export function describeLayoutDiff(diff: LayoutDiff): string {
  if (diff.same) return '지금 화면과 같습니다';
  const parts: string[] = [];
  if (diff.window) parts.push('창 바뀜');
  if (diff.opening.length) parts.push(`패널 ${diff.opening.length}개 열림`);
  if (diff.closing.length) parts.push(`패널 ${diff.closing.length}개 닫힘`);
  if (diff.floatingOn.length) parts.push(`${diff.floatingOn.length}개 띄움`);
  if (diff.floatingOff.length) parts.push(`${diff.floatingOff.length}개 닫음`);
  if (diff.zoom) parts.push('줌 이동');
  return parts.join(' · ');
}

/**
 * The next layout in the list after `name`, wrapping.
 *
 * For the cycle shortcut.  Returns null when there is nothing to cycle to —
 * an empty list, or a list of one, where "next" would be a no-op that still
 * printed a message.
 */
export function nextLayout(
  layouts: readonly WindowLayout[], current: string | null,
): WindowLayout | null {
  if (layouts.length === 0) return null;
  if (layouts.length === 1) return current === layouts[0]?.name ? null : layouts[0] ?? null;
  const at = layouts.findIndex((l) => l.name === current);
  // Unknown or unset current starts at the top rather than at index 1, so the
  // first press after a reload lands somewhere predictable.
  return layouts[at < 0 ? 0 : (at + 1) % layouts.length] ?? null;
}
