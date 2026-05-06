/**
 * Load a filesystem path into a decoded AudioBuffer via the aimaster-local
 * protocol + Web Audio's decodeAudioData.
 *
 * The path MUST already be allowlisted by the main process (which happens
 * automatically for paths returned by `audio:analyze` / `audio:master` and
 * for files dropped onto the renderer — see App.tsx GlobalDropOverlay).
 *
 * Returns null on any failure (404, decode error, missing API).
 */
import type { AudioBufferLike } from './loudnessCore.js';

export async function loadAudioBufferFromPath(
  path: string,
  ctx?: AudioContext,
): Promise<AudioBufferLike | null> {
  if (!path) return null;
  // Build the aimaster-local URL.  Encode each path segment so `#`/`?`/`&`
  // in filenames don't break URL parsing (matches HomePage / ResultPage).
  const normalized = path.replace(/\\/g, '/');
  const withSlash  = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const url = `aimaster-local://${withSlash.split('/').map(encodeURIComponent).join('/')}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const arrBuf = await resp.arrayBuffer();
    // Build/borrow an AudioContext for decoding.  Caller can supply one
    // if they want to share a context with downstream playback (avoids
    // having to re-decode for the player).
    const w = window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    const own = !ctx;
    const useCtx = ctx ?? new Ctor({ latencyHint: 'interactive' });
    try {
      const decoded = await useCtx.decodeAudioData(arrBuf);
      // Web Audio's AudioBuffer satisfies AudioBufferLike directly.
      return decoded;
    } finally {
      if (own) {
        try { await useCtx.close(); } catch { /* noop */ }
      }
    }
  } catch {
    return null;
  }
}
