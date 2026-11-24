// What a saved master actually gets written as.
//
// The engine renders a 24-bit master.  Choosing 16-bit is a bit-depth
// REDUCTION, which is exactly when dither matters, and above 24 bits there is
// nothing to dither — so the two choices travel together and one function
// decides what reaches the file.
//
// This file exists because they did NOT travel together.  The 저장 button on
// the result screen routed through `file:save-audio` and carried both; the
// keyboard export (Mod+Alt+E) still called the older `file:save-wav`, which
// is a plain copy.  Someone who picked 16-bit with TPDF dither on that very
// screen and pressed the key got a 24-bit file with no dither and nothing
// said so.  The choice now lives in the store both doorways read, and the
// payload is built here so neither can build it differently.

/** Bit depths the save dialog offers. */
export type SaveDepth = '16' | '24' | '32';

/** Dither shapes, meaningful only when the depth actually drops. */
export type SaveDither = 'none' | 'tpdf' | 'shaped';

// The labels are the ones the result screen already showed, moved verbatim —
// this change is about where the choice lives, not about what it reads.
export const SAVE_DEPTHS: { id: SaveDepth; label: string; hint: string }[] = [
  { id: '16', label: '16-bit', hint: 'CD · 일부 배급사' },
  { id: '24', label: '24-bit', hint: '기본' },
  { id: '32', label: '32-bit', hint: 'Float · 무손실 보관' },
];

export const SAVE_DITHERS: { id: SaveDither; label: string }[] = [
  { id: 'none',   label: '없음' },
  { id: 'tpdf',   label: 'TPDF' },
  { id: 'shaped', label: '노이즈 셰이핑' },
];

/** Dither only means something when the depth drops below the 24-bit render. */
export function ditherApplies(depth: SaveDepth): boolean {
  return depth === '16';
}

export interface SaveAudioRequest {
  sourcePath: string;
  format: 'wav';
  bitDepth: number;
  dither: SaveDither;
}

/**
 * The `file:save-audio` payload for a master.
 *
 * One builder, so the button and the key cannot disagree about whether the
 * dither selector applies at the chosen depth.
 */
export function saveAudioRequest(
  sourcePath: string,
  depth: SaveDepth,
  dither: SaveDither,
): SaveAudioRequest {
  return {
    sourcePath,
    format: 'wav',
    bitDepth: Number(depth),
    dither: ditherApplies(depth) ? dither : 'none',
  };
}

/** What the main process answers with. */
export interface SaveAudioResult {
  savedPath: string | null;
  error?: string;
  warning?: string;
}
