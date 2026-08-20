/**
 * What plugins are installed, and where the app looked.
 *
 * Scanning touches the filesystem and shells out to `plutil` on macOS, so it
 * lives in main.  The result is cached: a scan walks several directories and
 * reads a file per bundle, and a user with three hundred plugins should not
 * pay for that every time they open a menu.
 */

import { app, type IpcMain } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { scanPlugins, type ScanResult } from '../plugins/scan.js';
import { newScratchFile, runHostJob, sweepHostScratch } from '../plugins/host.js';
import type { HostStage } from '../plugins/host-protocol.js';
import { log } from '../utils/logger.js';

let cached: ScanResult | null = null;

/** Run a system tool and return its stdout, or null if it is unavailable. */
function runTool(bin: string, args: string[]): string | null {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status !== 0 || result.error) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

interface HostApplyRequest {
  /** Interleaved float32 for the whole render. */
  pcm: Uint8Array;
  frames: number;
  channels: number;
  sampleRate: number;
  chain: HostStage[];
}

export function registerPluginHandlers(ipc: IpcMain): void {
  sweepHostScratch(true);
  app.on('will-quit', () => sweepHostScratch(true));

  /**
   * Run a rendered track through a chain of external plugins.
   *
   * Audio comes in as one buffer — a bounce is not realtime, and this is the
   * only crossing — and goes back out as a file, which is the fast direction
   * (see decodeHandlers for the measurement that settled that).
   */
  ipc.handle('daw:host-apply', async (_e, req: unknown) => {
    const request = req as Partial<HostApplyRequest> | undefined;
    const pcm = request?.pcm;
    const frames = Number(request?.frames);
    const channels = Number(request?.channels);
    const sampleRate = Number(request?.sampleRate);
    const chain = Array.isArray(request?.chain) ? request.chain : [];

    if (!(pcm instanceof Uint8Array) || !Number.isFinite(frames) || frames <= 0
      || !Number.isFinite(channels) || channels <= 0) {
      throw new Error('daw:host-apply: 오디오가 없습니다');
    }
    if (chain.length === 0) throw new Error('daw:host-apply: 적용할 장치가 없습니다');

    sweepHostScratch();
    const inputPath = newScratchFile('.in.f32');
    const outputPath = newScratchFile('.out.f32');
    await fs.promises.writeFile(inputPath, pcm);

    try {
      const result = await runHostJob({
        id: crypto.randomUUID(),
        inputPath, outputPath, frames, channels, sampleRate, chain,
      });
      const applied = result.stages.filter((s) => s.applied).length;
      log.info(`[host] ${applied}/${chain.length} stages applied`);
      return { ...result, outputPath: result.ok ? outputPath : null };
    } finally {
      // The input is dead the moment the job ends; the output is the
      // renderer's to read and is swept on a timer.
      await fs.promises.rm(inputPath, { force: true }).catch(() => { /* gone */ });
    }
  });
  ipc.handle('plugins:scan', (_e, force: unknown): ScanResult => {
    if (cached && force !== true) return cached;
    const started = Date.now();
    cached = scanPlugins({ home: app.getPath('home'), runTool });
    log.info(
      `[plugins] ${cached.plugins.length} found in ${Date.now() - started} ms`
      + ` (${cached.searched.length} folders, ${cached.skipped.length} skipped)`,
    );
    return cached;
  });
}
