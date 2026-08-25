// WAV encoding for offline renders.
//
// 24-bit PCM by default — the session bit depth engineers actually deliver,
// and it round-trips an OfflineAudioContext render without the truncation
// artefacts 16-bit would add.  32-bit float is offered for intermediate
// renders (Freeze / Consolidate) where nothing should be quantised at all.

export type WavBitDepth = 16 | 24 | 32;

/** Interleave planar channel data into a single frame-major array. */
export function interleave(channels: readonly Float32Array[], length: number): Float32Array {
  const count = channels.length;
  const out = new Float32Array(length * count);
  for (let c = 0; c < count; c++) {
    const data = channels[c];
    if (!data) continue;
    for (let i = 0; i < length; i++) out[i * count + c] = data[i] ?? 0;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encode planar float channels as a RIFF/WAVE file.
 *
 * INTEGER depths clamp to [-1, 1): 16- and 24-bit PCM have no room above full
 * scale, and letting a hot sample wrap around turns a clip into noise.
 *
 * 32-bit FLOAT does not clamp, and must not.  Carrying values past full scale
 * losslessly is the entire reason to reach for float, and every caller that
 * asks for it is writing an intermediate — a freeze, a region render, the mix
 * on its way to the mastering stage.  Seven stems summing at unity routinely
 * peak above 0 dBFS; clamping there hard-clips the mix before the limiter
 * that was supposed to deal with it ever sees it, and nothing downstream can
 * get it back.  A bounce, which is a delivery rather than an intermediate,
 * asks for 24-bit and does clamp.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth = 24,
): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const isFloat = bitDepth === 32;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                       // PCM fmt chunk size
  view.setUint16(20, isFloat ? 3 : 1, true);          // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = channels[c]?.[i] ?? 0;
      if (isFloat) {
        view.setFloat32(offset, sample, true);
        offset += 4;
        continue;
      }
      const clamped = Math.max(-1, Math.min(1, sample));
      if (bitDepth === 24) {
        const v = Math.round(clamped * 0x7fffff);
        view.setUint8(offset,     v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      } else {
        view.setInt16(offset, Math.round(clamped * 0x7fff), true);
        offset += 2;
      }
    }
  }
  return new Uint8Array(buffer);
}

/** Convenience wrapper for an AudioBuffer-shaped object. */
export function encodeAudioBuffer(
  buffer: { numberOfChannels: number; sampleRate: number; getChannelData(c: number): Float32Array },
  bitDepth: WavBitDepth = 24,
): Uint8Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return encodeWav(channels, buffer.sampleRate, bitDepth);
}
