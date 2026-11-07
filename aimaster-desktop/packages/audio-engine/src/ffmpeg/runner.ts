/**
 * FFmpeg / FFprobe subprocess runner.
 *
 * Design principles:
 *   - All commands use spawn() with an argument *array* — never shell-string
 *     concatenation.  This makes spaces and Korean characters in file paths
 *     safe without any manual escaping.
 *   - stdout and stderr are always collected as UTF-8 strings so callers can
 *     parse JSON or inspect error output.
 *   - Configurable timeouts; killing the child process on timeout.
 *   - Custom error types carry the raw stderr so diagnostics are possible
 *     without hunting through logs.
 *
 * Public surface:
 *   runFFprobe(filePath, opts?)
 *   measureLoudnessPass1(filePath, opts?)
 *   normalizeLoudnessPass2(filePath, measuredValues, outputPath, opts?)
 *   encodePreviewMp3(filePath, outputPath, opts?)
 */

import { spawn } from 'node:child_process';
import { resolveFFmpegPath, resolveFFprobePath, type ResolveBinOptions } from './resolver.js';
import {
  AppError,
  ffmpegNotFound,
  ffprobeNotFound,
  fileCorrupted,
  formatUnsupported,
  loudnormParseFailed,
  unknownError,
  outputDirNotWritable,
} from '../errors.js';

// ── Error types ───────────────────────────────────────────────────────────────

/** Thrown when a spawned ffmpeg/ffprobe process exits with a non-zero code. */
export class FFmpegSpawnError extends Error {
  constructor(
    public readonly bin: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = 'FFmpegSpawnError';
  }
}

/**
 * Thrown when the JSON payload embedded in ffmpeg/ffprobe output cannot be
 * located or cannot be parsed.
 */
export class FFmpegParseError extends Error {
  constructor(
    public readonly raw: string,
    message: string,
  ) {
    super(message);
    this.name = 'FFmpegParseError';
  }
}

// ── Core types ────────────────────────────────────────────────────────────────

/** Collected output from a subprocess. */
interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** loudnorm pass-1 measurement values returned by measureLoudnessPass1(). */
export interface LoudnormMeasurements {
  input_i: string;       // integrated loudness (LUFS)
  input_lra: string;     // loudness range (LU)
  input_tp: string;      // true peak (dBTP)
  input_thresh: string;  // loudness threshold (LUFS)
  target_offset: string; // offset to apply (LU)
  /** Other fields returned by loudnorm (normalization_type, output_* etc.) */
  [key: string]: string;
}

/** Options accepted by all public runner functions. */
export interface RunnerOptions extends ResolveBinOptions {
  /** Timeout in milliseconds. Default: 120 000 (2 min). */
  timeoutMs?: number;
}

/** Options for loudnorm pass-1. */
export interface Pass1Options extends RunnerOptions {
  targetLufs?: number;    // default -14.0
  targetTp?: number;      // default -1.0
  lra?: number;           // default 11.0
}

/** Options for loudnorm pass-2. */
export interface Pass2Options extends RunnerOptions {
  targetLufs?: number;    // default -14.0
  targetTp?: number;      // default -1.0
  lra?: number;           // default 11.0
  sampleRate?: number;    // default 44100
  bitDepth?: 16 | 24;     // default 24
  /**
   * Comma-separated ffmpeg audio filter chain applied BEFORE loudnorm
   * (EQ → compressor).  Empty string means no pre-filters.
   */
  preFilter?: string;
}

/** Options for MP3 preview export. */
export interface EncodeOptions extends RunnerOptions {
  bitrate?: string;   // default '320k'
}

// ── Internal: subprocess runner ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Spawn a binary with the given argument array, collect stdout/stderr as UTF-8,
 * and resolve when the process exits.
 *
 * Rejects with FFmpegSpawnError if:
 *   - The binary cannot be started (ENOENT etc.)
 *   - The process exits with a non-zero code
 *   - The timeout elapses (process is killed, then rejected)
 */
function spawnCollect(
  bin: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      // Never use shell: prevents injection and handles Unicode paths correctly
      shell: false,
      // Inherit env so PATH is available for fallback binary names
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new FFmpegSpawnError(
          bin, args, null, stderr,
          `Process timed out after ${timeoutMs} ms: ${bin}`,
        ),
      );
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new FFmpegSpawnError(
          bin, args, null, '',
          `Failed to start process "${bin}": ${err.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new FFmpegSpawnError(
            bin, args, code, stderr,
            `"${bin}" exited with code ${code}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// ── Internal: JSON extraction ─────────────────────────────────────────────────

/**
 * Extract the last top-level JSON object `{...}` from arbitrary text.
 *
 * FFmpeg's loudnorm filter prints a flat JSON block at the end of its stderr
 * output, surrounded by other log lines.  FFprobe prints JSON to stdout.
 * Both are handled by this function.
 *
 * Algorithm: scan backwards from the last `}` character, tracking brace depth
 * to find the matching `{`.  This is O(n) and handles nested objects.
 */
function extractLastJsonBlock(text: string): Record<string, unknown> {
  const end = text.lastIndexOf('}');
  if (end === -1) {
    throw new FFmpegParseError(text, 'No JSON object found in output (no closing brace)');
  }

  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(i, end + 1);
        try {
          return JSON.parse(slice) as Record<string, unknown>;
        } catch (err) {
          throw new FFmpegParseError(
            slice,
            `Failed to parse JSON block: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  throw new FFmpegParseError(text, 'No matching opening brace found for JSON block');
}

// ── Public: runFFprobe ────────────────────────────────────────────────────────

/** Full ffprobe JSON output (streams + format). */
export interface FFprobeResult {
  streams: Array<Record<string, unknown>>;
  format: Record<string, unknown>;
}

/**
 * Run ffprobe on `filePath` and return the parsed JSON result.
 *
 * Uses spawn argument array — safe with spaces, Korean, and other Unicode in paths.
 *
 * @example
 * const info = await runFFprobe('/Users/me/음악/track.wav');
 * const stream = info.streams.find(s => s.codec_type === 'audio');
 */
export async function runFFprobe(
  filePath: string,
  opts: RunnerOptions = {},
): Promise<FFprobeResult> {
  const bin = resolveFFprobePath(opts);
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    // filePath is passed as a plain array element — no escaping needed
    filePath,
  ];

  const { stdout } = await spawnCollect(bin, args, opts.timeoutMs);

  try {
    return JSON.parse(stdout) as FFprobeResult;
  } catch (err) {
    throw new FFmpegParseError(
      stdout,
      `ffprobe output is not valid JSON: ${(err as Error).message}`,
    );
  }
}

// ── Public: measureLoudnessPass1 ──────────────────────────────────────────────

/**
 * Run ffmpeg loudnorm pass 1 (measurement only, no output written).
 *
 * Equivalent command (conceptual — actual call uses spawn array):
 *   ffmpeg -i <input> -af loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json
 *          -f null -
 *
 * @returns Parsed loudnorm measurement values to be passed to pass-2.
 */
export async function measureLoudnessPass1(
  filePath: string,
  opts: Pass1Options = {},
): Promise<LoudnormMeasurements> {
  const bin = resolveFFmpegPath(opts);
  const I   = opts.targetLufs ?? -14.0;
  const TP  = opts.targetTp   ?? -1.0;
  const LRA = opts.lra        ?? 11.0;

  const args = [
    '-hide_banner',
    '-i', filePath,
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
    '-f', 'null', '-',
  ];

  // loudnorm prints its JSON block to stderr; stdout goes to /dev/null (-f null -)
  const { stderr } = await spawnCollect(bin, args, opts.timeoutMs);

  let raw: Record<string, unknown>;
  try {
    raw = extractLastJsonBlock(stderr);
  } catch {
    throw new FFmpegParseError(
      stderr,
      'loudnorm pass-1 did not produce a parseable JSON block. '
      + 'The file may be silent or too short.',
    );
  }

  // Validate required keys
  const required = ['input_i', 'input_lra', 'input_tp', 'input_thresh', 'target_offset'];
  for (const key of required) {
    if (raw[key] == null) {
      throw new FFmpegParseError(
        JSON.stringify(raw),
        `loudnorm pass-1 JSON is missing required key: "${key}"`,
      );
    }
  }

  // "-inf" means the input is silent — surface this clearly
  if (raw['input_i'] === '-inf' || raw['input_i'] === 'inf') {
    throw new FFmpegParseError(
      JSON.stringify(raw),
      'Loudness measurement returned -inf: the audio file appears to be silent.',
    );
  }

  return raw as unknown as LoudnormMeasurements;
}

// ── Public: normalizeLoudnessPass2 ────────────────────────────────────────────

/**
 * Apply loudnorm pass-2 (linear mode) using pass-1 measurements.
 *
 * Equivalent command (conceptual):
 *   ffmpeg -i <input>
 *          -af [preFilter,]loudnorm=I=-14:TP=-1.0:LRA=11
 *               :measured_I=...:measured_TP=...:measured_LRA=...
 *               :measured_thresh=...:offset=...:linear=true:print_format=none
 *          -ar 44100 -acodec pcm_s24le <output>
 *
 * @param filePath       Input WAV file path
 * @param measuredValues Output of measureLoudnessPass1()
 * @param outputPath     Destination WAV file path
 * @param opts           Optional overrides (target LUFS/TP, sample rate, etc.)
 */
export async function normalizeLoudnessPass2(
  filePath: string,
  measuredValues: LoudnormMeasurements,
  outputPath: string,
  opts: Pass2Options = {},
): Promise<void> {
  const bin = resolveFFmpegPath(opts);
  const I   = opts.targetLufs ?? -14.0;
  const TP  = opts.targetTp   ?? -1.0;
  const LRA = opts.lra        ?? 11.0;
  const sr  = opts.sampleRate ?? 44100;
  const bd  = opts.bitDepth   ?? 24;
  const codec = bd === 16 ? 'pcm_s16le' : 'pcm_s24le';

  // Build loudnorm filter with injected pass-1 measurements
  const loudnorm = [
    `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:linear=true`,
    `measured_I=${measuredValues.input_i}`,
    `measured_LRA=${measuredValues.input_lra}`,
    `measured_TP=${measuredValues.input_tp}`,
    `measured_thresh=${measuredValues.input_thresh}`,
    `offset=${measuredValues.target_offset}`,
    'print_format=none',
  ].join(':');

  // Prepend caller-supplied pre-filter chain (EQ, compressor, etc.)
  const af = opts.preFilter ? `${opts.preFilter},${loudnorm}` : loudnorm;

  const args = [
    '-hide_banner', '-y',
    '-i', filePath,
    '-af', af,
    '-ar', String(sr),
    '-acodec', codec,
    // outputPath may contain spaces or Korean — safe as array element
    outputPath,
  ];

  await spawnCollect(bin, args, opts.timeoutMs);
}

// ── Public: encodePreviewMp3 ──────────────────────────────────────────────────

/**
 * Encode a 320 kbps MP3 preview from the mastered WAV.
 *
 * Equivalent command (conceptual):
 *   ffmpeg -y -i <input.wav> -acodec libmp3lame -b:a 320k <output.mp3>
 *
 * @param filePath   Source WAV path (mastered output)
 * @param outputPath Destination MP3 path
 * @param opts       Optional overrides (bitrate, resolve options, timeout)
 */
export async function encodePreviewMp3(
  filePath: string,
  outputPath: string,
  opts: EncodeOptions = {},
): Promise<void> {
  const bin     = resolveFFmpegPath(opts);
  const bitrate = opts.bitrate ?? '320k';

  const args = [
    '-hide_banner', '-y',
    '-i', filePath,
    '-acodec', 'libmp3lame',
    '-b:a', bitrate,
    outputPath,
  ];

  await spawnCollect(bin, args, opts.timeoutMs);
}

// ── Error classification ───────────────────────────────────────────────────────
//
// Every pattern below was measured against a real binary — ffmpeg 7.0.2
// (`ffmpeg-static`, what the dev build runs) and ffmpeg 6.1.1 (the system one)
// — by making each failure happen and reading what came out.  The versions
// print the decisive line identically.  Three of the four patterns that used
// to live here could not match either of them:
//
//   /unknown encoder/                      → both say "Encoder not found"
//   /decoder .+ not found/                 → both say "Decoder not found",
//                                            with nothing between the two
//                                            words for `.+` to match
//   /unable to find a suitable output format/ → both say
//                                            "Error initializing the muxer"
//
// They are kept, below, as the pre-7 wordings they are, but they are not what
// catches anything today.

/**
 * ffmpeg's own verdict line.  It is the only line that says which SIDE failed
 * and why, and it is identical on 6.1.1 and 7.0.2:
 *
 *   Error opening input files: No such file or directory        (file moved)
 *   Error opening input files: Invalid data found when processing input
 *   Error opening input files: Decoder not found
 *   Error opening output files: No such file or directory       (no such dir)
 *   Error opening output files: Encoder not found
 *   Error opening output files: Invalid argument   (bad filter, bad muxer)
 *
 * ffprobe does not print it at all — it prints `<path>: <reason>` — so the
 * legacy patterns below are what classify a probe failure.
 */
const VERDICT_LINE = /Error opening (input|output) files:\s*(.+)/i;

/** A reason, from either side, that means the codec or container is the problem. */
const CODEC_REASON = /(en|de)coder not found|unknown (en|de)coder|codec not currently supported/i;

/** A reason, on the output side, that means the destination cannot take bytes. */
const DESTINATION_REASON =
  /no such file or directory|permission denied|no space left on device|read-only file system/i;

/**
 * ffmpeg reached the muxer and then gave up.  Measured: writing to a device
 * that is already full prints THIS AND NOTHING ELSE — no errno, no "No space
 * left on device", just the size line and `Conversion failed!`.  Before this
 * was measured, a full disk during an export matched no pattern at all and
 * came out of the catch-all as "your audio file is damaged, try re-exporting
 * it", which is advice that cannot work and sends the user to the wrong file.
 */
const LATE_FAILURE = /Conversion failed!/i;

/** Our own arguments were refused — nothing the user can act on. */
const OUR_ARGUMENTS =
  /Nothing was written into output file|Error initializing a simple filtergraph|Error reinitializing filters/i;

/** Pre-7 stderr patterns for a corrupt / unreadable input.  Still what catches ffprobe. */
const CORRUPT_PATTERNS = [
  /invalid data found/i,
  /moov atom not found/i,
  /end of file/i,
  /no such file or directory/i,
  /input\/output error/i,
];

/** Pre-7 stderr patterns for an unsupported codec or container. */
const UNSUPPORTED_PATTERNS = [
  /decoder .+ not found/i,
  /unknown encoder/i,
  /codec not currently supported/i,
  /unable to find a suitable output format/i,
];

/**
 * The shape the app's own ffmpeg callers throw.
 *
 * Three places in the desktop app spawn ffmpeg themselves and reject with
 * `` `${binary} exited ${code}: ${stderr}` `` — the offline Rust render, the
 * decode store, and the transcoder.  None of them construct an
 * {@link FFmpegSpawnError}, so until this pattern existed every one of their
 * failures fell past the classification below and reached the user as
 * "알 수 없는 오류" with ffmpeg's English stderr attached, while the Korean
 * message and the UI hint for the actual cause sat here unused.
 */
const APP_SPAWN_MESSAGE = /^(ffmpeg|ffprobe)(\.exe)? exited (-?\d+|null)(?::|$)/i;

/** Classify ffmpeg/ffprobe stderr.  `isProbe` picks the binary for ENOENT. */
function classifyStderr(
  stderr: string, exitCode: number | null, filePath: string, isProbe: boolean,
): AppError {
  const detail = (what: string): string =>
    `${what} (exit ${exitCode ?? 'null'}): ${stderr.trim().slice(-400)}`;

  const verdict = VERDICT_LINE.exec(stderr);
  if (verdict) {
    const side   = (verdict[1] ?? '').toLowerCase();
    const reason = (verdict[2] ?? '').trim();

    if (CODEC_REASON.test(reason)) {
      const named = /unknown (?:en|de)coder '([^']+)'/i.exec(stderr)?.[1];
      return formatUnsupported(filePath, named ?? reason);
    }
    if (side === 'output') {
      if (DESTINATION_REASON.test(reason)) return outputDirNotWritable(filePath || reason);
      // Anything else on the output side is our argument list, not their file.
      return unknownError(detail(`ffmpeg refused the output arguments — ${reason}`));
    }
    return fileCorrupted(filePath, detail(`input rejected — ${reason}`));
  }

  if (OUR_ARGUMENTS.test(stderr)) {
    return unknownError(detail('ffmpeg refused the filter or encoder arguments'));
  }

  for (const pat of UNSUPPORTED_PATTERNS) {
    if (pat.test(stderr)) {
      const named = /decoder (.+?) not found/i.exec(stderr)?.[1];
      return formatUnsupported(filePath, named ?? 'unknown');
    }
  }
  for (const pat of CORRUPT_PATTERNS) {
    if (pat.test(stderr)) return fileCorrupted(filePath, detail('input rejected'));
  }

  // The input opened and decoding ran; the write side is what gave up.  A full
  // disk lands exactly here.  ffprobe never writes anything, so this is only
  // ever ffmpeg.
  if (!isProbe && LATE_FAILURE.test(stderr)) {
    return outputDirNotWritable(filePath || '(output path)');
  }

  return unknownError(detail('ffmpeg failed'));
}

/**
 * Convert a raw `FFmpegSpawnError` or `FFmpegParseError` into an `AppError`
 * with a Korean user message, English dev detail, and recoverable flag.
 *
 * @param err       The raw error thrown by runner functions
 * @param isFfprobe Pass true when the failing binary is ffprobe (not ffmpeg)
 * @param filePath  Optional: the input file path, for richer error messages
 */
export function classifyFFmpegError(
  err: unknown,
  isFfprobe = false,
  filePath = '',
): AppError {
  // Already classified — pass through
  if (err instanceof AppError) return err;

  if (err instanceof FFmpegParseError) {
    return loudnormParseFailed(err.message + (err.raw ? ` | raw: ${err.raw.slice(0, 300)}` : ''));
  }

  if (err instanceof FFmpegSpawnError) {
    const msg = err.message;

    // Binary not found (ENOENT on spawn).  Which binary comes from the path
    // as well as the flag: `runFFprobe` resolves ffprobe and raises this
    // without anyone passing `isFfprobe`, and reporting that as a missing
    // ffmpeg points the user at a binary they may well already have.
    if (/ENOENT/i.test(msg) || /Failed to start process/i.test(msg)) {
      return binaryNotFound(err.bin, msg, isFfprobe || isProbeBin(err.bin));
    }

    // Timeout
    if (/timed out/i.test(msg)) return ffmpegTimedOut(msg);

    return classifyStderr(err.stderr ?? '', err.exitCode, filePath, isFfprobe || isProbeBin(err.bin));
  }

  // An ordinary Error carrying ffmpeg's stderr — what the app's own three
  // spawners throw.  Gated on the measured message shape so that a failure
  // from somewhere else (the Python bridge, a licence read, a missing session
  // file) cannot be read as an ffmpeg verdict just because the words "no such
  // file or directory" appear in it.
  if (err instanceof Error && APP_SPAWN_MESSAGE.test(err.message)) {
    const probe = isFfprobe || /^ffprobe/i.test(err.message);
    if (/ENOENT/i.test(err.message)) {
      return binaryNotFound(probe ? 'ffprobe' : 'ffmpeg', err.message, probe);
    }
    // The stderr follows the first colon; the whole message is passed when the
    // caller trimmed it to nothing.
    const stderr = err.message.slice(err.message.indexOf(':') + 1).trim() || err.message;
    const exitCode = Number(/exited (-?\d+)/i.exec(err.message)?.[1] ?? NaN);
    return classifyStderr(stderr, Number.isNaN(exitCode) ? null : exitCode, filePath, probe);
  }

  // Node's own spawn failure, before any stderr exists: "spawn ffmpeg ENOENT".
  if (err instanceof Error && /spawn\s+\S*ffprobe(\.exe)?\s+ENOENT/i.test(err.message)) {
    return binaryNotFound('ffprobe', err.message, true);
  }
  if (err instanceof Error && /spawn\s+\S*ffmpeg(\.exe)?\s+ENOENT/i.test(err.message)) {
    return binaryNotFound('ffmpeg', err.message, false);
  }

  // Unrecognised error
  return unknownError((err as Error).message ?? String(err));
}

/** True when the resolved binary path is ffprobe rather than ffmpeg. */
function isProbeBin(bin: string): boolean {
  return /ffprobe(\.exe)?$/i.test(bin);
}

function binaryNotFound(bin: string, detail: string, isProbe: boolean): AppError {
  const said = `spawn ENOENT for "${bin}" — ${detail}`;
  return isProbe ? ffprobeNotFound(said) : ffmpegNotFound(said);
}

/**
 * An ffmpeg run that went past its timeout.
 *
 * The code is PYTHON_PROCESS_FAILED because that is the one recoverable code
 * the renderer already shows "잠시 후 다시 시도해주세요" for, and a timeout is
 * the one ffmpeg failure where retrying can genuinely work.  The Korean text
 * is this function's own, so the user is never told the Python engine is
 * involved when it is not.
 */
function ffmpegTimedOut(detail: string): AppError {
  return new AppError(
    'PYTHON_PROCESS_FAILED',
    '처리 시간이 초과되었습니다. 파일 크기를 확인하거나 다시 시도해주세요.',
    `FFmpeg timeout: ${detail}`,
    true,
  );
}
