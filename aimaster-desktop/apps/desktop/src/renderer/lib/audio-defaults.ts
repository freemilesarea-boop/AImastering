// audio-defaults — the settings page's "오디오 기본값", read back at launch.
//
// The three keys behind that section (defaultStyle / defaultSampleRate /
// defaultBitDepth) were written on every change and read by nobody, so the
// section persisted a preference that could not survive the relaunch it was
// persisted for.  This is the read side.
//
// Every value arrives from disk, which means it arrives from a file a person
// can edit and from whatever shape a previous version of this app wrote.  So
// each key is validated on its own and a key that fails is DROPPED rather than
// defaulted: a bad `defaultBitDepth` must not also throw away a good
// `defaultStyle`, and silently substituting a value would persist a preference
// the user never expressed.

import type { MasteringOptions } from '../stores/audioStore.js';
import type { MasteringStyle } from '@aimaster/shared-types';

/** The keys this module owns, in the store's own spelling. */
export const AUDIO_DEFAULT_KEYS = ['defaultStyle', 'defaultSampleRate', 'defaultBitDepth'] as const;
export type AudioDefaultKey = typeof AUDIO_DEFAULT_KEYS[number];

const STYLES: readonly MasteringStyle[] = ['balanced', 'warm', 'bright', 'punch'];
/** What the settings page offers — the main-process validator holds the same list. */
export const SAMPLE_RATES: readonly number[] = [44100, 48000, 96000];
export const BIT_DEPTHS: readonly (16 | 24)[] = [16, 24];

function isStyle(v: unknown): v is MasteringStyle {
  return typeof v === 'string' && (STYLES as readonly string[]).includes(v);
}

/**
 * Turn what the store holds into an options patch.
 *
 * `undefined` for a key that was never written is the ordinary case, not an
 * error — a fresh install has none of them.
 */
export function audioDefaultsPatch(
  stored: Partial<Record<AudioDefaultKey, unknown>>,
): Partial<MasteringOptions> {
  const patch: Partial<MasteringOptions> = {};
  if (isStyle(stored.defaultStyle)) patch.style = stored.defaultStyle;
  if (typeof stored.defaultSampleRate === 'number' && SAMPLE_RATES.includes(stored.defaultSampleRate)) {
    patch.sampleRate = stored.defaultSampleRate;
  }
  if (stored.defaultBitDepth === 16 || stored.defaultBitDepth === 24) {
    patch.bitDepth = stored.defaultBitDepth;
  }
  return patch;
}

/**
 * Read the three keys and hand back the patch.
 *
 * One `settings:get` per key because that is the channel's shape.  A key that
 * throws (an older build with a narrower whitelist, a store that cannot be
 * read) contributes nothing and does not stop the other two — launching with
 * two of three preferences beats launching with none.
 */
export async function readAudioDefaults(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): Promise<Partial<MasteringOptions>> {
  const stored: Partial<Record<AudioDefaultKey, unknown>> = {};
  for (const key of AUDIO_DEFAULT_KEYS) {
    try {
      stored[key] = await invoke('settings:get', key);
    } catch { /* a key we cannot read is a key the user has not set */ }
  }
  return audioDefaultsPatch(stored);
}
