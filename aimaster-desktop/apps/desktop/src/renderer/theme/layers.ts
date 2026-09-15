// layers — the app's stacking order, written down once.
//
// It was not written down, and the result was a notification nobody could
// read: the toast is `fixed z-50` and the DAW's overlays are `z-[8000]` …
// `z-[9000]`, all siblings in the same stacking context, so opening the
// shortcut help put a 70 %-black scrim over every message the app had to give
// — including the ones raised BY a shortcut.  Measured, not guessed:
// `document.elementFromPoint` at the toast's own centre returned the help
// overlay's backdrop.
//
// The numbers are spaced so a new surface can be slotted between two existing
// ones without renumbering anything.  The rule that matters, and the one the
// selftest holds, is the last line: the notification layer is above
// everything, because a message the user cannot see is the same as no message.

export const LAYER = {
  /** The 루베르 watermark — decoration, under all content. */
  watermark: 10,
  /** Docked DAW chrome: inspector, bottom transport + mix console. */
  chrome: 30,
  /** Panels that float over a view but not over a dialog. */
  panel: 40,
  /** Dialogs that own the screen: license, album, batch rename, quantize… */
  dialog: 50,
  /** Floating plugin windows, stacked among themselves by `+ win.z`. */
  pluginWindow: 200,
  /** Small popovers raised from inside a view (the fade-curve picker). */
  popover: 400,
  /** DAW overlays with a full-screen scrim: MediaBay, smart controls, rack. */
  scrim: 8000,
  /** The shortcut help — over the scrims, because '?' is asked from one. */
  help: 9000,
  /** The external-file drop target: over everything it could be dropped on. */
  drop: 9500,
  /** Toasts and the update card.  Nothing may be above this. */
  notification: 10000,
} as const;

export type LayerName = keyof typeof LAYER;

/**
 * How high the plugin-window band may climb before it would reach the layer
 * above it.  Windows are ranked 0…n-1 by `pluginWindowStore.focus`, so this is
 * a ceiling nobody is expected to touch — it is here so that "nobody is
 * expected to" is not the only thing holding it.
 */
export const PLUGIN_WINDOW_BAND = LAYER.popover - LAYER.pluginWindow - 1;

/** The stacking value for the plugin window ranked `rank`, clamped to the band. */
export function pluginWindowLayer(rank: number): number {
  const r = Number.isFinite(rank) ? Math.max(0, Math.trunc(rank)) : 0;
  return LAYER.pluginWindow + Math.min(r, PLUGIN_WINDOW_BAND);
}
