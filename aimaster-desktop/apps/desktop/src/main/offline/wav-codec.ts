// wav-codec — the file-system half of the WAV path.
//
// The format itself lives in `src/shared/wav-format.ts` so the renderer can
// use the same parser on a baked preview. This module is what the main
// process adds to it: reading and writing actual files.

import fs from 'node:fs';
import {
  decodeWavToFloatStereo, encodeWavBuffer,
} from '../../shared/wav-format.js';

export {
  parseWavHeader, decodeWavToFloatStereo, decodeWavPlanar,
  encodeWavBuffer, resampleInterleaved,
  type WavInfo, type WavPlanar,
} from '../../shared/wav-format.js';

/**
 * Read and decode a WAV file to interleaved stereo at `targetRate`.
 *
 * Null — not an exception — when the file is missing or is not a WAV this
 * decoder handles, because the caller's response to both is the same: hand
 * it to ffmpeg instead.
 */
export function decodeWavFile(filePath: string, targetRate: number): Float32Array | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  return decodeWavToFloatStereo(buf, targetRate);
}

/** Write interleaved float audio to a WAV file. */
export function encodeWavFile(
  interleaved: Float32Array,
  sampleRate: number,
  bitDepth: 16 | 24 | 32,
  outputPath: string,
  channels: number,
): void {
  fs.writeFileSync(outputPath, encodeWavBuffer(interleaved, sampleRate, bitDepth, channels));
}
