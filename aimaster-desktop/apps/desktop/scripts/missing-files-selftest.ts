/**
 * missing-files-selftest.ts — the session that opened silent and said nothing.
 *
 * `preloadAll` used to end like this:
 *
 *     try { await loadAudio(ctx, f.id, f.path); } catch { /* missing file → silence *\/ }
 *
 * and its caller in daw-runtime said `/* reported per file already *\/`.
 * Nothing reported anything. Three separate places agreed to stay quiet:
 *
 *   · `engineWarning` had carried the words "decode failures" in its own
 *     comment since it was written, and no line in the app ever set it — or
 *     drew it.
 *   · `clip-pool` had a `missing` flag gated on `existingPaths`, and the only
 *     caller that ever passed that option was a selftest, so the 없어짐 badge
 *     could not light up.
 *   · the OFFLINE RENDER used the same swallowing preload. Measured before
 *     any of this was written, on a session whose source had moved:
 *
 *         { renderThrew: false, frames: 96000, peak: 0 }
 *
 *     A silent master, written without an error, indistinguishable from a
 *     quiet mix until somebody played it somewhere else.
 *
 * Playback still carries on with what it has — one missing stem of twelve
 * should not stop the other eleven, and the silence is obvious the moment you
 * press play. A file on disk is not obvious, and it is the one that gets sent
 * to a client, so the render refuses.
 */

import { OfflineAudioContext } from './lib/offline-audio-context.js';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addFile, addTrack, createClip, createSession, createTrack, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import {
  clearAudioCache, decodeForDisplay, forgetMissing, missingFileIds, missingFiles,
  noteLoadFailure, onMissingFile, preloadAll,
} from '../src/renderer/daw/engine/audio-cache.js';
import { buildPool } from '../src/renderer/daw/model/clip-pool.js';
import { analyzeBuffer } from '../src/renderer/daw/engine/audio-cache.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const GONE = { id: 'f-gone', path: '/definitely/not/here/kick.wav', name: 'kick.wav',
               durationSec: 2, sampleRate: 48_000, channels: 2 };

/** A session with one clip playing a file that is not on disk. */
function sessionUsingMissing(): DawSession {
  let s = addFile(createSession('missing', 48_000), GONE);
  const t = createTrack('킥');
  s = addTrack(s, t);
  return updateTrack(s, t.id, (track) => ({
    ...track,
    playlists: track.playlists.map((p, i) => (
      i === 0 ? { ...p, clips: [createClip(GONE.id, GONE.name, { startSec: 0, durationSec: 2 })] } : p)),
  }));
}

async function main(): Promise<void> {
  const ctx = new OfflineAudioContext(2, 48_000, 48_000) as unknown as BaseAudioContext;

  // ── 1. The failure is handed back, not swallowed ──────────────────────────

  clearAudioCache();
  check('nothing is missing before anything has been tried', missingFileIds().size === 0);

  /**
   * Preload without letting an unexpected throw take the report with it.
   *
   * A first version awaited `preloadAll` directly, and the break that made it
   * throw instead of collecting produced ZERO failed checks — because the
   * process died before printing any.  A crash is not a pass.
   */
  const tryPreload = async (files: typeof GONE[]): Promise<{
    failures: Awaited<ReturnType<typeof preloadAll>>; threw: string | null;
  }> => {
    try { return { failures: await preloadAll(ctx, files), threw: null }; }
    catch (e) { return { failures: [], threw: e instanceof Error ? e.message : String(e) }; }
  };

  const first = await tryPreload([GONE]);
  check('preloading a missing file does not throw', first.threw === null, first.threw ?? '');
  const failures = first.failures;
  check('a file that cannot be read comes back as a failure',
    failures.length === 1 && failures[0]?.id === GONE.id, JSON.stringify(failures));
  // Not "is it non-empty": the version of this check that asked only that
  // passed happily while the store path recorded the words "소스를 준비하지
  // 못했습니다" for every cause there is.  A reason has to be ABOUT the file.
  check('with a reason worth reading',
    (failures[0]?.reason ?? '').length > 0
    && /gone\.wav|ENOENT|no such file|열 수 없|읽을 수 없/i.test(failures[0]?.reason ?? ''),
    failures[0]?.reason);
  check('and it is remembered', missingFileIds().has(GONE.id));

  // ── 1b. The store path: main already worked out why ──────────────────────
  // `decodeForDisplay` goes through main when there is a store, which is the
  // path a real session takes and the one no test could reach before — the
  // bridge is simply absent in Node, so `canUseStore()` said no and the whole
  // branch was skipped.  Stubbed here, because the line that matters is what
  // it does with main's answer: it used to replace it.
  {
    const asked: string[] = [];
    const bridge = {
      invoke: (channel: string, arg: unknown): Promise<unknown> => {
        asked.push(channel);
        const filePath = String((arg as { path?: unknown }).path ?? '');
        if (filePath.endsWith('fine.wav')) {
          return Promise.resolve({
            key: 'k1', pcmPath: '/tmp/k1.f32', sampleRate: 48_000,
            channels: 2, frames: 48_000, peaks: [0.5, 0.25],
          });
        }
        // Exactly what the running app delivers: the Korean sentence
        // `classifyFFmpegError` produced from ffmpeg's stderr, inside the
        // envelope Electron puts around every handler error.  Measured on
        // device — without the unwrapping in `pcm-store`, the reason the DAW
        // remembers starts with "Error invoking remote method".
        return Promise.reject(new Error(
          "Error invoking remote method 'daw:pcm-source': Error: "
          + '오디오 파일을 읽을 수 없습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.'));
      },
    };
    const g = globalThis as unknown as { electronAPI?: unknown };
    g.electronAPI = bridge;
    clearAudioCache();
    const report = await decodeForDisplay([
      { id: 'broken' as typeof GONE.id, path: '/songs/깨진 파일.wav' },
      { id: 'fine'   as typeof GONE.id, path: '/songs/fine.wav' },
    ]);
    const remembered = missingFiles().find((f) => f.id === 'broken');
    delete g.electronAPI;
    clearAudioCache();

    check('the store path decodes what it can and reports what it cannot',
      report.decoded === 1 && report.failed.length === 1
      && asked.filter((c) => c === 'daw:pcm-source').length === 2,
      `decoded=${report.decoded}, failed=${report.failed.length}, ${asked.length} IPC call(s)`);
    check("and the reason it remembers is main's, not a sentence of its own",
      (remembered?.reason ?? '').includes('손상되었거나'),
      remembered?.reason ?? '(nothing was recorded)');
    check('with Electron\u2019s envelope taken off it',
      (remembered?.reason ?? '').startsWith('오디오 파일을'),
      remembered?.reason ?? '(nothing was recorded)');
  }

  check('forgetting one drops it', (() => {
    forgetMissing(GONE.id);
    return !missingFileIds().has(GONE.id);
  })());

  // A file that CAN be read stops being missing.  Seeded through the cache
  // rather than decoded, because node's fetch cannot open a file:// URL — but
  // it is the same `failed.delete`, which is why there is only one of them.
  {
    clearAudioCache();
    await tryPreload([GONE]);
    const stillGone = missingFileIds().has(GONE.id);
    const buffer = ctx.createBuffer(1, 128, 48_000);
    analyzeBuffer(GONE.id, buffer);
    await tryPreload([GONE]);
    check('a file that reads stops being marked missing',
      stillGone && !missingFileIds().has(GONE.id),
      `was missing: ${stillGone}, still missing: ${missingFileIds().has(GONE.id)}`);
  }
  check('and clearing the cache drops them all', (() => {
    void preloadAll(ctx, [GONE]);
    clearAudioCache();
    return missingFileIds().size === 0;
  })());

  // ── 2. The pool can finally say so ────────────────────────────────────────

  const s = sessionUsingMissing();
  check('the pool says nothing when nobody has looked',
    buildPool(s)[0]?.missing === false);
  check('and marks the file once the engine has failed on it',
    buildPool(s, { missingIds: new Set([GONE.id]) })[0]?.missing === true);
  // The option that existed before is still honoured, because a caller that
  // HAS statted the disk knows something a failed decode does not.
  check('the older existingPaths route still works',
    buildPool(s, { existingPaths: new Set<string>() })[0]?.missing === true);

  // ── 3. The render refuses rather than writing silence ─────────────────────

  clearAudioCache();
  let rendered: AudioBuffer | null = null;
  let message = '';
  try { rendered = await renderSession(s, { startSec: 0, endSec: 2 }, { tailSec: 0 }); }
  catch (e) { message = e instanceof Error ? e.message : String(e); }
  check('a render that needs a missing file refuses', rendered === null,
    rendered ? `rendered ${rendered.length} frames instead` : '');
  check('and the message names the file', message.includes('kick.wav'), message);

  // Over-refusing is its own bug: a session often carries sources no clip
  // uses any more, and a bounce that was never going to touch one must not
  // be blocked by it.
  clearAudioCache();
  let unusedOk = false;
  try {
    const empty = addTrack(addFile(createSession('unused', 48_000), GONE), createTrack('빈'));
    const out = await renderSession(empty, { startSec: 0, endSec: 1 }, { tailSec: 0 });
    unusedOk = out.length > 0;
  } catch { unusedOk = false; }
  check('a missing file no clip uses does not block the bounce', unusedOk);

  // A muted clip is not going to be heard, so it must not stop the render
  // either — the same reason as above, one level down.
  clearAudioCache();
  let mutedOk = false;
  try {
    const muted = updateTrack(sessionUsingMissing(),
      sessionUsingMissing().tracks[0]!.id, (t) => t);
    const withMutedClip: DawSession = {
      ...muted,
      tracks: muted.tracks.map((t) => ({
        ...t,
        playlists: t.playlists.map((p) => ({
          ...p, clips: p.clips.map((c) => ({ ...c, muted: true })),
        })),
      })),
    };
    const out = await renderSession(withMutedClip, { startSec: 0, endSec: 1 }, { tailSec: 0 });
    mutedOk = out.length > 0;
  } catch { mutedOk = false; }
  check('a muted clip on a missing file does not block it either', mutedOk);

  // ── 3b. Every door announces ──────────────────────────────────────────────

  // Measured in the packaged app, and the reason this section exists: with
  // streaming available, `prepare()` skips `preloadAll` entirely, so wiring
  // only that one left the live transport as quiet as before — the failure
  // came out of ClipPlayer's own fetch as a console.warn and nothing else.
  {
    clearAudioCache();
    const heard: string[] = [];
    const off = onMissingFile((f) => heard.push(f.id));
    noteLoadFailure(GONE.id, GONE.path, new Error('ENOENT'));
    off();
    noteLoadFailure('f-other', '/nope.wav', new Error('ENOENT'));
    check('a listener hears a failure', heard.join() === GONE.id, heard.join());
    check('and stops hearing once it unsubscribes', heard.length === 1);
    check('but the failure is recorded either way',
      missingFileIds().has('f-other'));
  }

  // ── 4. The four places that agreed to stay quiet ──────────────────────────

  const cache = stripComments(read('src/renderer/daw/engine/audio-cache.ts'));
  const runtime = stripComments(read('src/renderer/daw/engine/daw-runtime.ts'));
  const store = stripComments(read('src/renderer/stores/dawStore.ts'));
  const page = stripComments(read('src/renderer/pages/DawPage.tsx'));
  const pool = stripComments(read('src/renderer/components/daw/edit/PoolPanel.tsx'));
  const render = stripComments(read('src/renderer/daw/engine/offline-render.ts'));

  check('the cache no longer has an empty catch on a decode',
    !/catch\s*\{\s*\}/.test(cache) && /failures\.push\(/.test(cache));
  // Every door must go through the one that records AND announces.  There
  // were four, and each stayed quiet in its own way.
  const player = stripComments(read('src/renderer/daw/engine/clip-player.ts'));
  check('the scheduler reports what it could not fetch',
    /noteLoadFailure\(/.test(player));
  check('and so does the display decode', /noteLoadFailure\(/.test(cache));
  check('the runtime still preloads through it', /preloadAll\(/.test(runtime));
  check('the store turns them into the warning it always had',
    /onMissingFile\(/.test(store) && /engineWarning:/.test(store));
  // The warning says "put it back OR delete the clip".  Without this the
  // second half was a lie: the banner stayed up after the clip went, naming
  // audio the session no longer asked for.
  // Defining it is not calling it — the third time in this session that a
  // structural check matched a function's own declaration and let the one
  // place it is USED be deleted.  The call has to be inside `apply`, which is
  // the single path a real edit takes.
  check('and takes it down once nothing plays the file',
    /apply:\s*\(fn\)\s*=>\s*\{[\s\S]{0,600}?forgetUnreferencedFailures\(next\)/.test(store)
    && /forgetMissing\(/.test(store),
    'forgetUnreferencedFailures is declared but not called from apply');
  check('using the same test the render refuses on',
    /forgetUnreferencedFailures[\s\S]{0,700}clip\.kind === 'audio' && !clip\.muted/.test(store),
    'the banner and the bounce would disagree about what still matters');
  // Defining the bar is not drawing it: a first version asked only whether
  // the file mentioned `engineWarning`, which the component's own body does,
  // so deleting the one place it is RENDERED went straight through.
  check('and something finally draws that warning',
    /data-testid="engine-warning"/.test(page) && /<EngineWarningBar\s*\/>/.test(page));
  check('the pool asks the engine what failed', /missingFileIds\(\)/.test(pool));
  check('the render refuses', /throw new Error\(/.test(render) && /neededFiles\(/.test(render));
  // Loading another session must not leave the last one's warning up.
  check('a new session starts clean',
    /loadSession[\s\S]{0,400}engineWarning: null/.test(store)
    && /loadSession[\s\S]{0,400}clearAudioCache\(\)/.test(store));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
