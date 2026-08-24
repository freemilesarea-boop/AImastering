// The model the suite runs the inference path against.
//
// A band split: three stems, each owning a slice of the spectrum, and the three
// masks summing to exactly 1 at every bin.  That is chosen so a test can check
// three separate things at once —
//
//   the runtime loaded and ran at all;
//   the data arrived the right way round (the bands are asymmetric, so a
//     frames/bins transpose cannot pass);
//   and the sum property the whole stem tree rests on survives a model.
//
// It is deliberately not a separator.  A test model that tried to be one would
// be judged on how well it separated, which is not what is being tested here.

import { writeOnnx, type ModelSpec } from './onnx-write.js';

export interface TestModelShape {
  bins: number;
  stems: number;
  channels: number;
}

/** Bin index where each stem's band starts — the last one runs to the top. */
export function bandEdgesFor(bins: number, stems: number): number[] {
  const edges: number[] = [];
  for (let s = 0; s < stems; s++) edges.push(Math.round((s * bins) / stems));
  return edges;
}

/** Which stem owns a bin, under the same split the model applies. */
export function stemOfBin(bin: number, bins: number, stems: number): number {
  const edges = bandEdgesFor(bins, stems);
  let owner = 0;
  for (let s = 0; s < stems; s++) if (bin >= (edges[s] ?? 0)) owner = s;
  return owner;
}

export function testModelBytes(shape: TestModelShape): Uint8Array {
  const { bins, stems, channels } = shape;
  // [1, stems, 1, 1, bins] so broadcasting against [1, 1, channels, frames,
  // bins] gives the output shape without needing to know `frames`.
  const band = new Float32Array(stems * bins);
  for (let b = 0; b < bins; b++) band[stemOfBin(b, bins, stems) * bins + b] = 1;

  const spec: ModelSpec = {
    name: 'bandsplit',
    inputs: [{ name: 'mix', dims: [1, channels, 'frames', bins] }],
    outputs: [{ name: 'masks', dims: [1, stems, channels, 'frames', bins] }],
    initializers: [
      { name: 'zero', dims: [1], data: new Float32Array([0]) },
      { name: 'band', dims: [1, stems, 1, 1, bins], data: band },
      { name: 'axis', dims: [1], data: [1], int64: true },
    ],
    nodes: [
      // Multiplying by zero is how `frames` gets into the output shape: it
      // comes from the data rather than from anything declared.
      { op: 'Mul', inputs: ['mix', 'zero'], outputs: ['zeros'] },
      { op: 'Unsqueeze', inputs: ['zeros', 'axis'], outputs: ['zeros5'] },
      { op: 'Add', inputs: ['zeros5', 'band'], outputs: ['masks'] },
    ],
  };
  return writeOnnx(spec);
}
