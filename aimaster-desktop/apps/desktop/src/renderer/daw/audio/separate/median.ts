// A running median that does not allocate.
//
// The separator medians a 4096-bin spectrogram twice — once along time, once
// along frequency — which for a four-minute song is roughly 46 million window
// evaluations.  Sorting a fresh array at each of them is not an option, so the
// window is kept sorted in place and each step removes one value and inserts
// one.  Both are a `copyWithin` over at most `width` floats, which is a few
// nanoseconds and, crucially, no garbage.
//
// Edges replicate: a window that runs off the end is filled with the first or
// last value.  That is the same thing SciPy's `mode='nearest'` does, and unlike
// zero-padding it does not invent a silence that the mask would then read as a
// transient.

/** Median of `count` values read with `stride` from `at`, edges replicated. */
export function runningMedian(
  source: Float32Array, out: Float32Array,
  start: number, count: number, stride: number,
  width: number, scratch: Float32Array,
): void {
  const w = width % 2 === 0 ? width + 1 : width;   // odd, so the median is a value
  const half = w >> 1;
  const mid = half;

  if (count === 0) return;
  if (w <= 1 || count === 1) {
    for (let i = 0; i < count; i++) out[start + i * stride] = source[start + i * stride] ?? 0;
    return;
  }

  const at = (i: number): number => {
    const clamped = i < 0 ? 0 : i >= count ? count - 1 : i;
    return source[start + clamped * stride] ?? 0;
  };

  // Seed the window for output 0: samples −half … +half, edges replicated.
  for (let k = 0; k < w; k++) scratch[k] = at(k - half);
  insertionSort(scratch, w);
  out[start] = scratch[mid] ?? 0;

  for (let i = 1; i < count; i++) {
    remove(scratch, w, at(i - 1 - half));
    insert(scratch, w - 1, at(i + half));
    out[start + i * stride] = scratch[mid] ?? 0;
  }
}

function insertionSort(a: Float32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = a[i] ?? 0;
    let j = i - 1;
    while (j >= 0 && (a[j] ?? 0) > v) { a[j + 1] = a[j] ?? 0; j--; }
    a[j + 1] = v;
  }
}

/** Drop one occurrence of `value` from the sorted prefix `a[0..n)`. */
function remove(a: Float32Array, n: number, value: number): void {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = a[mid] ?? 0;
    if (v === value) { found = mid; break; }
    if (v < value) lo = mid + 1; else hi = mid - 1;
  }
  // Binary search lands on an equal value when there is one; `lo` is where it
  // would go otherwise.  A miss can only come from a NaN, and dropping the
  // nearest slot keeps the window the right size rather than corrupting it.
  const index = found >= 0 ? found : Math.min(lo, n - 1);
  a.copyWithin(index, index + 1, n);
}

/** Insert `value` into the sorted prefix `a[0..n)`, making it `n+1` long. */
function insert(a: Float32Array, n: number, value: number): void {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] ?? 0) < value) lo = mid + 1; else hi = mid;
  }
  a.copyWithin(lo + 1, lo, n);
  a[lo] = value;
}
