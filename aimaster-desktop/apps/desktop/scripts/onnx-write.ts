// Just enough ONNX to write a model, so the test suite can make its own.
//
// ── Why this is here instead of a committed .onnx ────────────────────────────
//
// The inference path needs a model to run against or it is what `au_host.mm`
// was before it was compiled: a design document with semicolons whose first
// real execution finds every bug at once.  So the suite makes one.
//
// The obvious way is a Python script and a checked-in binary.  Both were
// rejected: a binary blob in the tree is a thing nobody can review, and a test
// that regenerates it "if Python and onnx happen to be installed" is a test
// that can silently stop running — which this repository treats as worse than
// no test, because it reads as "checked and fine".
//
// ONNX is protobuf.  A model with three nodes is a few hundred bytes of it, and
// writing those bytes is smaller than the machinery for avoiding it.  It also
// means the loader and the writer are held by the same understanding of the
// format: if the field numbers here are wrong, the runtime says so immediately.
//
// This writes only what the test model needs.  It is not an ONNX library and
// should not grow into one.

/** Protobuf wire types used here. */
const VARINT = 0;
const LENGTH = 2;

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire);
}

function bytesField(field: number, value: Uint8Array): number[] {
  return [...tag(field, LENGTH), ...varint(value.length), ...value];
}

function stringField(field: number, value: string): number[] {
  return bytesField(field, new TextEncoder().encode(value));
}

function intField(field: number, value: number): number[] {
  return [...tag(field, VARINT), ...varint(value)];
}

function message(field: number, body: number[]): number[] {
  return bytesField(field, Uint8Array.from(body));
}

/** ONNX TensorProto.DataType.FLOAT. */
export const FLOAT = 1;

export interface Initializer {
  name: string;
  dims: number[];
  /** Float32 values, or int64 values when `int64` is set. */
  data: Float32Array | number[];
  int64?: boolean;
}

export interface Node {
  op: string;
  inputs: string[];
  outputs: string[];
  /** Integer-list attributes, which is all the test model needs. */
  ints?: Record<string, number[]>;
}

export interface ValueInfo {
  name: string;
  /** A number is a fixed dimension; a string is a named (dynamic) one. */
  dims: Array<number | string>;
}

function tensorProto(init: Initializer): number[] {
  const body: number[] = [];
  for (const d of init.dims) body.push(...intField(1, d));      // dims
  body.push(...intField(2, init.int64 === true ? 7 : FLOAT));   // data_type
  body.push(...stringField(8, init.name));                      // name
  const raw = init.int64 === true
    ? int64Bytes(init.data as number[])
    : new Uint8Array(Float32Array.from(init.data as Float32Array).buffer);
  body.push(...bytesField(9, raw));                             // raw_data
  return body;
}

/** Little-endian int64s.  Values here are small, so the high word is zero. */
function int64Bytes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setBigInt64(i * 8, BigInt(values[i] ?? 0), true);
  return out;
}

function valueInfoProto(info: ValueInfo): number[] {
  const dims: number[] = [];
  for (const d of info.dims) {
    // TensorShapeProto.Dimension: dim_value(1) or dim_param(2)
    const dim = typeof d === 'number' ? intField(1, d) : stringField(2, d);
    dims.push(...message(1, dim));                              // shape.dim
  }
  const tensorType: number[] = [
    ...intField(1, FLOAT),                                      // elem_type
    ...message(2, dims),                                        // shape
  ];
  return [
    ...stringField(1, info.name),                               // name
    ...message(2, message(1, tensorType)),                      // type.tensor_type
  ];
}

function nodeProto(node: Node): number[] {
  const body: number[] = [];
  for (const i of node.inputs) body.push(...stringField(1, i));
  for (const o of node.outputs) body.push(...stringField(2, o));
  body.push(...stringField(4, node.op));                        // op_type
  for (const [name, values] of Object.entries(node.ints ?? {})) {
    const attr: number[] = [
      ...stringField(1, name),                                  // name
      ...intField(20, 7),                                       // type = INTS
    ];
    for (const v of values) attr.push(...intField(8, v));       // ints
    body.push(...message(5, attr));                             // attribute
  }
  return body;
}

export interface ModelSpec {
  name: string;
  nodes: Node[];
  initializers: Initializer[];
  inputs: ValueInfo[];
  outputs: ValueInfo[];
  /** ONNX opset.  13 is old enough to be universal and new enough for these ops. */
  opset?: number;
}

/** Serialise a model to the bytes an `InferenceSession` will accept. */
export function writeOnnx(spec: ModelSpec): Uint8Array {
  const graph: number[] = [];
  for (const n of spec.nodes) graph.push(...message(1, nodeProto(n)));
  graph.push(...stringField(2, spec.name));                     // name
  for (const i of spec.initializers) graph.push(...message(5, tensorProto(i)));
  for (const i of spec.inputs) graph.push(...message(11, valueInfoProto(i)));
  for (const o of spec.outputs) graph.push(...message(12, valueInfoProto(o)));

  const model: number[] = [
    ...intField(1, 9),                                          // ir_version
    ...stringField(2, 'loui'),                                  // producer_name
    ...message(7, graph),                                       // graph
    ...message(8, [...stringField(1, ''), ...intField(2, spec.opset ?? 13)]),
  ];
  return Uint8Array.from(model);
}
