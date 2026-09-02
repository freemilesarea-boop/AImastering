// Transposing a whole clip — WSOLA twice, in opposite directions.
//
// A resampler moves pitch and length together; a DAW needs them apart.  The
// trick is that a time stretch and a resample are inverse operations in TIME
// and not in FREQUENCY, so doing both leaves only the frequency shift:
//
//   1. Stretch the material by the ratio.  Up a fifth (ratio 1.5) means
//      making it 1.5× LONGER, at its original pitch.
//   2. Read that back at 1.5 samples per output sample.  The length comes
//      back to where it started and everything in it is a fifth higher.
//
// The stretch is the WSOLA already used for warp — same window presets, same
// similarity search, so a transposed drum loop keeps its attacks for the same
// reason a warped one does.  The read is linear-interpolated, which is enough
// because the stretch has already put the material at a higher sample density
// than the read consumes.
//
// PSOLA (audio/pitch-shift.ts) is the better tool for a SUNG note and the
// wrong one here: it needs an F0 track to place its grains, which a drum bus
// or a full mix does not have.  Two algorithms for two jobs, named for what
// they do.

import { modeOptions, stretchChannels } from './time-stretch.js';
import { semitoneRatio, PITCH_EPS } from '../model/clip-pitch.js';
import type { WarpMode } from '../model/warp.js';

/** Linear-interpolated read, so the resample is not quantised to samples. */
function sampleAt(data: Float32Array, position: number): number {
  if (position <= 0) return data[0] ?? 0;
  if (position >= data.length - 1) return data[data.length - 1] ?? 0;
  const i = Math.floor(position);
  const frac = position - i;
  return (data[i] ?? 0) * (1 - frac) + (data[i + 1] ?? 0) * frac;
}

/**
 * Transpose every channel by `semitones`, keeping the length exactly.
 *
 * Returns the input array itself at zero — an identity that costs nothing and
 * is bit-exact, which matters because a clip whose transpose has been dragged
 * back to unity must sound like the file again, not like the file through a
 * round trip.
 */
export function shiftChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  semitones: number,
  mode: WarpMode = 'tones',
): Float32Array[] {
  if (channels.length === 0) return [];
  if (!Number.isFinite(semitones) || Math.abs(semitones) < PITCH_EPS) {
    return channels.map((ch) => ch);
  }
  const length = channels[0]?.length ?? 0;
  if (length === 0) return channels.map(() => new Float32Array(0));

  const ratio = semitoneRatio(semitones);
  // One extra window of headroom: the read at the very end lands past the
  // last output sample of the stretch, and reading off the end would fade the
  // final milliseconds instead of playing them.
  const options = modeOptions(mode, sampleRate);
  const stretched = stretchChannels(
    channels,
    Math.max(1, Math.round(length * ratio) + options.windowSamples),
    (outSample) => outSample / ratio,
    options,
  );

  return stretched.map((ch) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = sampleAt(ch, i * ratio);
    return out;
  });
}
