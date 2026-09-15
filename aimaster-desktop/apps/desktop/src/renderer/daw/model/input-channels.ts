// input-channels.ts — which socket on the interface feeds this track.
//
// A studio interface has 2, 8, 18 inputs.  The recorder asked for
// `channelCount: 1` or `2` and got the device's FIRST one or two — so the mic
// in input 5 was unreachable, and every track that armed heard input 1.
//
// The fix is the standard Web Audio one: open the device at its full width and
// pull the wanted channel out with a splitter.  This module is the part that
// decides WHICH — the arithmetic and the naming, kept away from the engine so
// it can be reasoned about and tested without a device.
//
// The vocabulary matters because interfaces and code disagree about it.  The
// panel on the box says INPUT 1; arrays start at 0.  Everything here is
// zero-based `index` internally and one-based when it is shown, and the two
// are never the same word.

/** What one physical input, or one stereo pair, a track is set to record. */
export interface InputPatch {
  /** Zero-based index of the first channel taken from the device. */
  firstChannel: number;
  /** 1 = mono from that channel, 2 = stereo from it and the next. */
  channels: 1 | 2;
}

export const DEFAULT_PATCH: InputPatch = { firstChannel: 0, channels: 1 };

/**
 * A device wider than this is almost certainly the browser reporting nonsense.
 *
 * Real interfaces reach 32 inputs; a number past that has come from a
 * misreported constraint, and opening a stream that wide would fail anyway.
 */
export const MAX_INPUT_CHANNELS = 32;

export function clampDeviceChannels(count: number | undefined): number {
  if (!Number.isFinite(count) || (count as number) < 1) return 1;
  return Math.min(MAX_INPUT_CHANNELS, Math.floor(count as number));
}

/**
 * Hold a patch inside what the device actually has.
 *
 * A stereo pair whose second channel is past the end becomes MONO rather than
 * being pushed down to fit: somebody who chose inputs 7/8 on a device that
 * turned out to have 7 wants input 7, not inputs 6/7.  Silently sliding the
 * pair down would record the wrong microphone and sound perfectly fine doing
 * it.
 */
export function clampPatch(patch: InputPatch, deviceChannels: number): InputPatch {
  const width = clampDeviceChannels(deviceChannels);
  const first = Math.max(0, Math.min(width - 1, Math.floor(patch.firstChannel)));
  const channels: 1 | 2 = patch.channels === 2 && first + 1 < width ? 2 : 1;
  return { firstChannel: first, channels };
}

export function patchIsValid(patch: InputPatch, deviceChannels: number): boolean {
  const held = clampPatch(patch, deviceChannels);
  return held.firstChannel === patch.firstChannel && held.channels === patch.channels;
}

/** How wide the stream has to be opened to reach this patch. */
export function requiredChannels(patch: InputPatch): number {
  return Math.min(MAX_INPUT_CHANNELS, patch.firstChannel + patch.channels);
}

/** The device channel indices this patch reads, in order. */
export function patchChannels(patch: InputPatch): number[] {
  return patch.channels === 2
    ? [patch.firstChannel, patch.firstChannel + 1]
    : [patch.firstChannel];
}

/** `입력 3` or `입력 3/4` — one-based, the way the box is labelled. */
export function describePatch(patch: InputPatch): string {
  const first = patch.firstChannel + 1;
  return patch.channels === 2 ? `입력 ${first}/${first + 1}` : `입력 ${first}`;
}

/** Every patch a device of this width offers, for a picker. */
export function patchOptions(deviceChannels: number): InputPatch[] {
  const width = clampDeviceChannels(deviceChannels);
  const out: InputPatch[] = [];
  for (let i = 0; i < width; i++) out.push({ firstChannel: i, channels: 1 });
  // Pairs on the natural boundaries — 1/2, 3/4, 5/6.  An interface's stereo
  // pairs are wired that way, and offering 2/3 as well doubles the list with
  // options nobody has ever wanted.
  for (let i = 0; i + 1 < width; i += 2) out.push({ firstChannel: i, channels: 2 });
  return out;
}

/**
 * How many device channels a set of armed tracks needs opened.
 *
 * One stream, opened once at the widest patch anybody needs, then split.
 * Opening a stream per track would make the browser ask for the device several
 * times and — on the interfaces that allow it at all — give each stream its
 * own clock, which is how two tracks recorded together end up drifting apart.
 */
export function streamWidthFor(patches: readonly InputPatch[]): number {
  let width = 1;
  for (const patch of patches) width = Math.max(width, requiredChannels(patch));
  return Math.min(MAX_INPUT_CHANNELS, width);
}

export function describeDevice(label: string, channels: number): string {
  const width = clampDeviceChannels(channels);
  return width > 2 ? `${label} · 입력 ${width}개` : label;
}
