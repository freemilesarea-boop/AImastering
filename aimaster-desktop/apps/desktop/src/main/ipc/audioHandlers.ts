import type { IpcMain, BrowserWindow } from 'electron';
import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';import {
  PythonBridge,
  analyzeFile,
  masterFile,
  runQC,
  AppError,
  classifyFFmpegError,
  outputDirNotWritable,
  pythonProcessFailed,
  unknownError,
  pathEncodingError,
} from '@aimaster/audio-engine';
import type {
  MasteringOptions,
  LoudnessStats,
  PreviewRenderRequest,
  PreviewRenderResponse,
} from '@aimaster/shared-types';
import { log } from '../utils/logger.js';
import { recordFailure } from '../utils/failureLog.js';
import { recordPipelineWarning } from '../utils/supportBundle.js';
import { validateAbsoluteFilePath } from '../utils/ipcValidation.js';
import { applyBundledFfmpegEnv } from '../utils/ffmpegEnv.js';

let bridge: PythonBridge | null = null;

/**
 * Forcefully terminate the Python engine subprocess if one is alive.
 * Called from main/index.ts on `before-quit` so the engine doesn't outlive
 * the app as a zombie process.  Awaits the actual SIGTERM exit (or
 * SIGKILL escalation after the bridge's internal timeout) so the parent
 * doesn't return from before-quit while the child is still draining.
 */
export async function killBridge(): Promise<void> {
  const b = bridge;
  if (!b) return;
  bridge = null;  // detach immediately so a re-entry spawns a fresh bridge
  try {
    await b.killAndWait();
  } catch (err) {
    log.warn('killBridge failed:', err);
  }
}

/**
 * Resolve the paths for the Python engine and FFmpeg binaries.
 *
 * DEV mode  : uses system python3 + source tree main.py
 * PACKAGED  : uses the PyInstaller-built standalone `engine` binary
 *             (no Python installation required on the user's machine)
 *
 * FFmpeg is always resolved to the bundled binary in packaged mode via
 * AIMASTER_FFMPEG / AIMASTER_FFPROBE env vars that ffmpeg_wrapper.py reads.
 */
function resolvePaths(): { pythonPath: string; scriptPath: string } {
  const isWin = process.platform === 'win32';
  const ext   = isWin ? '.exe' : '';

  if (app.isPackaged) {
    const binDir = path.join(process.resourcesPath, 'bin');

    // Point the Python engine (and every other ffmpeg consumer) to the
    // bundled FFmpeg.  Centralised + idempotent so resolution never depends
    // on which handler ran first — also called at app startup in index.ts.
    applyBundledFfmpegEnv(app.isPackaged, process.resourcesPath);

    return {
      pythonPath: path.join(binDir, `engine${ext}`),
      scriptPath: '',   // PyInstaller binary — no script arg needed
    };
  }

  // DEV: use system python + source tree
  const pythonPath = process.env['AIMASTER_PYTHON'] ?? 'python3';
  const scriptPath = path.join(__dirname, '../../../../services/python-audio/app/main.py');
  // PYTHONPATH must point to the directory containing the `app` package
  process.env['PYTHONPATH'] = path.dirname(path.dirname(scriptPath));

  return { pythonPath, scriptPath };
}

function getBridge(): PythonBridge {
  if (bridge) return bridge;
  const { pythonPath, scriptPath } = resolvePaths();
  bridge = new PythonBridge({ pythonPath, scriptPath });
  bridge.on('log', (line: string) => log.info('[python]', line));
  // Engine startup / mid-flight death is one of the highest-impact failure
  // categories — surface it in the support bundle so a user QA report
  // includes it without us needing to grep daily log files.
  bridge.on('error', (err: Error) => {
    recordFailure('engine', `Python bridge error: ${err.message}`, {
      pythonPath, scriptPath,
    });
  });
  bridge.on('exit', (code: number | null, signal: string | null) => {
    if (code !== 0 && code !== null) {
      recordFailure('engine', `Python bridge exited with code=${code}`, {
        pythonPath, scriptPath, signal,
      });
    } else if (signal) {
      recordFailure('engine', `Python bridge killed by signal=${signal}`, {
        pythonPath, scriptPath,
      });
    }
  });
  try {
    bridge.spawn();
  } catch (err) {
    recordFailure('engine', 'Python bridge spawn() failed', {
      pythonPath, error: (err as Error).message,
    });
    throw err;
  }
  return bridge;
}

// Windows reserved device names — illegal as a base filename even WITH an
// extension (e.g. `CON.wav` cannot be created on Windows).  Matched
// case-insensitively against the stem.
const WIN_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Remove characters that are illegal in filenames on Windows or Unix.
 * Spaces are replaced with underscores; the result is trimmed.  A stem that
 * collides with a Windows reserved device name (CON, NUL, COM1…) is prefixed
 * with `_` so the file can be created on every platform.  Falls back to
 * 'untitled' if the result is empty.
 */
function sanitizeFilename(name: string): string {
  const cleaned = (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')  // illegal on Windows/Unix
      .replace(/\s+/g, '_')                     // spaces → underscores
      .replace(/\.+$/, '')                      // trailing dots (Windows disallows)
      .trim()
  ) || 'untitled';
  return WIN_RESERVED.has(cleaned.toLowerCase()) ? `_${cleaned}` : cleaned;
}

/**
 * Build `{tmpDir}/{sanitized_basename}_master.ext`, incrementing a numeric
 * suffix when the path already exists:
 *   song_master.wav → song_master(1).wav → song_master(2).wav …
 *
 * UUID is never exposed in the output filename; it is used only as an
 * emergency fallback if all 999 numeric slots are somehow taken.
 */
function resolveOutputPath(
  inputFilePath: string,
  ext: string,
  meta?: { style?: string; targetLufs?: number },
): string {
  const tmpDir  = os.tmpdir();
  const rawBase = path.basename(inputFilePath, path.extname(inputFilePath));
  const safe    = sanitizeFilename(rawBase);

  // v3 — 모드 + LUFS 를 파일명에 포함 (예: song_master_kpop_loud_-9LUFS.wav)
  const styleStr = meta?.style ? `_${meta.style}` : '';
  const lufsStr  = typeof meta?.targetLufs === 'number'
    ? `_${Math.round(meta.targetLufs)}LUFS`
    : '';
  const stem    = `${safe}_master${styleStr}${lufsStr}`;

  const primary = path.join(tmpDir, `${stem}${ext}`);
  if (!fs.existsSync(primary)) return primary;

  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(tmpDir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  // Emergency fallback — should never be reached in normal usage
  return path.join(tmpDir, `${stem}_${uuidv4().slice(0, 8)}${ext}`);
}

/** UUID-based temp path — for internal / ephemeral files only (not user-visible). */
function internalTempPath(suffix: string): string {
  return path.join(os.tmpdir(), `aimaster_${uuidv4()}${suffix}`);
}

/**
 * Check that the OS temp directory is writable.
 * Throws AppError(OUTPUT_DIR_NOT_WRITABLE) if not.
 */
function assertTmpWritable(): void {
  const dir = os.tmpdir();
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw outputDirNotWritable(dir);
  }
}

/**
 * Convert any thrown value into an AppError, then re-throw as a plain Error
 * whose message is JSON-encoded AppError fields.
 *
 * Electron IPC (structured-clone) only preserves standard Error.message/name.
 * Encoding the full AppError in message lets the renderer decode it faithfully.
 */
function toAppError(err: unknown, filePath = ''): never {
  let appErr: AppError;

  if (err instanceof AppError) {
    appErr = err;
  } else {
    const msg = (err as Error).message ?? String(err);

    // Spawn failure: binary not found
    if (/ENOENT|spawn/i.test(msg)) {
      appErr = pythonProcessFailed(
        `Engine binary not found or failed to start: ${msg}`,
        false,
      );
    }
    // Python / JSON-RPC bridge errors
    else {
      const anyErr = err as Record<string, unknown>;
      if (typeof anyErr['code'] === 'number') {
        const rpcCode = anyErr['code'] as number;
        appErr = pythonProcessFailed(`JSON-RPC code=${rpcCode}: ${msg}`, rpcCode === -32000);
      }
      // Path encoding
      else if (/EINVAL|ENAMETOOLONG/i.test(msg) && filePath) {
        appErr = pathEncodingError(filePath, msg);
      }
      // FFmpeg classification
      else {
        try {
          throw classifyFFmpegError(err, false, filePath);
        } catch (classified) {
          if (classified instanceof AppError) {
            appErr = classified;
          } else {
            appErr = unknownError(msg);
          }
        }
      }
    }
  }

  // Encode all AppError fields in Error.message so Electron IPC preserves them
  const serialized = new Error(
    JSON.stringify({
      __appError: true,
      code:        appErr.code,
      userMessage: appErr.userMessage,
      devDetail:   appErr.devDetail,
      recoverable: appErr.recoverable,
    }),
  );
  serialized.name = 'AppError';
  throw serialized;
}

export function registerAudioHandlers(ipc: IpcMain, win: BrowserWindow | null): void {
  // Renderer-initiated cancel: tear down the Python engine so any in-flight
  // analyze / master / qc work stops immediately.  The next IPC call will
  // respawn a fresh bridge.  Used when the user navigates away from the
  // mastering page mid-IPC, when the renderer's hard timeout fires, etc.
  ipc.handle('audio:cancel', async (_e, reason: unknown) => {
    const reasonStr = typeof reason === 'string' ? reason : 'unknown';
    log.info('[audio:cancel] killing bridge', { reason: reasonStr });
    await killBridge();
  });

  ipc.handle('audio:analyze', async (_e, filePath: unknown) => {
    const safePath = validateAbsoluteFilePath(filePath, 'audio:analyze');
    try {
      const b = getBridge();
      return await analyzeFile(b, safePath);
    } catch (err) {
      log.error('[audio:analyze] error', { filePath: safePath, err: (err as Error).message });
      recordFailure('engine', `analyzeFile failed: ${(err as Error).message}`, { filePath: safePath });
      toAppError(err, safePath);
    }
  });

  ipc.handle('audio:master', async (
    _e,
    filePath: unknown,
    _outputPath: string,   // ignored — we always generate temp paths here
    options: MasteringOptions,
    extras?: { preLoudness?: LoudnessStats },
  ) => {
    const safePath = validateAbsoluteFilePath(filePath, 'audio:master');
    // ── Write-permission pre-check ────────────────────────────────────────
    assertTmpWritable();

    const b = getBridge();

    // Named progress handler — removed in `finally` so it doesn't leak
    // between calls.  removeAllListeners() would have wiped any other
    // subscribers attached elsewhere on the bridge; this is scoped to
    // exactly the listener we created.
    const progressHandler = (msg: unknown): void => {
      win?.webContents.send('audio:progress', msg);
    };
    b.on('progress', progressHandler);

    // Handle bridge death mid-processing (case 8)
    let bridgeDied = false;
    const bridgeExitHandler = (): void => { bridgeDied = true; };
    b.once('exit', bridgeExitHandler);

    // ── Output path: original-filename-based, not UUID ────────────────────
    // Python derives the preview MP3 path as: outputPath_without_ext + "_preview.mp3"
    // so naming the WAV correctly automatically names the preview correctly too.
    const wavTempPath = resolveOutputPath(safePath, '.wav', {
      style:      options?.style,
      targetLufs: options?.targetLufs,
    });
    // Fallback MP3 path — used only if Python fails to generate the preview
    const mp3FallbackPath = internalTempPath('_preview.mp3');

    try {
      const result = await masterFile(b, safePath, wavTempPath, options, {
        preLoudness: extras?.preLoudness,
      });

      if (bridgeDied) {
        throw pythonProcessFailed('Bridge process exited during masterFile()', true);
      }

      // Mirror any pipeline warnings into the support bundle ring so the
      // user can include them in a diagnostic report later.
      if (Array.isArray(result?.pipelineWarnings)) {
        for (const w of result.pipelineWarnings) recordPipelineWarning(w);
      }

      return {
        ...result,
        outputPath:  result.outputPath,
        previewPath: result.previewPath || mp3FallbackPath,
      };
    } catch (err) {
      // Clean up temp WAV on any error to avoid leaking disk space
      try { fs.unlinkSync(wavTempPath); } catch { /* already gone */ }

      log.error('[audio:master] error', {
        filePath: safePath,
        err: (err as Error).message,
        bridgeDied,
      });
      recordFailure('pipeline', `masterFile failed: ${(err as Error).message}`, {
        filePath: safePath, bridgeDied,
      });

      // If bridge died, reset so next call spawns a fresh process
      if (bridgeDied) {
        bridge = null;
        throw pythonProcessFailed('Bridge process exited unexpectedly', true);
      }

      toAppError(err, safePath);
    } finally {
      b.removeListener('exit', bridgeExitHandler);
      b.removeListener('progress', progressHandler);
    }
  });

  // ── Rust offline render (experimental, RUST-OFFLINE-RENDER-1) ───────────
  // Additive path: render the file through the SAME Rust MasteringChain as
  // the realtime preview.  On ANY failure it falls back to the Python
  // `masterFile` so the user always gets an output.  `audio:master` is
  // unchanged.
  ipc.handle('audio:master-rust-experimental', async (
    _e,
    req: {
      sourcePath: string;
      chainConfig: import('../offline/load-mastering-chain-node.js').OfflineChainConfig;
      options: MasteringOptions;
      requestId?: string;
    },
  ) => {
    assertTmpWritable();
    const { sourcePath, chainConfig, options, requestId } = req;
    const safeSourcePath = validateAbsoluteFilePath(sourcePath, 'audio:master-rust-experimental');
    const wavTempPath = resolveOutputPath(safeSourcePath, '.wav', {
      style: options?.style, targetLufs: options?.targetLufs,
    });
    const mp3Path = internalTempPath('_preview.mp3');
    const t0 = Date.now();

    // Try the Rust backend first.
    try {
      const { processAudioFileRust, encodePreviewMp3, isRustOfflineAvailable } =
        await import('../offline/process-audio-file-rust.js');
      if (!isRustOfflineAvailable()) throw new Error('rust offline backend unavailable');
      const sr = (options?.sampleRate as number) || 48000;
      const bd = (options?.bitDepth === 16 ? 16 : 24) as 16 | 24;
      const rendered = await processAudioFileRust(safeSourcePath, chainConfig, {
        sampleRate: sr, bitDepth: bd, outputPath: wavTempPath,
        // Two-pass loudness-normalize toward the same target the UI requests.
        ...(typeof options?.targetLufs === 'number' ? { targetLufs: options.targetLufs } : {}),
        ...(typeof options?.targetTp === 'number' ? { targetTp: options.targetTp } : {}),
      });
      await encodePreviewMp3(wavTempPath, mp3Path);
      return {
        requestId, ok: true, backend: 'rust' as const, fallbackUsed: false,
        loudnessNormalized: rendered.loudnessNormalized,
        outputPath: rendered.outputPath, previewPath: mp3Path,
        metrics: rendered.metrics, renderMs: Date.now() - t0,
      };
    } catch (rustErr) {
      log.warn('[audio:master-rust-experimental] rust render failed, falling back to Python', {
        err: (rustErr as Error).message,
      });
      recordPipelineWarning({ code: 'rust_offline_fallback', level: 'warning', userMessage: `rust offline render fell back to Python: ${(rustErr as Error).message}` });
      // Fallback: the proven Python path.
      try {
        const b = getBridge();
        const result = await masterFile(b, safeSourcePath, wavTempPath, options, {});
        return {
          requestId, ok: true, backend: 'python' as const, fallbackUsed: true,
          outputPath: result.outputPath, previewPath: result.previewPath || mp3Path,
          metrics: result.loudnessAfter, renderMs: Date.now() - t0,
        };
      } catch (pyErr) {
        return {
          requestId, ok: false, backend: 'python' as const, fallbackUsed: true,
          error: (pyErr as Error).message, renderMs: Date.now() - t0,
        };
      }
    }
  });

  // ── Song profile (adaptive defaults) ───────────────────────────────────
  // Measures the source so the recommended settings can be about THIS song
  // rather than about songs in general.  Notably the hiss gate's threshold,
  // which is a per-bin dBFS level nothing in a static table could know.
  ipc.handle('audio:song-profile', async (_e, filePath: unknown) => {
    const safePath = validateAbsoluteFilePath(filePath, 'audio:song-profile');
    try {
      const { profileSong } = await import('../offline/song-profile.js');
      const profile = await profileSong(safePath);
      return { ok: true as const, profile };
    } catch (err) {
      // Returned rather than thrown: failing to analyse is an ordinary
      // outcome (an odd codec, a very short file) and the Studio should
      // fall back to the common defaults, not show a stack trace.
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // ── Reference curve (Match EQ) ─────────────────────────────────────────
  // Match EQ needs a target curve and there was no way to produce one, so
  // the module could not be switched on at all.  This measures a reference
  // track on the engine's own 32-band grid.
  ipc.handle('audio:reference-curve', async (_e, filePath: unknown) => {
    const safePath = validateAbsoluteFilePath(filePath, 'audio:reference-curve');
    try {
      const { measureReferenceCurve } = await import('../offline/reference-curve.js');
      const r = await measureReferenceCurve(safePath);
      return { ok: true as const, ...r };
    } catch (err) {
      // Returned rather than thrown: a reference that cannot be read is an
      // ordinary thing (a corrupt file, an unsupported codec) and the panel
      // needs to say so, not surface a stack trace.
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // ── Stem session ───────────────────────────────────────────────────────
  // The stem session loads a mix as its parts and gives each part a chain
  // built for that instrument. Two calls: work out what a stem IS, and
  // render the whole session down to one file.

  /**
   * Measure a stem and say what instrument it is.
   *
   * The profile is returned alongside the verdict because the Studio needs
   * it anyway (it drives the adaptive defaults), and profiling is the
   * expensive part — doing it twice for the same file would double the
   * import time of a twenty-stem session.
   */
  ipc.handle('stem:analyze', async (_e, filePath: unknown) => {
    const safePath = validateAbsoluteFilePath(filePath, 'stem:analyze');
    try {
      const [{ profileSong }, { classifyStem }] = await Promise.all([
        import('../offline/song-profile.js'),
        import('../offline/stem-role.js'),
      ]);
      const profile = await profileSong(safePath);
      const verdict = classifyStem(safePath, profile);
      return { ok: true as const, ...verdict, profile };
    } catch (err) {
      // Returned, not thrown: one unreadable stem must not take down the
      // import of the other nineteen. The caller files it as unclassified.
      return { ok: false as const, error: (err as Error).message };
    }
  });

  /**
   * Render a stem session: every stem through its own chain, summed
   * through the mixer, then the master bus.
   *
   * Every stem path is validated individually. The renderer sends a list
   * that a user assembled, and a list is exactly the shape where one bad
   * entry slips past a check written for a single path.
   */
  ipc.handle('stem:render', async (_e, req: {
    tracks: Array<{
      filePath: unknown; gainDb?: number; pan?: number;
      mute?: boolean; solo?: boolean;
      config?: import('../offline/load-mastering-chain-node.js').OfflineChainConfig | null;
    }>;
    master?: import('../offline/load-mastering-chain-node.js').OfflineChainConfig | null;
    sampleRate?: number;
    bitDepth?: 16 | 24;
    requestId?: string;
  }) => {
    assertTmpWritable();
    const t0 = Date.now();
    try {
      if (!Array.isArray(req?.tracks) || req.tracks.length === 0) {
        throw new Error('스템이 없습니다.');
      }
      const tracks = req.tracks.map((t, i) => ({
        filePath: validateAbsoluteFilePath(t.filePath, `stem:render[${i}]`),
        gainDb: typeof t.gainDb === 'number' ? t.gainDb : 0,
        pan: typeof t.pan === 'number' ? t.pan : 0,
        mute: t.mute === true,
        solo: t.solo === true,
        config: t.config ?? null,
      }));

      const sampleRate = req.sampleRate === 44100 ? 44100 : 48000;
      const bitDepth = req.bitDepth === 16 ? 16 : 24;

      const [{ renderStemSession }, { encodeWav }] = await Promise.all([
        import('../offline/stem-render.js'),
        import('../offline/process-audio-file-rust.js'),
      ]);

      const result = await renderStemSession(tracks, {
        sampleRate,
        master: req.master ?? null,
      });

      // Interleave for the encoder.
      const n = result.left.length;
      const interleaved = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        interleaved[i * 2] = result.left[i]!;
        interleaved[i * 2 + 1] = result.right[i]!;
      }

      const outputPath = internalTempPath('_stem_mix.wav');
      await encodeWav(interleaved, sampleRate, bitDepth, outputPath);

      return {
        requestId: req.requestId, ok: true as const,
        outputPath, report: result.report, renderMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        requestId: req.requestId, ok: false as const,
        error: (err as Error).message, renderMs: Date.now() - t0,
      };
    }
  });

  ipc.handle('audio:qc', async (_e, filePath: unknown, targetLufs: number, targetTp: number) => {
    const safePath = validateAbsoluteFilePath(filePath, 'audio:qc');
    try {
      const b = getBridge();
      return await runQC(b, safePath, targetLufs, targetTp);
    } catch (err) {
      log.error('[audio:qc] error', { filePath: safePath, err: (err as Error).message });
      recordFailure('engine', `runQC failed: ${(err as Error).message}`, { filePath: safePath });
      toAppError(err, safePath);
    }
  });

  // ── Preview re-render (M3-P-NEXT-5C) ────────────────────────────────────
  // Re-runs the EXISTING Python master path with overridden options and
  // returns a fresh preview MP3.  No pipeline change — this is a thin
  // wrapper around `masterFile`, the same function `audio:master` calls.
  //
  // Returns a typed PreviewRenderResponse (ok/error) rather than throwing,
  // so the renderer's latest-wins controller can handle stale / failed
  // responses uniformly.
  ipc.handle('audio:re-render-preview', async (
    _e,
    request: PreviewRenderRequest,
  ): Promise<PreviewRenderResponse> => {
    const { requestId, sourceAudioPath, options, appliedOverrideKeys, patchHash } = request ?? {};
    if (!sourceAudioPath || !options) {
      return { requestId: requestId ?? 0, ok: false, error: 'invalid request payload' };
    }
    let safeSourcePath: string;
    try {
      safeSourcePath = validateAbsoluteFilePath(sourceAudioPath, 'audio:re-render-preview');
    } catch (err) {
      return { requestId: requestId ?? 0, ok: false, error: (err as Error).message };
    }
    const t0 = Date.now();
    try {
      assertTmpWritable();
      const b = getBridge();

      const wavTempPath = resolveOutputPath(safeSourcePath, '.wav', {
        style:      options.style,
        targetLufs: options.targetLufs,
      });
      const mp3FallbackPath = internalTempPath('_preview.mp3');

      const result = await masterFile(b, safeSourcePath, wavTempPath, options, {});
      const durationMs = Date.now() - t0;

      const after = (result as { loudnessAfter?: { integratedLufs?: number; truePeakDbtp?: number } })?.loudnessAfter;
      return {
        requestId,
        ok: true,
        previewPath: result.previewPath || mp3FallbackPath,
        ...(after ? {
          metrics: {
            ...(typeof after.integratedLufs === 'number' ? { integratedLufs: after.integratedLufs } : {}),
            ...(typeof after.truePeakDbtp === 'number' ? { truePeakDbtp: after.truePeakDbtp } : {}),
          },
        } : {}),
        durationMs,
        ...(appliedOverrideKeys ? { appliedOverrideKeys } : {}),
        ...(patchHash ? { patchHash } : {}),
      };
    } catch (err) {
      const msg = (err as Error).message;
      log.error('[audio:re-render-preview] error', { sourceAudioPath: safeSourcePath, err: msg });
      recordFailure('pipeline', `re-render-preview failed: ${msg}`, { sourceAudioPath: safeSourcePath });
      return { requestId: requestId ?? 0, ok: false, error: msg };
    }
  });
}
