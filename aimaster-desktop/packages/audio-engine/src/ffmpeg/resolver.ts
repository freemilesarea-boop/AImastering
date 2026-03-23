/**
 * FFmpeg / FFprobe binary path resolution.
 *
 * Resolution order (first candidate that is executable wins):
 *   1. Bundled binary inside Electron resourcesPath   (packaged mode)
 *   2. Environment variable override                  (AIMASTER_FFMPEG / AIMASTER_FFPROBE)
 *   3. Platform-specific well-known installation dirs (dev + system installs)
 *   4. Bare binary name fallback — resolved via PATH at spawn time
 *
 * Korean and space-containing paths are handled safely because consumers of
 * this module always pass the resolved path as a spawn() argument array entry,
 * never via shell string concatenation.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Public types ──────────────────────────────────────────────────────────────

/** Options accepted by resolveFFmpegPath() and resolveFFprobePath(). */
export interface ResolveBinOptions {
  /**
   * Set to true when running inside a packaged Electron app.
   * When true, resourcesPath is consulted first before system paths.
   */
  packaged?: boolean;

  /**
   * Absolute path to Electron's resourcesPath (process.resourcesPath).
   * Bundled binaries are expected at:
   *   <resourcesPath>/bin/ffmpeg[.exe]
   *   <resourcesPath>/bin/ffprobe[.exe]
   * Ignored when packaged is false.
   */
  resourcesPath?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32';
const WIN_EXT = IS_WIN ? '.exe' : '';

/** Check whether the given path points to an executable file. */
function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return platform-specific "well-known" directories where FFmpeg is
 * commonly installed (homebrew, system package managers, manual installs).
 */
function platformCandidateDirs(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',     // Apple Silicon homebrew
        '/usr/local/bin',        // Intel homebrew / manual
        '/usr/bin',
        path.join(os.homedir(), '.local/bin'),
      ];

    case 'win32':
      return [
        'C:\\Program Files\\ffmpeg\\bin',
        'C:\\Program Files (x86)\\ffmpeg\\bin',
        'C:\\ffmpeg\\bin',
        path.join(os.homedir(), 'scoop', 'shims'),   // Scoop package manager
        path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
      ];

    default:  // linux + others
      return [
        '/usr/bin',
        '/usr/local/bin',
        '/snap/bin',
        path.join(os.homedir(), '.local/bin'),
      ];
  }
}

/**
 * Locate a binary by checking candidate paths in order.
 * Returns the first executable path found, or undefined.
 */
function findBinary(name: string): string | undefined {
  for (const dir of platformCandidateDirs()) {
    const candidate = path.join(dir, name + WIN_EXT);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Core resolution logic shared by resolveFFmpegPath / resolveFFprobePath.
 *
 * @param name         Binary base name without extension ('ffmpeg' | 'ffprobe')
 * @param envVar       Name of the environment variable override
 * @param opts         Caller-supplied options
 */
function resolveBin(name: string, envVar: string, opts: ResolveBinOptions): string {
  const { packaged = false, resourcesPath } = opts;

  // ── 1. Bundled binary (packaged Electron app) ──────────────────────────
  if (packaged && resourcesPath) {
    const bundled = path.join(resourcesPath, 'bin', name + WIN_EXT);
    if (isExecutable(bundled)) return bundled;
  }

  // ── 2. Environment variable override ──────────────────────────────────
  const envVal = process.env[envVar];
  if (envVal) {
    if (isExecutable(envVal)) return envVal;
    // Env var is set but not executable — warn but continue
    console.warn(
      `[aimaster/audio-engine] ${envVar}="${envVal}" is not executable; falling back to system search.`
    );
  }

  // ── 3. Platform-specific well-known locations ─────────────────────────
  const found = findBinary(name);
  if (found) return found;

  // ── 4. Fallback: bare name (resolved via PATH at spawn() time) ─────────
  // This is last-resort so the app can still start and show a meaningful
  // "FFmpeg not found" error when the first actual call is attempted.
  return name + WIN_EXT;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the ffmpeg binary.
 *
 * @example
 * // Development
 * const ffmpeg = resolveFFmpegPath();
 *
 * // Packaged Electron app
 * const ffmpeg = resolveFFmpegPath({
 *   packaged: app.isPackaged,
 *   resourcesPath: process.resourcesPath,
 * });
 */
export function resolveFFmpegPath(opts: ResolveBinOptions = {}): string {
  return resolveBin('ffmpeg', 'AIMASTER_FFMPEG', opts);
}

/**
 * Resolve the absolute path to the ffprobe binary.
 *
 * @example
 * const ffprobe = resolveFFprobePath({
 *   packaged: app.isPackaged,
 *   resourcesPath: process.resourcesPath,
 * });
 */
export function resolveFFprobePath(opts: ResolveBinOptions = {}): string {
  return resolveBin('ffprobe', 'AIMASTER_FFPROBE', opts);
}

/**
 * Resolve both binaries at once.
 * Convenience wrapper for the common case of needing both paths together.
 */
export function resolveFFmpegBinaries(opts: ResolveBinOptions = {}): {
  ffmpeg: string;
  ffprobe: string;
} {
  return {
    ffmpeg: resolveFFmpegPath(opts),
    ffprobe: resolveFFprobePath(opts),
  };
}
