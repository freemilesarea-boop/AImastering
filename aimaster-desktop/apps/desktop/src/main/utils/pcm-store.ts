// The decoded-audio store on disk: what is in it, and what the cap means.
//
// Pulled out of `ipc/decodeHandlers.ts` so these rules can be tested — that
// file imports electron for `app.getPath('userData')`, which put the sweep
// out of reach of every test.
//
// ── What the cap used to count ──────────────────────────────────────────────
//
// The sweep looked at `*.f32` only.  A decode writes to `${key}.${uuid}.part`
// and renames it when it is whole, so a decode that is KILLED — the app quit,
// the machine slept, ffmpeg was OOM-killed — leaves a `.part` behind.  Those
// were never counted against the cap and never removed by anything.  Measured
// with the old sweep, a 10 MB cap standing in for the real 12 GB:
//
//   before: directory 68 MB, what the sweep counts 8 MB, files 7
//   after : directory 68 MB, what the sweep counts 8 MB, files 7
//
// At the shipped constants one dead decode of a four-minute song leaves ~92 MB,
// and of a `MAX_SECONDS` file (three hours, 48 kHz stereo float32) ~4 GB —
// inside a store that advertises a 12 GB ceiling.
//
// So the cap counts every byte in the directory that belongs to the store, and
// the sweep removes the leftovers as well as evicting whole stores.
//
// ── Why the leftovers are not removed on sight ──────────────────────────────
//
// The sweep runs immediately BEFORE a decode, and more than one decode can be
// in flight (the renderer opens a session with eight tracks).  A `.part` being
// written right now is indistinguishable from one left by a death, so age is
// the only thing that separates them.  A decode of the longest file the
// handler accepts takes about a minute (1.4 s for four minutes, measured in
// `decodeHandlers`' own header), so an hour is far past "still working".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How much decoded audio to keep on disk before dropping the oldest. */
export const STORE_CAP_BYTES = 12 * 1024 * 1024 * 1024;
/** Beyond this, a part-file or a sidecar-less store is not in flight. */
export const PART_MAX_AGE_MS = 60 * 60 * 1000;

export const PCM_EXT = '.f32';
export const SIDE_EXT = '.json';
// No `PART_EXT`: a part-file is recognised by `partKey`, which checks the
// whole shape rather than just the suffix, and an extra constant beside it
// was an export nothing referenced.  The dead-exports ratchet said so.

/**
 * Identify a decode by what would change its samples: which file, which
 * version of it, and the rate it was resampled to.
 */
export function storeKey(
  filePath: string, mtimeMs: number, size: number, sampleRate: number,
): string {
  return crypto.createHash('sha1')
    .update(`${filePath} ${Math.round(mtimeMs)} ${size} ${sampleRate}`)
    .digest('hex');
}

/**
 * A store key is a sha1 hex digest, and the shape is what makes a file ours.
 *
 * Checked rather than assumed, because the first version of this module took
 * any `*.json` for a sidecar: `settings.json` sitting in the directory had no
 * `settings.f32` beside it, so it was classified as a half-published store and
 * deleted.  Its own test said "a file this store did not write is neither
 * counted nor deleted" and failed on it.
 */
const KEY_RE = /^[0-9a-f]{40}$/;

/** `<key>.f32` or `<key>.json` → `<key>`, or null when the name is not ours. */
export function storeKeyOf(name: string, ext: string): string | null {
  if (!name.endsWith(ext)) return null;
  const base = name.slice(0, -ext.length);
  return KEY_RE.test(base) ? base : null;
}

/** `<key>.<uuid>.part` → `<key>`, so a leftover can be matched to its store. */
export function partKey(name: string): string | null {
  const m = /^([0-9a-f]{40})\.[0-9a-f-]+\.part$/.exec(name);
  return m?.[1] ?? null;
}

export interface SweepReport {
  /** Bytes in the directory that belong to the store, before removing any. */
  totalBytes: number;
  /** Files removed because they were leftovers nothing can use. */
  removedOrphans: string[];
  /** Complete stores evicted, least recently used first, to meet the cap. */
  evicted: string[];
  /** Bytes left after the sweep. */
  keptBytes: number;
}

interface Entry { name: string; bytes: number; atimeMs: number; mtimeMs: number }

function read(dir: string): Entry[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: Entry[] = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, bytes: st.size, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  return out;
}

/**
 * Bring the store inside its cap, and clear what nothing can use.
 *
 * Leftovers go first: they are bytes no request can ever turn into a hit, so
 * evicting a usable store ahead of them would be throwing away work to keep
 * rubbish.  Only files this store writes are touched — anything else in the
 * directory is somebody else's.
 */
export function sweepStore(
  dir: string,
  opts: { capBytes?: number; nowMs?: number; partMaxAgeMs?: number } = {},
): SweepReport {
  const cap = opts.capBytes ?? STORE_CAP_BYTES;
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.partMaxAgeMs ?? PART_MAX_AGE_MS;

  const entries = read(dir);
  const pcm = new Map<string, Entry>();
  const side = new Set<string>();
  const parts: Entry[] = [];
  let totalBytes = 0;

  for (const e of entries) {
    const pcmKey = storeKeyOf(e.name, PCM_EXT);
    const sideKey = storeKeyOf(e.name, SIDE_EXT);
    if (pcmKey !== null) {
      pcm.set(pcmKey, e);
      totalBytes += e.bytes;
    } else if (sideKey !== null) {
      side.add(sideKey);
      totalBytes += e.bytes;
    } else if (partKey(e.name) !== null) {
      parts.push(e);
      totalBytes += e.bytes;
    }
    // Anything else: not ours, not counted, not touched.
  }

  const removedOrphans: string[] = [];
  let kept = totalBytes;
  const drop = (name: string, bytes: number): void => {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removedOrphans.push(name);
      kept -= bytes;
    } catch { /* another run got there first */ }
  };

  // A part-file from a decode that died.  Age is the only thing separating it
  // from one being written right now — see the header.
  for (const p of parts) {
    if (now - p.mtimeMs > maxAge) drop(p.name, p.bytes);
  }

  // A sidecar whose samples are gone can never be a hit.  It is written BEFORE
  // the rename, so one without a `.f32` means either the rename never happened
  // or the samples were evicted — in both cases there is nothing to read.
  for (const key of side) {
    if (!pcm.has(key)) {
      const e = entries.find((x) => x.name === `${key}${SIDE_EXT}`);
      if (e && now - e.mtimeMs > maxAge) drop(e.name, e.bytes);
    }
  }

  // A store whose sidecar is gone cannot be a hit either: the hit path needs
  // the frame count and the peaks.  Same age guard, for the same reason.
  for (const [key, e] of pcm) {
    if (!side.has(key) && now - e.mtimeMs > maxAge) {
      drop(e.name, e.bytes);
      pcm.delete(key);
    }
  }

  // Then the ordinary business: evict whole stores, least recently used
  // first, until what is left fits.
  const evicted: string[] = [];
  if (kept > cap) {
    const usable = [...pcm.entries()]
      .filter(([key]) => side.has(key))
      .sort((a, b) => a[1].atimeMs - b[1].atimeMs);
    for (const [key, e] of usable) {
      if (kept <= cap) break;
      try {
        fs.rmSync(path.join(dir, e.name), { force: true });
        kept -= e.bytes;
        evicted.push(e.name);
        const sidecar = entries.find((x) => x.name === `${key}${SIDE_EXT}`);
        fs.rmSync(path.join(dir, `${key}${SIDE_EXT}`), { force: true });
        if (sidecar) kept -= sidecar.bytes;
      } catch { /* another run got there first */ }
    }
  }

  return { totalBytes, removedOrphans, evicted, keptBytes: kept };
}
