// Which insert and send slots a channel strip draws.
//
// A rule rather than a constant, because drawing all five of each was pushing
// the fader off the screen.  Measured on a session with one send and no
// inserts:
//
//   app chrome above the console      186 px
//   strip chrome above the fader      476 px   (inserts 131 + sends 131 = 262)
//   nameplate below it                 38 px
//   ─────────────────────────────────────────
//   before a single pixel of fader    700 px
//
// Ten of the strip's thirteen selectors were showing "—", so more than half of
// everything above the fader was reserved for slots nobody was using.  At a
// 720 px window that left 53 px of a 134 px fader, and put the track's own
// NAME 123 px below the bottom of the screen — unreachable, because the strip
// overflowed rather than scrolled.
//
// Collapsed, a section shows what is in use plus the next free slot, so
// building a chain downward is unchanged.  What it costs is reaching for a
// specific letter while the ones above it are empty, and that is what the
// section's A–E toggle is for: the capability stays, the 170 px does not.

/** Slots per section — A…E, like the top half of a Pro Tools strip. */
export const SLOTS = 5;

/**
 * The slots to draw, given which ones are occupied.
 *
 * Always includes ONE free slot when there is one, because a section with no
 * empty row is a section you cannot add to.  Sorted, so the letters read down
 * the strip in order however the occupied set arrived.
 */
export function slotsToShow(used: readonly number[], expanded: boolean): number[] {
  const all = Array.from({ length: SLOTS }, (_, i) => i);
  if (expanded) return all;
  const occupied = new Set(used);
  const shown = all.filter((slot) => occupied.has(slot));
  const nextFree = all.find((slot) => !occupied.has(slot));
  if (nextFree !== undefined) shown.push(nextFree);
  return shown.sort((a, b) => a - b);
}

/**
 * A slot's letter.
 *
 * Drawn on every row, collapsed or not: "the compressor is in C" is how an
 * engineer remembers a chain, and a list that hides the empty slots has to say
 * where the remaining ones actually sit or it has traded space for confusion.
 */
export function slotLetter(slot: number): string {
  return String.fromCharCode(65 + slot);
}
