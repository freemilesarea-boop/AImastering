// WAV encoding for offline renders.
//
// 24-bit PCM by default — the session bit depth engineers actually deliver,
// and it round-trips an OfflineAudioContext render without the truncation
// artefacts 16-bit would add.  32-bit float is offered for intermediate
// renders (Freeze / Consolidate) where nothing should be quantised at all.
//
// Every reduction to a fixed-point depth goes through a DITHERED quantiser
// (audio/dither.ts).  It used to be a bare `Math.round`, which correlates the
// rounding error with the signal and is what makes a quiet reverb tail step
// and buzz instead of fading.  `dither: 'none'` reproduces the old bytes
// exactly, for anyone who wants to hear the difference.

import {
  createQuantizer, defaultDither, type DitherMode, type QuantBitDepth,
} from '../audio/dither.js';
import {
  codingHistory, infoTags, provenanceJson, type Provenance,
} from '../model/provenance.js';

export type WavBitDepth = 16 | 24 | 32;

export type { DitherMode };

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

// ── Metadata chunks ──────────────────────────────────────────────────────────
//
// Three, because three different readers matter and none of them reads all
// three:
//
//   LIST/INFO  every player, tagger and file browser
//   bext       the Broadcast Wave standard — what mastering and broadcast
//              tools read to find out what happened to a file
//   LOUI       the exact record, as JSON, for reading back without guessing
//
// RIFF rules that are easy to get wrong and silent when you do: every chunk
// is id(4) + size(4) + data, the SIZE EXCLUDES the pad byte an odd-length
// chunk needs, and the RIFF size field counts everything after itself.  A
// file that gets any of these wrong opens fine in some tools and is rejected
// by others, which is the worst way to find out.

/** UTF-8, because titles and notes are Korean far more often than not. */
const utf8 = new TextEncoder();

function chunkBytes(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length % 2;
  const out = new Uint8Array(8 + body.length + pad);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, id);
  view.setUint32(4, body.length, true);      // the pad byte is NOT counted
  out.set(body, 8);
  return out;
}

/** LIST/INFO — the tags everything reads. */
function infoChunk(tags: readonly [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [utf8.encode('INFO')];
  for (const [id, value] of tags) {
    // NUL-terminated by the spec; readers that ignore the terminator still
    // stop at it, and readers that honour it need it.
    parts.push(chunkBytes(id, utf8.encode(`${value}\u0000`)));
  }
  return chunkBytes('LIST', concat(parts));
}

/** Fixed-width ASCII field, truncated and NUL-padded as the bext spec wants. */
function fixed(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const src = utf8.encode(text);
  out.set(src.subarray(0, length));
  return out;
}

/**
 * Broadcast Wave `bext`, version 2.
 *
 * The loudness fields are written as 0x7FFF — the spec's "not measured".
 * Writing a plausible-looking zero would claim a measurement nobody made,
 * and a mastering engineer reading −0.0 LUFS off a file believes it.
 */
function bextChunk(p: Provenance, appVersion: string, at: Date): Uint8Array {
  const body = new Uint8Array(602);
  const view = new DataView(body.buffer);
  const pad2 = (n: number): string => n.toString().padStart(2, '0');

  body.set(fixed(describeForBext(p), 256), 0);
  body.set(fixed(`${p.artist || 'unknown'}`, 32), 256);
  body.set(fixed(`Louver Mastering AI ${appVersion}`, 32), 288);
  body.set(fixed(
    `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`, 10), 320);
  body.set(fixed(
    `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`, 8), 330);
  view.setUint32(338, 0, true);                 // TimeReference low
  view.setUint32(342, 0, true);                 // TimeReference high
  view.setUint16(346, 2, true);                 // bext version 2
  // 348..411 UMID — left zero, which the spec reads as "none".
  for (let off = 412; off <= 420; off += 2) view.setInt16(off, 0x7fff, true);
  // 422..601 reserved, zero.

  return chunkBytes('bext', concat([body, utf8.encode(codingHistory(p, appVersion))]));
}

/** bext Description is one line, 256 bytes — the headline, not the essay. */
function describeForBext(p: Provenance): string {
  const ai = p.aiWork.length > 0 ? `AI:${p.aiWork.map((s) => s.kind).join('+')}` : 'AI:none';
  const derived = p.derivedFrom.length > 0
    ? `derivative of ${p.derivedFrom.map((s) => s.title).join(' + ')}`
    : 'original work';
  return `${p.title || 'untitled'} / ${p.artist || 'unknown'} | ${ai} | ${derived}`;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

/** Everything that goes between `fmt ` and `data`. */
function metadataChunks(
  meta: WavMetadata | undefined,
): Uint8Array {
  if (!meta) return new Uint8Array(0);
  const { provenance, appVersion, at = new Date() } = meta;
  return concat([
    infoChunk(infoTags(provenance, appVersion, at)),
    bextChunk(provenance, appVersion, at),
    chunkBytes('LOUI', utf8.encode(provenanceJson(provenance, appVersion, at))),
  ]);
}

/** What to write into the file besides the audio. */
export interface WavMetadata {
  provenance: Provenance;
  appVersion: string;
  /** Injectable so a test gets the same bytes twice. */
  at?: Date;
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
  dither: DitherMode = defaultDither(bitDepth),
  meta?: WavMetadata,
): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const isFloat = bitDepth === 32;

  // Metadata sits between `fmt ` and `data`, where the spec puts it and where
  // ffmpeg and every DAW writes it.  It moves the audio off byte 44, so
  // nothing may assume that offset any more — the reason `dataStart` is
  // computed below rather than written as a literal.
  const extra = metadataChunks(meta);

  const buffer = new ArrayBuffer(44 + extra.length + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeAscii(view, 0, 'RIFF');
  // Everything after this field: 'WAVE' + fmt chunk + metadata + data chunk.
  view.setUint32(4, 36 + extra.length + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                       // PCM fmt chunk size
  view.setUint16(20, isFloat ? 3 : 1, true);          // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  bytes.set(extra, 36);
  writeAscii(view, 36 + extra.length, 'data');
  view.setUint32(40 + extra.length, dataBytes, true);
  const dataStart = 44 + extra.length;

  // One quantiser for the whole file: noise shaping is stateful per channel,
  // and it has to see a channel's samples in order to have any state worth
  // keeping.  Float needs none of this and never builds one.
  const quantizer = isFloat
    ? null
    : createQuantizer(bitDepth as QuantBitDepth, dither, channelCount);

  let offset = dataStart;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = channels[c]?.[i] ?? 0;
      if (isFloat || !quantizer) {
        view.setFloat32(offset, sample, true);
        offset += 4;
        continue;
      }
      const v = quantizer.code(sample, c);
      if (bitDepth === 24) {
        view.setUint8(offset,     v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      } else {
        view.setInt16(offset, v, true);
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
  dither: DitherMode = defaultDither(bitDepth),
  meta?: WavMetadata,
): Uint8Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return encodeWav(channels, buffer.sampleRate, bitDepth, dither, meta);
}
