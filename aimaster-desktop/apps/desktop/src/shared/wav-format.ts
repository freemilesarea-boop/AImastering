// wav-format — read and write WAV, in either process, with no dependencies.
//
// # Why this exists
//
// Every audio path in the app went through an external `ffmpeg` binary to
// read a file, and through Chromium's media stack to play one. Both of those
// failed, in different ways, and neither failure looked like an error.
//
// **Reading.** ffmpeg is bundled into the packaged app, but in a development
// checkout it is only whatever happens to be on PATH — on a clean machine,
// nothing. A stem session then baked zero previews, started zero sources,
// and the play button did nothing while reporting success. "재생이 안된다."
//
// **Playing.** `AudioContext.decodeAudioData` hands the bytes to Chromium's
// media stack. Where that stack cannot bring up its audio decoder, the
// renderer does not reject the promise — it dies natively, exit code 11,
// with a black window and nothing in the console. Every WAV shape crashed
// it: 16-, 24- and 32-bit, mono and stereo, 44.1 and 48 kHz.
//
// A stem is WAV, and a preview is a file this app wrote itself seconds
// earlier. WAV is a header and a block of samples. Both sides read it here,
// from the same parser, so they cannot disagree about what a stem contains,
// and neither one needs a media framework to do it.
//
// Everything below works on plain `Uint8Array`s: the main process has
// `Buffer` (which is one) and the renderer does not.
//
// # Rate conversion
//
// A session bakes at one rate, and a 44.1 kHz stem in a 48 kHz session has
// to be converted. Linear interpolation is not good enough for a mastering
// tool — it is a first-order filter with an audible high-frequency droop,
// and it folds everything above the new Nyquist straight back into the band.
//
// So the conversion is polyphase windowed-sinc. The ratio between two
// integer sample rates is rational (44100/48000 = 147/160), so the filter
// has a finite number of distinct phases and each one is precomputed once.
// `wav-codec-selftest` measures what comes out: passband error, level, and
// how far down the alias is when a tone above the new Nyquist goes in. Each
// of those has a control that fails.

export interface WavInfo {
  channels: number;
  sampleRate: number;
  /** Bits per sample as stored. 32 with `float` set means IEEE float. */
  bitDepth: number;
  float: boolean;
  dataOffset: number;
  dataLength: number;
}

const FMT_PCM = 0x0001;
const FMT_FLOAT = 0x0003;
const FMT_EXTENSIBLE = 0xfffe;

function fourCC(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
}

/**
 * Parse a WAV header.
 *
 * Returns null rather than throwing for anything this file does not handle
 * — the caller's answer to that is to hand the file to ffmpeg, which is a
 * fallback and not an error.
 */
export function parseWavHeader(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  if (fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let pos = 12;
  let fmt: { channels: number; sampleRate: number; bitDepth: number; float: boolean } | null = null;

  while (pos + 8 <= bytes.length) {
    const id = fourCC(bytes, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;

    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return null;
      let tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitDepth = view.getUint16(body + 14, true);
      if (tag === FMT_EXTENSIBLE) {
        // The real format tag is the first two bytes of the subformat GUID.
        if (size < 40 || body + 26 > bytes.length) return null;
        tag = view.getUint16(body + 24, true);
      }
      if (tag !== FMT_PCM && tag !== FMT_FLOAT) return null;
      if (channels < 1 || sampleRate < 1) return null;
      fmt = { channels, sampleRate, bitDepth, float: tag === FMT_FLOAT };
    } else if (id === 'data') {
      if (!fmt) return null;
      // A `data` size of 0 or 0xFFFFFFFF is how a streamed WAV is written;
      // trust the file's length instead of the field.
      const available = bytes.length - body;
      const dataLength = size === 0 || size > available ? available : size;
      return { ...fmt, dataOffset: body, dataLength };
    }
    // Chunks are word-aligned; an odd size carries a pad byte.
    pos = body + size + (size % 2);
  }
  return null;
}

/** Read one stored sample as a float in [-1, 1]. Null for depths we decline. */
function reader(bytes: Uint8Array, info: WavInfo): ((offset: number) => number) | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (info.float) {
    if (info.bitDepth === 32) return (o) => view.getFloat32(o, true);
    if (info.bitDepth === 64) return (o) => view.getFloat64(o, true);
    return null;
  }
  switch (info.bitDepth) {
    // 8-bit WAV is unsigned and every other depth is signed. That asymmetry
    // is in the format, not a mistake here.
    case 8: return (o) => (bytes[o]! - 128) / 128;
    case 16: return (o) => view.getInt16(o, true) / 32768;
    case 24: return (o) => {
      const v = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
      // Sign-extend the 24-bit value into 32 bits.
      return ((v << 8) >> 8) / 8388608;
    };
    case 32: return (o) => view.getInt32(o, true) / 2147483648;
    default: return null;
  }
}

export interface WavPlanar {
  /** One Float32Array per channel, at the file's own sample rate. */
  channels: Float32Array[];
  sampleRate: number;
  frames: number;
}

/**
 * Decode a WAV to planar channels, at the rate it was written.
 *
 * This is the shape the renderer needs, and it deliberately does NOT
 * resample: an AudioBufferSourceNode converts a buffer's rate to the
 * context's on playback, so converting here would be a second conversion of
 * the same audio for no gain.
 */
export function decodeWavPlanar(bytes: Uint8Array): WavPlanar | null {
  const info = parseWavHeader(bytes);
  if (!info) return null;
  const read = reader(bytes, info);
  if (!read) return null;

  const width = info.bitDepth / 8;
  const frameBytes = width * info.channels;
  const frames = Math.max(0, Math.floor(info.dataLength / frameBytes));
  const channels: Float32Array[] = [];
  for (let c = 0; c < info.channels; c++) channels.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    const o = info.dataOffset + i * frameBytes;
    for (let c = 0; c < info.channels; c++) channels[c]![i] = read(o + c * width);
  }
  return { channels, sampleRate: info.sampleRate, frames };
}

/**
 * Decode a WAV to interleaved stereo at `targetRate`.
 *
 * Mono is duplicated to both sides rather than left on one, and more than
 * two channels keeps the first two: this app's pipeline is stereo end to
 * end, and a stem that arrives as 5.1 is a mistake to surface rather than
 * something to fold silently.
 *
 * Returns null when the file is not a WAV this decoder handles.
 */
export function decodeWavToFloatStereo(bytes: Uint8Array, targetRate: number): Float32Array | null {
  const planar = decodeWavPlanar(bytes);
  if (!planar) return null;
  const { channels, frames, sampleRate } = planar;
  const left = channels[0];
  if (!left) return null;
  const right = channels.length === 1 ? left : channels[1]!;

  const src = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    src[i * 2] = left[i]!;
    src[i * 2 + 1] = right[i]!;
  }
  if (sampleRate === targetRate) return src;
  return resampleInterleaved(src, 2, sampleRate, targetRate);
}

// ── Rate conversion ─────────────────────────────────────────────────────────

/**
 * Half-length of the sinc, in zero crossings of the *lower* of the two
 * rates. 24 puts the stopband of the Kaiser window used here below −100 dB,
 * which is under the noise floor of a 16-bit delivery and a long way under
 * a 24-bit one.
 */
const ZERO_CROSSINGS = 24;
const KAISER_BETA = 9.0;

function besselI0(x: number): number {
  // Series expansion. It converges quickly for the arguments a Kaiser window
  // uses, so the window is never the limiting factor in the result.
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 60; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  while (b !== 0) { const t = a % b; a = b; b = t; }
  return a;
}

interface Polyphase {
  /** `up` phases, each `taps` long. */
  table: Float32Array;
  taps: number;
  up: number;
  down: number;
}

/**
 * Build the filter for `from` → `to`.
 *
 * The cutoff is the lower of the two Nyquists, which is what makes one
 * filter both an interpolator (no images) and a decimator (no aliases).
 */
function buildPolyphase(from: number, to: number): Polyphase {
  const g = gcd(from, to);
  const up = to / g;
  const down = from / g;
  // Downsampling needs the sinc stretched by the ratio; that is what moves
  // the cutoff down to the new, lower Nyquist.
  const stretch = Math.max(1, down / up);
  const half = Math.ceil(ZERO_CROSSINGS * stretch);
  const taps = half * 2;
  const table = new Float32Array(up * taps);
  const i0beta = besselI0(KAISER_BETA);

  for (let phase = 0; phase < up; phase++) {
    // Where this output phase sits between two input samples.
    const frac = phase / up;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = (t - half + 1) - frac;
      const sx = x / stretch;
      const sinc = sx === 0 ? 1 : Math.sin(Math.PI * sx) / (Math.PI * sx);
      const w = x / half;
      const win = Math.abs(w) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - w * w)) / i0beta;
      const v = (sinc * win) / stretch;
      table[phase * taps + t] = v;
      sum += v;
    }
    // Normalise each phase to unity DC gain. Without this the phases differ
    // by a fraction of a dB and the conversion adds a faint whine at the
    // rate the phases cycle.
    if (sum !== 0) {
      const k = 1 / sum;
      for (let t = 0; t < taps; t++) table[phase * taps + t] = table[phase * taps + t]! * k;
    }
  }
  return { table, taps, up, down };
}

const filterCache = new Map<string, Polyphase>();

function polyphaseFor(from: number, to: number): Polyphase {
  const key = `${from}>${to}`;
  let f = filterCache.get(key);
  if (!f) { f = buildPolyphase(from, to); filterCache.set(key, f); }
  return f;
}

/**
 * Convert interleaved audio from one rate to another.
 *
 * Exported so the selftest can measure it directly rather than inferring its
 * behaviour from a decoded file.
 */
export function resampleInterleaved(
  src: Float32Array,
  channels: number,
  from: number,
  to: number,
): Float32Array {
  if (from === to || src.length === 0) return src;
  const f = polyphaseFor(from, to);
  const inFrames = Math.floor(src.length / channels);
  const outFrames = Math.max(0, Math.floor((inFrames * to) / from));
  const out = new Float32Array(outFrames * channels);
  const half = f.taps / 2;

  for (let n = 0; n < outFrames; n++) {
    // Output n sits at input position n * down / up.
    const num = n * f.down;
    const base = Math.floor(num / f.up);
    const phase = num - base * f.up;
    const row = phase * f.taps;
    for (let c = 0; c < channels; c++) {
      let acc = 0;
      for (let t = 0; t < f.taps; t++) {
        const i = base + t - half + 1;
        if (i < 0 || i >= inFrames) continue;
        acc += src[i * channels + c]! * f.table[row + t]!;
      }
      out[n * channels + c] = acc;
    }
  }
  return out;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Interleaved float → a WAV file's bytes.
 *
 * No dither and no limiting: by the time audio reaches here the chain has
 * already decided both, and a second stage of either would be a defect.
 * Samples are clamped, because a sample over full scale has to become
 * something and wrapping is the one answer that is always wrong.
 */
export function encodeWavBuffer(
  interleaved: Float32Array,
  sampleRate: number,
  bitDepth: 16 | 24 | 32,
  channels: number,
): Uint8Array {
  const width = bitDepth / 8;
  const dataLength = interleaved.length * width;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const ascii = (s: string, at: number): void => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };

  ascii('RIFF', 0);
  view.setUint32(4, 36 + dataLength, true);
  ascii('WAVE', 8);
  ascii('fmt ', 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? FMT_FLOAT : FMT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true);
  view.setUint16(34, bitDepth, true);
  ascii('data', 36);
  view.setUint32(40, dataLength, true);

  let o = 44;
  for (let i = 0; i < interleaved.length; i++) {
    const s = Math.max(-1, Math.min(1, interleaved[i]!));
    if (bitDepth === 32) {
      view.setFloat32(o, s, true);
    } else if (bitDepth === 16) {
      // Asymmetric scaling: +1.0 maps to 32767 and −1.0 to −32768, so full
      // scale in either direction lands on a real code.
      view.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true);
    } else {
      const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
      const u = v < 0 ? v + 0x1000000 : v;
      bytes[o] = u & 0xff;
      bytes[o + 1] = (u >> 8) & 0xff;
      bytes[o + 2] = (u >> 16) & 0xff;
    }
    o += width;
  }
  return bytes;
}
