// wav-buffer — turn bytes into an AudioBuffer without the media stack.
//
// `AudioContext.decodeAudioData` is the obvious way to do this and it is not
// safe here. It hands the bytes to Chromium's media pipeline, and where that
// pipeline cannot bring up its audio decoder the renderer does not reject
// the promise — the process dies. Exit code 11, an empty window, nothing in
// the console and nothing to catch, because nothing throws.
//
// It was measured: in this app's Electron build, EVERY WAV crashed it — 16-,
// 24- and 32-bit, mono and stereo, 44.1 and 48 kHz, one second and twenty.
// `decode-safety-selftest` is the harness that establishes it, and it also
// shows this path decoding the same files.
//
// WAV needs no media pipeline. It is a header and a block of samples, and
// `wav-format` reads it — the same parser the main process writes those
// files with. Anything else (mp3, m4a, flac) still goes through
// `decodeAudioData`, because there is no alternative for those here; the
// file that matters most, the baked preview, is one this app wrote itself.

import { decodeWavPlanar } from '../../shared/wav-format.js';

/**
 * Decode audio bytes to an AudioBuffer.
 *
 * The buffer keeps the FILE's sample rate rather than the context's. An
 * `AudioBufferSourceNode` converts on playback, so resampling here would be
 * a second conversion of the same audio for no gain — and it is the reason
 * this returns instantly for a preview that is already at session rate.
 */
export function decodeAudioBytes(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const planar = decodeWavPlanar(new Uint8Array(bytes));
  if (planar && planar.frames > 0) {
    const buffer = ctx.createBuffer(planar.channels.length, planar.frames, planar.sampleRate);
    for (let c = 0; c < planar.channels.length; c++) {
      // `getChannelData` + `set` rather than `copyToChannel`: the typed
      // arrays the parser produces are plain ArrayBuffer-backed, and the
      // narrower signature of `copyToChannel` rejects them.
      buffer.getChannelData(c).set(planar.channels[c]!);
    }
    return Promise.resolve(buffer);
  }
  // Not a WAV — a user's mp3 or m4a. Nothing else can read it here.
  return ctx.decodeAudioData(bytes);
}

/** True when these bytes are a WAV this decoder handles on its own. */
export function isDecodableWav(bytes: ArrayBuffer): boolean {
  const planar = decodeWavPlanar(new Uint8Array(bytes));
  return planar !== null && planar.frames > 0;
}
