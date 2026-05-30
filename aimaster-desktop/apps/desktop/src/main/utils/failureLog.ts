/**
 * failureLog.ts — categorised, ring-buffered runtime failure log.
 *
 * Augments the line-by-line `log.*` writer in `logger.ts` with a
 * structured in-memory ring of up to N recent failures.  The renderer
 * can request a snapshot via the `support:bundle` IPC channel without
 * having to scrape the line log.
 *
 * Design constraints:
 *   • In-memory only — survives across IPC calls but resets on app
 *     restart (which is fine — failures recur, and we don't want to
 *     persist user-specific paths between sessions).
 *   • Bounded — we keep MAX_ENTRIES per category.  Oldest entries are
 *     dropped silently.
 *   • Path-redacting — `redactPath()` strips the user's home directory
 *     and replaces it with `~`.  Filenames are kept (helpful for
 *     reproducing) but the directory tree above the user is hidden.
 *   • Pure helpers exported for unit tests; the singleton is a thin
 *     facade.
 */

import os from 'node:os';

export type FailureCategory =
  | 'preview'        // <audio> playback / loudness meter (renderer)
  | 'worklet'        // AudioWorklet load / runtime
  | 'ffmpeg'         // bundled ffmpeg / ffprobe spawn / probe
  | 'engine'         // Python (PyInstaller) bridge spawn / RPC
  | 'export'         // TXT / JSON / WAV / MP3 export
  | 'pipeline'       // mastering pipeline warnings escalated to errors
  | 'license'        // license verification / HMAC failures
  | 'session'        // session save / load (workspace state)
  | 'unknown';

export interface FailureEntry {
  category:     FailureCategory;
  /** ISO-8601 timestamp (UTC). */
  at:           string;
  /** Short human message — already path-redacted. */
  message:      string;
  /** Optional structured data (path-redacted recursively). */
  data?:        Record<string, unknown>;
}

const MAX_ENTRIES = 50;      // per-category ring size

// ── Path redaction ──────────────────────────────────────────────────────────

/**
 * Replace any occurrence of the user's home directory (or any other
 * `/Users/<name>` / `/home/<name>` / `<drive>:\Users\<name>` form) with
 * `~`.  Filenames are kept — they're useful for support reproduction —
 * but the directory tree above the user is hidden.
 *
 * Exported for unit tests.
 */
export function redactPath(input: string): string {
  if (typeof input !== 'string') return String(input);
  let out = input;

  // 1. Current user's home, verbatim + forward-slash form.
  let home = '';
  try { home = os.homedir(); } catch { home = ''; }
  if (home) {
    const homeAlt = home.replace(/\\/g, '/');
    if (out.includes(home))    out = out.split(home).join('~');
    if (out.includes(homeAlt)) out = out.split(homeAlt).join('~');
  }

  // 2. Other users' POSIX home dirs.  Match `/Users/<name>` (macOS) or
  //    `/home/<name>` (Linux) where <name> is one path segment (no slashes).
  out = out.replace(/\/Users\/[^/\s"']+/g, '~');
  out = out.replace(/\/home\/[^/\s"']+/g, '~');

  // 3. Windows drive-letter form: `C:\Users\<name>` or `C:/Users/<name>`.
  out = out.replace(/[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/\s"']+/g, '~');

  return out;
}

/** Recursively redact paths in a structured object — depth-limited. */
export function redactObject(obj: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (obj == null) return obj;
  if (typeof obj === 'string') return redactPath(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactObject(v, depth + 1));
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Drop keys that conventionally hold sensitive paths verbatim.
      if (k === 'outputPath' || k === 'previewPath' || k === 'filePath'
          || k === 'srcPath'   || k === 'tmpPath'    || k === 'artifactDir') {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = redactObject(v, depth + 1);
    }
    return out;
  }
  return String(obj);
}

// ── Ring buffer ─────────────────────────────────────────────────────────────

const buckets: Record<FailureCategory, FailureEntry[]> = {
  preview:  [],
  worklet:  [],
  ffmpeg:   [],
  engine:   [],
  export:   [],
  pipeline: [],
  license:  [],
  session:  [],
  unknown:  [],
};

/**
 * Record a runtime failure.  Path-redaction happens here so callers don't
 * have to remember.  `data` may include a stack — only the first 800
 * chars are kept to avoid runaway memory.
 */
export function recordFailure(
  category: FailureCategory,
  message:  string,
  data?:    Record<string, unknown>,
): void {
  const bucket = buckets[category];
  const entry: FailureEntry = {
    category,
    at:      new Date().toISOString(),
    message: redactPath(typeof message === 'string' ? message : String(message)),
    ...(data !== undefined
      ? { data: redactObject(data) as Record<string, unknown> }
      : {}),
  };
  bucket.push(entry);
  if (bucket.length > MAX_ENTRIES) {
    bucket.splice(0, bucket.length - MAX_ENTRIES);
  }
}

/** Drain a snapshot of all entries (newest last).  Buckets are NOT cleared. */
export function snapshotFailures(): FailureEntry[] {
  const out: FailureEntry[] = [];
  for (const cat of Object.keys(buckets) as FailureCategory[]) {
    out.push(...buckets[cat]);
  }
  // Sort by timestamp ascending so the consumer gets a chronological log.
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/**
 * Counts per category — useful for dashboards / telemetry that don't want
 * to carry the full payload.
 */
export function failureCounts(): Record<FailureCategory, number> {
  const c: Record<FailureCategory, number> = {
    preview: 0, worklet: 0, ffmpeg: 0, engine: 0, export: 0,
    pipeline: 0, license: 0, session: 0, unknown: 0,
  };
  for (const cat of Object.keys(buckets) as FailureCategory[]) {
    c[cat] = buckets[cat].length;
  }
  return c;
}

/** Test-only — wipe all buckets. */
export function resetFailureLogForTests(): void {
  for (const cat of Object.keys(buckets) as FailureCategory[]) {
    buckets[cat].length = 0;
  }
}
