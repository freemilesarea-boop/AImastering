// Minimal Node-side WAV codec for the M1 equivalence harness.
//
// Supports:
//   - read:  PCM 16-bit / 24-bit / 32-bit, mono / stereo, RIFF (little endian)
//   - write: PCM 24-bit stereo (matches Python pipeline default output)
//
// Intentionally simple — not a general-purpose decoder.  Scope is the
// dsp-equivalence-compare.ts script and nothing else.

import * as fs from 'node:fs';
import type { AudioBufferLike } from '../../src/renderer/audio/loudnessCore.js';

interface ChunkInfo { id: string; size: number; offset: number }

function findChunk(buf: Buffer, id: string, fromOffset: number): ChunkInfo | null {
  let off = fromOffset;
  while (off + 8 <= buf.length) {
    const cid = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (cid === id) return { id: cid, size: sz, offset: off + 8 };
    off += 8 + sz + (sz % 2); // RIFF chunk size is padded to even
  }
  return null;
}

export interface WavReadResult extends AudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(c: number): Float32Array;
}

export function readWav(path: string): WavReadResult {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  }
  const fmt = findChunk(buf, 'fmt ', 12);
  if (!fmt) throw new Error(`fmt chunk missing in ${path}`);
  let formatCode = buf.readUInt16LE(fmt.offset);       // 1=PCM, 3=float, 65534=EXTENSIBLE
  const channels    = buf.readUInt16LE(fmt.offset + 2);
  const sampleRate  = buf.readUInt32LE(fmt.offset + 4);
  const bitsPerSamp = buf.readUInt16LE(fmt.offset + 14);

  // WAVE_FORMAT_EXTENSIBLE — the real format lives in the SubFormat GUID at
  // fmt.offset + 24..40.  First 2 bytes of the GUID indicate PCM (1) or float (3).
  if (formatCode === 0xfffe && fmt.size >= 40) {
    formatCode = buf.readUInt16LE(fmt.offset + 24);
  }

  const data = findChunk(buf, 'data', fmt.offset + fmt.size);
  if (!data) throw new Error(`data chunk missing in ${path}`);
  const bytesPerSample = bitsPerSamp >> 3;
  const frameBytes = bytesPerSample * channels;
  const numFrames = Math.floor(data.size / frameBytes);

  const planar: Float32Array[] = [];
  for (let c = 0; c < channels; c++) planar.push(new Float32Array(numFrames));

  const dataOff = data.offset;
  if (formatCode === 1 && bitsPerSamp === 16) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < channels; c++) {
        const v = buf.readInt16LE(dataOff + i * frameBytes + c * 2);
        planar[c]![i] = v / 32768.0;
      }
    }
  } else if (formatCode === 1 && bitsPerSamp === 24) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < channels; c++) {
        const o = dataOff + i * frameBytes + c * 3;
        // 24-bit LE signed → Int32, sign-extend from bit 23
        let v = buf[o]! | (buf[o + 1]! << 8) | (buf[o + 2]! << 16);
        if (v & 0x800000) v |= 0xff000000;
        // ECMAScript bitwise gives us a 32-bit signed already.
        planar[c]![i] = v / 8388608.0;   // 2^23
      }
    }
  } else if (formatCode === 1 && bitsPerSamp === 32) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < channels; c++) {
        const v = buf.readInt32LE(dataOff + i * frameBytes + c * 4);
        planar[c]![i] = v / 2147483648.0;
      }
    }
  } else if (formatCode === 3 && bitsPerSamp === 32) {
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < channels; c++) {
        planar[c]![i] = buf.readFloatLE(dataOff + i * frameBytes + c * 4);
      }
    }
  } else {
    throw new Error(`unsupported WAV format: code=${formatCode} bits=${bitsPerSamp}`);
  }

  return {
    sampleRate,
    numberOfChannels: channels,
    length: numFrames,
    getChannelData(c: number): Float32Array {
      const ch = planar[c];
      if (!ch) throw new RangeError(`channel ${c} out of range (0..${channels - 1})`);
      return ch;
    },
  };
}

/** Write PCM 24-bit little-endian stereo (or mono) WAV. */
export function writeWav24(
  path: string,
  channels: Float32Array[],
  sampleRate: number,
): void {
  if (channels.length === 0) throw new Error('writeWav24: no channels');
  const numCh = channels.length;
  const numFrames = channels[0]!.length;
  for (const ch of channels) {
    if (ch.length !== numFrames) {
      throw new Error('writeWav24: channel length mismatch');
    }
  }
  const bitsPerSample = 24;
  const byteRate = sampleRate * numCh * 3;
  const dataSize = numFrames * numCh * 3;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);                    // fmt chunk size
  buf.writeUInt16LE(1, 20);                     // PCM
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(numCh * 3, 32);             // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  const MAX24 = 8388607;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = Math.round(channels[c]![i]! * 8388608);
      if (v > MAX24) v = MAX24;
      if (v < -MAX24 - 1) v = -MAX24 - 1;
      buf[off]     = v & 0xff;
      buf[off + 1] = (v >> 8) & 0xff;
      buf[off + 2] = (v >> 16) & 0xff;
      off += 3;
    }
  }

  fs.writeFileSync(path, buf);
}
