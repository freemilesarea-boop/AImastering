// wav-codec-selftest — measure the built-in WAV path.
//
// This file exists because the whole audio pipeline used to depend on an
// `ffmpeg` binary being on PATH, and in a development checkout it usually is
// not. The symptom was not an error: the stem session baked zero previews,
// the transport started zero sources, and the play button did nothing while
// reporting success.
//
// So the tests below are not "does it parse" — they are "does the audio come
// out right", measured against the analytic signal that went in. The rate
// converter in particular is checked for the two things that actually go
// wrong: droop in the passband and aliases folded back into the band. Each
// has a control that fails, so a passing number means the measurement works.
//
// Run:  pnpm --filter @aimaster/desktop test:wav-codec

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseWavHeader, decodeWavToFloatStereo, decodeWavFile,
  encodeWavBuffer, encodeWavFile, resampleInterleaved,
} from '../src/main/offline/wav-codec.js';
import { decodeAudioBytes } from '../src/renderer/audio/wav-buffer.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-20));

function sine(frames: number, hz: number, sr: number, amp = 0.5): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * hz * i) / sr) * amp;
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

/** Level at one frequency, by direct correlation — a one-bin DFT. */
function magnitudeAt(x: Float32Array, channels: number, ch: number, hz: number, sr: number): number {
  const n = Math.floor(x.length / channels);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));   // Hann, to stop leakage
    const s = x[i * channels + ch]! * w;
    re += s * Math.cos((2 * Math.PI * hz * i) / sr);
    im -= s * Math.sin((2 * Math.PI * hz * i) / sr);
  }
  // Hann halves the coherent gain.
  return (2 * Math.sqrt(re * re + im * im)) / (n * 0.5);
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
}

console.log('\n=== HEADERS ===\n');
{
  const sig = sine(1000, 1000, 48000);
  for (const depth of [16, 24, 32] as const) {
    const buf = encodeWavBuffer(sig, 48000, depth, 2);
    const info = parseWavHeader(buf);
    check(
      `${depth}-bit header reads back`,
      info !== null && info.channels === 2 && info.sampleRate === 48000 && info.bitDepth === depth
        && info.float === (depth === 32) && info.dataLength === sig.length * (depth / 8),
      JSON.stringify(info),
    );
  }
  check(
    'a non-WAV buffer is declined, not guessed at',
    parseWavHeader(Buffer.from('ID3not a wav at all........')) === null,
    'null이면 호출자가 ffmpeg로 넘긴다',
  );
  check('a truncated file is declined', parseWavHeader(Buffer.alloc(20)) === null, 'null');
}

console.log('\n=== ROUND TRIP ===\n');
{
  // Not a sine: a signal that visits the whole range, including full scale,
  // so a clamping or sign-extension error cannot hide in the quiet part.
  const n = 4096;
  const sig = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    sig[i * 2] = Math.max(-1, Math.min(1, (i / n) * 2 - 1));
    sig[i * 2 + 1] = Math.sin(i * 0.31) * 0.999;
  }
  for (const [depth, step] of [[16, 1 / 32767], [24, 1 / 8388607]] as const) {
    const back = decodeWavToFloatStereo(encodeWavBuffer(sig, 48000, depth, 2), 48000)!;
    let worst = 0;
    for (let i = 0; i < sig.length; i++) worst = Math.max(worst, Math.abs(back[i]! - sig[i]!));
    check(
      `${depth}-bit survives a round trip`,
      back.length === sig.length && worst <= step * 1.5,
      `최대 오차 ${worst.toExponential(2)} (1 LSB = ${step.toExponential(2)})`,
    );
  }
  const f32 = decodeWavToFloatStereo(encodeWavBuffer(sig, 48000, 32, 2), 48000)!;
  let worstF = 0;
  for (let i = 0; i < sig.length; i++) worstF = Math.max(worstF, Math.abs(f32[i]! - sig[i]!));
  check('32-bit float is exact', worstF === 0, `최대 오차 ${worstF}`);
}

console.log('\n=== CHANNELS ===\n');
{
  const n = 500;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = Math.sin(i * 0.1) * 0.7;
  const out = decodeWavToFloatStereo(encodeWavBuffer(mono, 48000, 24, 1), 48000)!;
  let sameSides = true;
  let matches = true;
  for (let i = 0; i < n; i++) {
    if (out[i * 2] !== out[i * 2 + 1]) sameSides = false;
    if (Math.abs(out[i * 2]! - mono[i]!) > 2 / 8388607) matches = false;
  }
  check('a mono file plays centred', out.length === n * 2 && sameSides, `${out.length / 2} frames, L === R`);
  check('and carries the mono samples unchanged', matches, '한쪽 채널만 소리나는 경우가 없다');
}

console.log('\n=== RATE CONVERSION ===\n');
{
  // 44.1 to 48 kHz, the conversion a 44.1 kHz stem needs to join a 48 kHz
  // session.
  const src = sine(Math.round(44100 * 0.5), 1000, 44100, 0.5);
  const out = resampleInterleaved(src, 2, 44100, 48000);
  const expectFrames = Math.floor(((src.length / 2) * 48000) / 44100);
  check(
    '44.1 to 48 produces the right length',
    Math.abs(out.length / 2 - expectFrames) <= 1,
    `${out.length / 2} frames, expected ${expectFrames}`,
  );

  // Compare against the analytic 48 kHz sine, away from the edges where the
  // filter is still filling.
  const skip = 2000;
  let worst = 0;
  for (let i = skip; i < out.length / 2 - skip; i++) {
    const want = Math.sin((2 * Math.PI * 1000 * i) / 48000) * 0.5;
    worst = Math.max(worst, Math.abs(out[i * 2]! - want));
  }
  check(
    '1 kHz comes through as a 1 kHz sine',
    db(worst / 0.5) < -80,
    `최대 오차 ${db(worst / 0.5).toFixed(1)} dB 상대 — 한계 −80 dB`,
  );

  // High frequencies are where a cheap interpolator droops.
  const hi = resampleInterleaved(sine(Math.round(44100 * 0.5), 15000, 44100, 0.5), 2, 44100, 48000);
  const mag = magnitudeAt(hi.subarray(4000, hi.length - 4000), 2, 0, 15000, 48000);
  check(
    '15 kHz keeps its level',
    Math.abs(db(mag / 0.5)) < 0.5,
    `${db(mag / 0.5).toFixed(2)} dB — 한계 ±0.5 dB`,
  );

  // The control: linear interpolation, the obvious alternative, measured the
  // same way. If this also passed, the test above would prove nothing.
  {
    const s = sine(Math.round(44100 * 0.5), 15000, 44100, 0.5);
    const inFrames = s.length / 2;
    const outFrames = Math.floor((inFrames * 48000) / 44100);
    const lin = new Float32Array(outFrames * 2);
    for (let i = 0; i < outFrames; i++) {
      const p = (i * 44100) / 48000;
      const a = Math.floor(p);
      const f = p - a;
      for (let c = 0; c < 2; c++) {
        const x0 = s[a * 2 + c] ?? 0;
        const x1 = s[(a + 1) * 2 + c] ?? 0;
        lin[i * 2 + c] = x0 * (1 - f) + x1 * f;
      }
    }
    const lm = magnitudeAt(lin.subarray(4000, lin.length - 4000), 2, 0, 15000, 48000);
    check(
      'control — linear interpolation droops at 15 kHz',
      Math.abs(db(lm / 0.5)) > 0.5,
      `${db(lm / 0.5).toFixed(2)} dB — 이 값이 작으면 위 테스트는 아무것도 증명하지 못한다`,
    );
  }
}

console.log('\n=== ALIASING ===\n');
{
  // 30 kHz at 96 kHz is above the 24 kHz Nyquist of 48 kHz. Undersampled it
  // folds to 96 − 30 = 18 kHz, right in the middle of the top octave. It has
  // to be filtered away instead.
  const src = sine(Math.round(96000 * 0.5), 30000, 96000, 0.5);
  const out = resampleInterleaved(src, 2, 96000, 48000);
  const alias = magnitudeAt(out.subarray(6000, out.length - 6000), 2, 0, 18000, 48000);
  check(
    '96 to 48 rejects a tone above the new Nyquist',
    db(alias / 0.5) < -80,
    `18 kHz 성분 ${db(alias / 0.5).toFixed(1)} dB — 한계 −80 dB`,
  );

  // The control: dropping every other sample, which is what "resampling"
  // means if you do not filter first.
  {
    const inFrames = src.length / 2;
    const dec = new Float32Array(Math.floor(inFrames / 2) * 2);
    for (let i = 0; i < dec.length / 2; i++) {
      dec[i * 2] = src[i * 4]!;
      dec[i * 2 + 1] = src[i * 4 + 1]!;
    }
    const a = magnitudeAt(dec.subarray(6000, dec.length - 6000), 2, 0, 18000, 48000);
    check(
      'control — dropping samples folds it back at full level',
      db(a / 0.5) > -6,
      `18 kHz 성분 ${db(a / 0.5).toFixed(1)} dB — 필터가 실제로 일을 한다는 증거`,
    );
  }

  // Level is preserved through a rate change: a converter that quietly
  // rescaled would show up here and nowhere else.
  const tone = sine(Math.round(44100 * 0.5), 1000, 44100, 0.5);
  const up = resampleInterleaved(tone, 2, 44100, 48000);
  const before = rms(tone.subarray(4000, tone.length - 4000));
  const after = rms(up.subarray(4000, up.length - 4000));
  check('rate change keeps the level', Math.abs(db(after / before)) < 0.1, `${db(after / before).toFixed(3)} dB`);
}

console.log('\n=== FILES ===\n');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-codec-'));
  const p = path.join(dir, 'stem.wav');
  const sig = sine(48000, 440, 48000, 0.3);
  encodeWavFile(sig, 48000, 24, p, 2);
  const back = decodeWavFile(p, 48000);
  check('a written file reads back', back !== null && back.length === sig.length, `${back?.length ?? 0} samples`);

  const resampled = decodeWavFile(p, 44100)!;
  check(
    'and converts on read when the session runs at another rate',
    Math.abs(resampled.length / 2 - 44100) <= 2,
    `${resampled.length / 2} frames at 44.1 kHz`,
  );

  fs.writeFileSync(path.join(dir, 'not-audio.wav'), Buffer.from('this is not a wav file at all'));
  check(
    'a file that only looks like a WAV is declined',
    decodeWavFile(path.join(dir, 'not-audio.wav'), 48000) === null,
    'null이면 ffmpeg가 대신 시도한다',
  );
  check('a missing file is declined', decodeWavFile(path.join(dir, 'nope.wav'), 48000) === null, 'null');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== SPEED ===\n');
{
  // A twelve-stem session reads twelve of these. If it were slower than
  // spawning ffmpeg there would be no reason to prefer it.
  const frames = 48000 * 60;
  const sig = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin(i * 0.01) * 0.5;
    sig[i * 2] = v;
    sig[i * 2 + 1] = v;
  }
  const buf = encodeWavBuffer(sig, 48000, 24, 2);
  const t0 = Date.now();
  const back = decodeWavToFloatStereo(buf, 48000)!;
  const decodeMs = Date.now() - t0;
  check(
    'a minute of 24-bit stereo decodes quickly',
    back.length === sig.length && decodeMs < 3000,
    `${decodeMs} ms`,
  );

  const t1 = Date.now();
  resampleInterleaved(sig.subarray(0, 48000 * 10 * 2), 2, 44100, 48000);
  const resampleMs = Date.now() - t1;
  check('ten seconds converts in reasonable time', resampleMs < 15000, `${resampleMs} ms — 세션당 한 번, 캐시된다`);
}

async function decodeSafetyChecks(): Promise<void> {
  console.log('\n=== THE RENDERER NEVER HANDS A WAV TO THE MEDIA STACK ===\n');
  // The crash this whole file exists to close: `decodeAudioData` takes the
  // renderer down with exit code 11 in this Electron build — measured
  // against every WAV shape the app produces, 16/24/32-bit, mono and
  // stereo, 44.1 and 48 kHz. So a WAV must reach the parser and never that
  // call, and the way to know is to count.
  let decodeAudioDataCalls = 0;
  const ctx = {
    createBuffer(channels: number, frames: number, sampleRate: number) {
      const data: Float32Array[] = [];
      for (let c = 0; c < channels; c++) data.push(new Float32Array(frames));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        duration: frames / sampleRate,
        getChannelData: (c: number) => data[c]!,
      };
    },
    decodeAudioData(_bytes: ArrayBuffer) {
      decodeAudioDataCalls++;
      return Promise.reject(new Error('the media stack would have been used here'));
    },
  } as unknown as BaseAudioContext;

  const frames = 2400;
  const sig = sine(frames, 1000, 48000, 0.5);
  const wav = encodeWavBuffer(sig, 48000, 24, 2);
  const bytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const buffer = await decodeAudioBytes(ctx, bytes);
  check(
    'a WAV is decoded without decodeAudioData',
    decodeAudioDataCalls === 0,
    `decodeAudioData 호출 ${decodeAudioDataCalls}회 — 1회라도 있으면 렌더러가 죽는다 (종료코드 11)`,
  );
  check(
    'and the AudioBuffer carries the file, not the context, rate',
    buffer.numberOfChannels === 2 && buffer.length === frames && buffer.sampleRate === 48000,
    `${buffer.numberOfChannels}ch × ${buffer.length} @ ${buffer.sampleRate} Hz`,
  );
  let worst = 0;
  for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(buffer.getChannelData(0)[i]! - sig[i * 2]!));
  check('and the samples are the ones that went in', worst <= 1.5 / 8388607, `최대 오차 ${worst.toExponential(2)}`);

  // The control: something that is not a WAV still has to reach the media
  // stack, because nothing else here can read an mp3.
  let fellThrough = false;
  try {
    await decodeAudioBytes(ctx, new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).buffer);
  } catch {
    fellThrough = true;
  }
  check(
    'control — a non-WAV still goes to decodeAudioData',
    fellThrough && decodeAudioDataCalls === 1,
    `mp3는 여기서 읽을 수 없다 — 호출 ${decodeAudioDataCalls}회`,
  );
}

void decodeSafetyChecks().then(() => {
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
});
