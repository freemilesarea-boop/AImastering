// Radix-2 FFT.
//
// In-place, iterative, no allocations per call beyond the twiddle cache.
// Spectral editing runs thousands of transforms over a selection, so this is
// written to be reused rather than convenient: the caller owns the buffers.

/** Smallest power of two ≥ n. */
export function nextPow2(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

interface Twiddles {
  cos: Float64Array;
  sin: Float64Array;
  reverse: Uint32Array;
}

const cache = new Map<number, Twiddles>();

function twiddlesFor(size: number): Twiddles {
  const hit = cache.get(size);
  if (hit) return hit;

  const half = size >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const angle = (-2 * Math.PI * i) / size;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }

  // Bit-reversal permutation table.
  const bits = Math.log2(size) | 0;
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }

  const entry = { cos, sin, reverse };
  cache.set(size, entry);
  return entry;
}

/**
 * In-place complex FFT.  `inverse` runs the conjugate transform and scales by
 * 1/N, so `fft(x); fft(x, true)` returns the original.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const size = re.length;
  if (!isPow2(size) || im.length !== size) {
    throw new Error(`FFT size must be a power of two (got ${size})`);
  }
  const { cos, sin, reverse } = twiddlesFor(size);

  // Bit-reversal reorder.
  for (let i = 0; i < size; i++) {
    const j = reverse[i] ?? 0;
    if (j > i) {
      const tr = re[i] ?? 0; re[i] = re[j] ?? 0; re[j] = tr;
      const ti = im[i] ?? 0; im[i] = im[j] ?? 0; im[j] = ti;
    }
  }

  const sign = inverse ? -1 : 1;
  for (let span = 1; span < size; span <<= 1) {
    const step = size / (span << 1);
    for (let start = 0; start < size; start += span << 1) {
      for (let k = 0; k < span; k++) {
        const twiddleIndex = k * step;
        const wr = cos[twiddleIndex] ?? 1;
        const wi = (sin[twiddleIndex] ?? 0) * sign;
        const a = start + k;
        const b = a + span;
        const xr = re[b] ?? 0;
        const xi = im[b] ?? 0;
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
      }
    }
  }

  if (inverse) {
    const scale = 1 / size;
    for (let i = 0; i < size; i++) {
      re[i] = (re[i] ?? 0) * scale;
      im[i] = (im[i] ?? 0) * scale;
    }
  }
}

/** Periodic Hann window — the correct one for overlap-add analysis. */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

export function magnitude(re: number, im: number): number {
  return Math.sqrt(re * re + im * im);
}
