// surround-encode-selftest — verify the multichannel WAV encode end-to-end with
// the BUNDLED ffmpeg.  Moves "WAV channel mask / channel count" from device-only
// QA to a headless, CI-runnable check.
//
//   pnpm --filter @aimaster/desktop test:surround-encode
//
// Builds a 5.1 + 7.1 interleaved f32le buffer (a distinct tone per channel),
// encodes a WAV with the pinned -ch_layout (as encodeWavN does), then parses the
// WAV fmt chunk and asserts WAVE_FORMAT_EXTENSIBLE + channel count + dwChannelMask
// (5.1 → 0x3f, 7.1 → 0x63f).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { ffmpegLayoutName, LAYOUT_CHANNELS, type SurroundLayout } from '../src/main/offline/surround.js';

const FFMPEG = (ffmpegStatic as unknown as string) || 'ffmpeg';
import { interleaveN } from '../src/main/offline/surround-render.js';

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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'surround-enc-'));
  try {
    console.log('[surround-encode-selftest] verifying multichannel WAV mask via bundled ffmpeg/ffprobe');
    const results = await Promise.all((['5.1', '7.1'] as SurroundLayout[]).map((l) => checkLayout(l, dir)));
    if (results.every(Boolean)) { console.log('PASS — multichannel WAV channel mask correct'); }
    else { console.error('FAIL — channel mask mismatch'); process.exit(1); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
