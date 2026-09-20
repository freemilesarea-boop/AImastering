// dropdown-place.ts — keeping a menu on screen.
//
// The layout menu hangs off a button near the right of a toolbar that wraps,
// and `left-0` put a 320 px panel half outside the window: the row's delete
// buttons were past the edge and could not be clicked.  Measured in the
// packaged app at 1100 px wide, not guessed.
//
// Anchoring to the right instead only moves the problem: the toolbar wraps,
// so on a narrow window the same button can end up near the left edge, and a
// right-anchored menu would then hang off THAT side.  So the offset is
// computed from where the button actually is.
//
// `EditWindow` already had a hand-rolled version of this thought —
// `Math.min(at.x, window.innerWidth - 150)` with the 150 spelled out — which
// is the same clamp for one particular menu and no other.

/**
 * How far left of its button a dropdown must sit to stay on screen.
 *
 * Returns an offset in pixels, relative to the button's left edge: 0 when the
 * menu fits where it naturally wants to be, negative when it has to slide
 * left.  Never positive — a menu is never pushed further out than its anchor.
 *
 * The left gutter wins when the menu is wider than the window: something has
 * to be cut off, and cutting the right is the side whose loss is legible —
 * the row starts where you expect and runs out, rather than starting off
 * screen with its first column missing.
 */
export function dropdownOffset(
  buttonLeft: number, menuWidth: number, viewportWidth: number, gutter = 8,
): number {
  if (!Number.isFinite(buttonLeft) || !Number.isFinite(viewportWidth)) return 0;
  const overflow = buttonLeft + menuWidth + gutter - viewportWidth;
  if (overflow <= 0) return 0;
  // Not further left than the gutter, whatever the overflow says.
  return Math.max(-overflow, gutter - buttonLeft);
}
