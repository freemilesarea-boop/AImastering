// Reading a WAV, in Node, without a browser.
//
// The app decodes audio through the renderer's AudioContext, which a command
// line tool does not have.  The benchmark needs to read the user's own stem
// files on their own machine, so it needs its own reader — small, strict, and
// honest about what it does not support.
//
// Handles what a stem export actually is: PCM 16/24/32-bit and float 32/64,
// any channel count, any rate.  Refuses everything else by name rather than
// returning silence, because a benchmark that silently reads zeros reports a
// separator that works perfectly on nothing.

import fs from 'node:fs';

export interface WavAudio {
  channels: Float32Array[];
  sampleRate: number;
  /** Frames, not bytes. */
  length: number;
  bitDepth: number;
  float: boolean;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function readWav(path: string): WavAudio {
  const buf = fs.readFileSync(path);
  if (buf.length < 12) throw new Error(`${path}: 파일이 너무 짧습니다`);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: RIFF/WAVE 가 아닙니다`);
  }

  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataStart = -1;
  let dataLength = 0;

  // Chunk walk.  Sizes are little-endian and odd-sized chunks are padded to
  // even — a rule that is easy to miss and produces a reader that works on
  // most files and mangles the rest.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channelCount = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitDepth = buf.readUInt16LE(body + 14);
      if (format === FORMAT_EXTENSIBLE && size >= 40) {
        // The real format lives in the GUID's first two bytes.
        format = buf.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buf.length - body);
    }
    at = body + size + (size % 2);
  }

  if (dataStart < 0) throw new Error(`${path}: data 청크가 없습니다`);
  if (channelCount < 1) throw new Error(`${path}: 채널 수가 0 입니다`);
  const float = format === FORMAT_FLOAT;
  if (format !== FORMAT_PCM && !float) {
    throw new Error(`${path}: 압축된 WAV 는 못 읽습니다 (format ${format}) — PCM 이나 float 로 내보내세요`);
  }
  const bytes = bitDepth >> 3;
  if (![1, 2, 3, 4, 8].includes(bytes)) throw new Error(`${path}: ${bitDepth}비트는 못 읽습니다`);

  const frames = Math.floor(dataLength / (bytes * channelCount));
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    const base = dataStart + f * bytes * channelCount;
    for (let c = 0; c < channelCount; c++) {
      const o = base + c * bytes;
      let v: number;
      if (float) {
        v = bytes === 8 ? buf.readDoubleLE(o) : buf.readFloatLE(o);
      } else if (bytes === 1) {
        v = ((buf[o] ?? 128) - 128) / 128;            // 8-bit WAV is unsigned
      } else if (bytes === 2) {
        v = buf.readInt16LE(o) / 32768;
      } else if (bytes === 3) {
        // 24-bit: three bytes, sign-extended by hand.
        const raw = (buf[o] ?? 0) | ((buf[o + 1] ?? 0) << 8) | ((buf[o + 2] ?? 0) << 16);
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else {
        v = buf.readInt32LE(o) / 2147483648;
      }
      channels[c]![f] = v;
    }
  }

  return { channels, sampleRate, length: frames, bitDepth, float };
}
