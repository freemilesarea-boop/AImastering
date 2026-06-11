// surround-encode-selftest — verify the multichannel WAV encode end-to-end with
// the BUNDLED ffmpeg.  Moves the OBJECTIVE parts of "player playback" from
// device-only QA to a headless, CI-runnable check:
//   1) channel mask — WAVE_FORMAT_EXTENSIBLE + dwChannelMask (5.1→0x3f, 7.1→0x63f)
//   2) channel integrity — a per-channel constant survives an encode→decode
//      round-trip in the right channel + level (catches swaps / drops / level
//      errors without listening).
// The subjective part (does it SOUND right) remains human QA.
//
//   pnpm --filter @aimaster/desktop test:surround-encode

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { writeFileSync } from 'node:fs';
import { ffmpegLayoutName, deinterleaveN, LAYOUT_CHANNELS, type SurroundLayout } from '../src/main/offline/surround.js';
import { interleaveN } from '../src/main/offline/surround-render.js';
import { wrapAdmBwf, buildAdmXml, validateAdm } from '../src/main/offline/adm.js';

const FFMPEG = (ffmpegStatic as unknown as string) || 'ffmpeg';
const SR = 48000;

// WAVE_FORMAT_EXTENSIBLE channel masks (dwChannelMask) we expect ffmpeg to write.
//   FL=1 FR=2 FC=4 LFE=8 BL=16 BR=32 SL=512 SR=1024
const EXPECTED_MASK: Record<string, number> = { '5.1': 0x3f, '7.1': 0x3f | 0x200 | 0x400 };
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Parse channels + format tag + channel mask from a WAV's fmt chunk. */
function readWavFmt(path: string): { formatTag: number; channels: number; mask: number } {
  const b = readFileSync(path);
  // Standard layout for ffmpeg PCM WAV: 'fmt ' chunk at byte 12.
  const formatTag = b.readUInt16LE(20);
  const channels = b.readUInt16LE(22);
  // EXTENSIBLE: dwChannelMask sits at offset 40 (after the 22-byte ext block start).
  const mask = formatTag === WAVE_FORMAT_EXTENSIBLE ? b.readUInt32LE(40) : 0;
  return { formatTag, channels, mask };
}

function runFfmpeg(args: string[], stdin: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { shell: false });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdin.on('error', () => { /* ignore EPIPE */ });
    child.on('error', (e) => { console.error('  spawn error:', e.message); resolve(1); });
    child.on('close', (code) => {
      if (code !== 0) console.error('  ffmpeg stderr:', Buffer.concat(err).toString().slice(-300));
      resolve(code ?? 1);
    });
    child.stdin.write(stdin); child.stdin.end();
  });
}

async function checkLayout(layout: SurroundLayout, dir: string): Promise<boolean> {
  const nc = LAYOUT_CHANNELS[layout].length;
  const frames = Math.round(0.1 * SR);
  const chans = Array.from({ length: nc }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => 0.2 * Math.sin((2 * Math.PI * (200 + 100 * c) * i) / SR)),
  );
  const interleaved = interleaveN(chans);
  const out = join(dir, `${layout}.wav`);
  // Mirrors encodeWavN: -ch_layout as an output option.
  const code = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(SR), '-ac', String(nc), '-i', 'pipe:0',
    '-ch_layout', ffmpegLayoutName(layout), '-c:a', 'pcm_s24le', out,
  ], Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength));
  if (code !== 0) { console.error(`  ✗ ${layout}: ffmpeg encode failed (${code})`); return false; }
  const fmt = readWavFmt(out);
  const okExt = fmt.formatTag === WAVE_FORMAT_EXTENSIBLE;
  const okChannels = fmt.channels === nc;
  const okMask = fmt.mask === EXPECTED_MASK[layout];
  const ok = okExt && okChannels && okMask;
  console.log(`  ${ok ? '✓' : '✗'} ${layout}: channels=${fmt.channels} mask=0x${fmt.mask.toString(16)} (expected 0x${EXPECTED_MASK[layout]!.toString(16)}) extensible=${okExt}`);
  return ok;
}

/** Run ffmpeg, capturing stdout (for decode-back). */
function runFfmpegCapture(args: string[], stdin?: Buffer): Promise<{ code: number; out: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { shell: false });
    const out: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.resume();
    child.stdin.on('error', () => { /* ignore EPIPE */ });
    child.on('error', () => resolve({ code: 1, out: Buffer.alloc(0) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out: Buffer.concat(out) }));
    if (stdin) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

/** Encode a per-channel constant, decode it back, assert order + level survive. */
async function roundTrip(layout: SurroundLayout, dir: string): Promise<boolean> {
  const nc = LAYOUT_CHANNELS[layout].length;
  const frames = 2048;
  const expected = (c: number) => (c + 1) * 0.05; // distinct constant per channel
  const chans = Array.from({ length: nc }, (_, c) => new Float32Array(frames).fill(expected(c)));
  const wav = join(dir, `rt-${layout}.wav`);
  const enc = await runFfmpegCapture([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(SR), '-ac', String(nc), '-i', 'pipe:0',
    '-ch_layout', ffmpegLayoutName(layout), '-c:a', 'pcm_s24le', wav,
  ], Buffer.from(interleaveN(chans).buffer));
  if (enc.code !== 0) { console.error(`  ✗ ${layout} round-trip: encode failed`); return false; }
  // Decode back to f32le with the same channel count.
  const dec = await runFfmpegCapture([
    '-hide_banner', '-loglevel', 'error',
    '-i', wav, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(nc), '-ar', String(SR), 'pipe:1',
  ]);
  if (dec.code !== 0) { console.error(`  ✗ ${layout} round-trip: decode failed`); return false; }
  const usable = dec.out.byteLength - (dec.out.byteLength % 4);
  const back = deinterleaveN(new Float32Array(dec.out.buffer, dec.out.byteOffset, usable / 4), nc);
  let ok = true;
  for (let c = 0; c < nc; c++) {
    const mid = back[c]![Math.floor(frames / 2)] ?? NaN; // avoid edge ramps
    if (Math.abs(mid - expected(c)) > 1e-3) {
      console.error(`  ✗ ${layout} ch${c}: got ${mid.toFixed(4)} expected ${expected(c).toFixed(4)} (swap/drop/level)`);
      ok = false;
    }
  }
  console.log(`  ${ok ? '✓' : '✗'} ${layout} round-trip: ${nc} channels preserved in order + level`);
  return ok;
}

/** Wrap a real WAV as ADM BWF, confirm ffmpeg still reads it + the ADM validates. */
async function admBwf(layout: SurroundLayout, dir: string): Promise<boolean> {
  const adm = validateAdm(buildAdmXml(layout));
  if (!adm.ok) { console.error(`  ✗ ${layout} ADM: ${adm.errors.join('; ')}`); return false; }
  const nc = LAYOUT_CHANNELS[layout].length;
  const chans = Array.from({ length: nc }, () => new Float32Array(4096).fill(0.1));
  const wav = join(dir, `bwf-src-${layout}.wav`);
  const enc = await runFfmpegCapture(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(nc), '-i', 'pipe:0', '-ch_layout', ffmpegLayoutName(layout), '-c:a', 'pcm_s24le', wav], Buffer.from(interleaveN(chans).buffer));
  if (enc.code !== 0) return false;
  const bwf = join(dir, `bwf-${layout}.wav`);
  writeFileSync(bwf, wrapAdmBwf(readFileSync(wav), layout));
  // ffmpeg must still read the ADM BWF (extra chunks didn't corrupt the WAV).
  const dec = await runFfmpegCapture(['-hide_banner', '-loglevel', 'error', '-i', bwf, '-f', 'f32le', '-ac', String(nc), '-ar', String(SR), 'pipe:1']);
  const frames = (dec.out.byteLength / 4) / nc;
  const ok = dec.code === 0 && frames > 1000;
  console.log(`  ${ok ? '✓' : '✗'} ${layout} ADM BWF: validates + ffmpeg reads it back (${Math.round(frames)} frames)`);
  return ok;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'surround-enc-'));
  try {
    console.log('[surround-encode-selftest] WAV mask + channel-integrity + ADM BWF via bundled ffmpeg');
    const layouts: SurroundLayout[] = ['5.1', '7.1'];
    const mask = await Promise.all(layouts.map((l) => checkLayout(l, dir)));
    const rt = await Promise.all(layouts.map((l) => roundTrip(l, dir)));
    const adm = await Promise.all(layouts.map((l) => admBwf(l, dir)));
    if ([...mask, ...rt, ...adm].every(Boolean)) { console.log('PASS — channel mask + integrity + ADM BWF correct'); }
    else { console.error('FAIL — surround encode/round-trip mismatch'); process.exit(1); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
