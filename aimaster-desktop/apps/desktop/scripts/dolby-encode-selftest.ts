// dolby-encode-selftest — verify Dolby codec export end-to-end with the BUNDLED
// ffmpeg.  Encodes a 5.1 WAV to AC-3 / E-AC-3 / TrueHD and probes the result's
// codec + channel count.  Headless, CI-runnable.
//
//   pnpm --filter @aimaster/desktop test:dolby-encode

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { ffmpegLayoutName, LAYOUT_CHANNELS } from '../src/main/offline/surround.js';
import { interleaveN } from '../src/main/offline/surround-render.js';
import { dolbyEncodeArgs, dolbyExt, type DolbyCodec } from '../src/main/offline/dolby.js';

const FFMPEG = (ffmpegStatic as unknown as string) || 'ffmpeg';
const FFPROBE = (ffprobeInstaller as { path: string }).path || 'ffprobe';
const SR = 48000;

function run(bin: string, args: string[], stdin?: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdin.on('error', () => {});
    child.on('error', () => resolve(1));
    child.on('close', (code) => { if (code !== 0) console.error('  ', Buffer.concat(err).toString().slice(-200)); resolve(code ?? 1); });
    if (stdin) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

function probeCodec(path: string): { codec: string; channels: number } {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  const [codec, channels] = r.stdout.trim().split(',');
  return { codec: (codec ?? '').trim(), channels: parseInt(channels ?? '0', 10) };
}

async function check(codec: DolbyCodec, expectCodec: string, dir: string): Promise<boolean> {
  const nc = LAYOUT_CHANNELS['5.1'].length;
  const chans = Array.from({ length: nc }, (_, c) => Float32Array.from({ length: SR }, (_, i) => 0.1 * Math.sin((2 * Math.PI * (200 + 80 * c) * i) / SR)));
  const wav = join(dir, '5.1.wav');
  const e1 = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(nc), '-i', 'pipe:0', '-ch_layout', ffmpegLayoutName('5.1'), '-c:a', 'pcm_s24le', wav], Buffer.from(interleaveN(chans).buffer));
  if (e1 !== 0) { console.error(`  ✗ ${codec}: wav encode failed`); return false; }
  const out = join(dir, `5.1${dolbyExt(codec)}`);
  const e2 = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, ...dolbyEncodeArgs(codec), out]);
  if (e2 !== 0) { console.error(`  ✗ ${codec}: dolby encode failed`); return false; }
  const p = probeCodec(out);
  const ok = p.codec === expectCodec && p.channels === nc;
  console.log(`  ${ok ? '✓' : '✗'} ${codec}: codec=${p.codec} channels=${p.channels} (expected ${expectCodec}/${nc})`);
  return ok;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dolby-enc-'));
  try {
    console.log('[dolby-encode-selftest] verifying Dolby codec export via bundled ffmpeg');
    const results = await Promise.all([
      check('ac3', 'ac3', dir),
      check('eac3', 'eac3', dir),
      check('truehd', 'truehd', dir),
    ]);
    if (results.every(Boolean)) console.log('PASS — Dolby AC-3 / E-AC-3 / TrueHD export works');
    else { console.error('FAIL — Dolby export mismatch'); process.exit(1); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
