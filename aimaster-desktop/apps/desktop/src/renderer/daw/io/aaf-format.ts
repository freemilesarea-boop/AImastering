// AAF's object layer — the part that sits inside the CFB container.
//
// AAF stores an object graph the way a filesystem stores a directory tree:
// one CFB storage per object, holding a `properties` stream that lists the
// object's properties by numeric id, and sub-storages for the objects it
// owns.  Reading it is therefore not parsing a file so much as walking a
// small database, and the three things that make it walkable are here.
//
//   THE PROPERTY STREAM.  A four-byte header (byte order, format version,
//   entry count), then one six-byte entry per property (id, stored form,
//   byte length), then all the values end to end in the same order.  Every
//   value's meaning comes from its property id and its stored form; the type
//   is not in the file.
//
//   NAMES CARRY THE STRUCTURE.  A strong reference's value is the NAME of
//   the child storage that holds the object — "Header-2", where 2 is the
//   property id.  A collection's value is a base name, and its members are
//   "Mobs-1901{0}", "Mobs-1901{1}", listed in a companion "… index" stream.
//   This is why an AAF can be navigated at all without its meta-dictionary:
//   the shape is in the directory.
//
//   THE CLASS IS THE STORAGE'S CLSID.  Sixteen bytes on the directory entry,
//   which is how a Sequence is told from a SourceClip without a dictionary
//   lookup.
//
// What is NOT here: the meta-dictionary, essence data, and everything about
// video.  This layer knows sound composition — the structure a picture
// editor sends a mixer — and says so when it meets something else.

import type { CfbFile } from './cfb.js';

export const SF_DATA = 0x82;
export const SF_DATA_STREAM = 0x42;
export const SF_STRONG_REF = 0x22;
export const SF_STRONG_REF_VECTOR = 0x32;
export const SF_STRONG_REF_SET = 0x3A;
export const SF_WEAK_REF = 0x02;
export const SF_UNIQUE_ID = 0x86;

export const PROPERTY_VERSION = 32;
const BYTE_ORDER_LE = 0x4C;

export class AafError extends Error {}

// ── Class ids ─────────────────────────────────────────────────────────────────

/**
 * An AUID as it is stored: the first three fields little-endian, the rest
 * as written.  Reading the sixteen bytes straight gives a string that
 * matches nothing, which is exactly the kind of mistake that shows up as
 * "this file has no compositions in it".
 */
export function auidFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 16) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const d1 = view.getUint32(0, true).toString(16).padStart(8, '0');
  const d2 = view.getUint16(4, true).toString(16).padStart(4, '0');
  const d3 = view.getUint16(6, true).toString(16).padStart(4, '0');
  const rest = [...bytes.subarray(8, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${d1}-${d2}-${d3}-${rest.slice(0, 4)}-${rest.slice(4)}`;
}

export function auidToBytes(auid: string): Uint8Array {
  const clean = auid.replace(/-/g, '');
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, parseInt(clean.slice(0, 8), 16) >>> 0, true);
  view.setUint16(4, parseInt(clean.slice(8, 12), 16), true);
  view.setUint16(6, parseInt(clean.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) out[8 + i] = parseInt(clean.slice(16 + i * 2, 18 + i * 2), 16);
  return out;
}

/** Class AUIDs, canonical form — compare with `auidFromBytes`. */
export const CLASS = {
  Header:           '0d010101-0101-2f00-060e-2b3402060101',
  ContentStorage:   '0d010101-0101-1800-060e-2b3402060101',
  CompositionMob:   '0d010101-0101-3500-060e-2b3402060101',
  MasterMob:        '0d010101-0101-3600-060e-2b3402060101',
  SourceMob:        '0d010101-0101-3700-060e-2b3402060101',
  TimelineMobSlot:  '0d010101-0101-3b00-060e-2b3402060101',
  Sequence:         '0d010101-0101-0f00-060e-2b3402060101',
  SourceClip:       '0d010101-0101-1100-060e-2b3402060101',
  Filler:           '0d010101-0101-0900-060e-2b3402060101',
  Transition:       '0d010101-0101-1700-060e-2b3402060101',
  OperationGroup:   '0d010101-0101-0a00-060e-2b3402060101',
  Timecode:         '0d010101-0101-1400-060e-2b3402060101',
  EssenceGroup:     '0d010101-0101-0500-060e-2b3402060101',
  WAVEDescriptor:   '0d010101-0101-2c00-060e-2b3402060101',
  PCMDescriptor:    '0d010101-0101-4800-060e-2b3402060101',
  NetworkLocator:   '0d010101-0101-3200-060e-2b3402060101',
} as const;

/** The mob usage that marks the sequence a mixer actually wants. */
export const USAGE_TOP_LEVEL = '0d010102-0101-0700-060e-2b3404010101';

/** Property ids, by the object that owns them. */
export const PID = {
  // Root
  MetaDictionary: 0x0001,
  Header: 0x0002,
  // Header
  Content: 0x3b03,
  Dictionary: 0x3b04,
  // ContentStorage
  Mobs: 0x1901,
  // Mob
  MobID: 0x4401,
  MobName: 0x4402,
  Slots: 0x4403,
  UsageCode: 0x4408,
  // MobSlot
  SlotID: 0x4801,
  SlotName: 0x4802,
  Segment: 0x4803,
  PhysicalTrackNumber: 0x4804,
  // TimelineMobSlot
  EditRate: 0x4b01,
  Origin: 0x4b02,
  // Component
  DataDefinition: 0x0201,
  Length: 0x0202,
  // Sequence
  Components: 0x1001,
  // SourceReference
  SourceID: 0x1101,
  SourceMobSlotID: 0x1102,
  // SourceClip
  StartTime: 0x1201,
  FadeInLength: 0x1202,
  FadeInType: 0x1203,
  FadeOutLength: 0x1204,
  FadeOutType: 0x1205,
  // SourceMob
  EssenceDescription: 0x4701,
  // EssenceDescriptor / FileDescriptor
  Locator: 0x2f01,
  SampleRate: 0x3001,
  EssenceLength: 0x3002,
  Summary: 0x3801,
  // NetworkLocator
  URLString: 0x4001,
  // Transition
  CutPoint: 0x1802,
} as const;

// ── Values ────────────────────────────────────────────────────────────────────

export interface AafProperty {
  pid: number;
  form: number;
  data: Uint8Array;
}

/** Decode a `properties` stream into its entries, in file order. */
export function decodeProperties(bytes: Uint8Array): AafProperty[] {
  if (bytes.length < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint8(0);
  if (order !== BYTE_ORDER_LE) {
    throw new AafError('빅엔디언 AAF 는 읽을 수 없습니다');
  }
  const count = view.getUint16(2, true);
  const entries: { pid: number; form: number; size: number }[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 6 > bytes.length) throw new AafError('속성 표가 스트림보다 깁니다');
    entries.push({
      pid: view.getUint16(at, true),
      form: view.getUint16(at + 2, true),
      size: view.getUint16(at + 4, true),
    });
    at += 6;
  }
  const out: AafProperty[] = [];
  for (const entry of entries) {
    const end = at + entry.size;
    if (end > bytes.length) throw new AafError(`속성 ${entry.pid.toString(16)} 의 값이 잘렸습니다`);
    out.push({ pid: entry.pid, form: entry.form, data: bytes.subarray(at, end) });
    at = end;
  }
  return out;
}

export function encodeProperties(props: readonly AafProperty[]): Uint8Array {
  const total = 4 + props.length * 6 + props.reduce((n, p) => n + p.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, BYTE_ORDER_LE);
  view.setUint8(1, PROPERTY_VERSION);
  view.setUint16(2, props.length, true);
  let at = 4;
  for (const p of props) {
    view.setUint16(at, p.pid, true);
    view.setUint16(at + 2, p.form, true);
    view.setUint16(at + 4, p.data.length, true);
    at += 6;
  }
  for (const p of props) { out.set(p.data, at); at += p.data.length; }
  return out;
}

/** UTF-16LE, null-terminated — how AAF stores every string. */
export function decodeString(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = view.getUint16(i, true);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

export function encodeString(text: string): Uint8Array {
  const out = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

export function decodeInt64(bytes: Uint8Array): number {
  if (bytes.length < 8) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Sample counts, not arbitrary integers: a 64-bit value beyond 2^53 would
  // be more audio than exists, so Number is the honest type here.
  return Number(view.getBigInt64(0, true));
}

export function encodeInt64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(Math.round(value)), true);
  return out;
}

export function decodeUint32(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

export function encodeUint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export interface Rational { numerator: number; denominator: number }

export function decodeRational(bytes: Uint8Array): Rational {
  if (bytes.length < 8) return { numerator: 0, denominator: 1 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const denominator = view.getInt32(4, true);
  return { numerator: view.getInt32(0, true), denominator: denominator === 0 ? 1 : denominator };
}

export function encodeRational(r: Rational): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setInt32(0, Math.round(r.numerator), true);
  view.setInt32(4, Math.round(r.denominator), true);
  return out;
}

export const rationalToNumber = (r: Rational): number =>
  (r.denominator === 0 ? 0 : r.numerator / r.denominator);

/**
 * A weak reference's target key.
 *
 * Not just an AUID sitting in the property: the value is an index into the
 * file's weak-reference table, then the target's property id and key size,
 * and only THEN the sixteen bytes that identify the thing.  Reading the
 * first sixteen bytes instead gives a plausible-looking AUID that matches
 * nothing — which is how every component in a file comes back as neither
 * sound nor picture.
 */
export function decodeWeakRef(bytes: Uint8Array): string {
  if (bytes.length < 5) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keySize = view.getUint8(4);
  if (keySize !== 16 || bytes.length < 5 + keySize) return '';
  return auidFromBytes(bytes.subarray(5, 21));
}

export const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A CLSID as written in the directory entry — the class of an AAF object. */
export const clsidHex = (file: CfbFile, path: string): string =>
  auidFromBytes(file.clsids.get(path) ?? new Uint8Array(16));

// ── Collections ───────────────────────────────────────────────────────────────

/**
 * The child storage names of a strong-reference VECTOR, in order.
 *
 * Order is the whole point for a vector — a sequence's components are a
 * timeline — and it lives in the index stream, not in the directory, whose
 * ordering rule is alphabetical-by-length and says nothing about time.
 */
export function vectorMembers(
  file: CfbFile, parentPath: string, indexName: string,
): string[] {
  const index = file.streams.get(join(parentPath, `${indexName} index`));
  if (!index) return [];
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const count = view.getUint32(0, true);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 4;
    if (at + 4 > index.length) break;
    out.push(join(parentPath, `${indexName}{${view.getUint32(at, true).toString(16)}}`));
  }
  return out;
}

/**
 * The child storage names of a strong-reference SET.
 *
 * A set's index carries a unique key per member as well as the local one —
 * for Mobs that key is the MobID, which is what a SourceClip points at.
 */
export function setMembers(
  file: CfbFile, parentPath: string, indexName: string,
): { path: string; key: Uint8Array }[] {
  const index = file.streams.get(join(parentPath, `${indexName} index`));
  if (!index) return [];
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const count = view.getUint32(0, true);
  const keySize = view.getUint8(14);
  if (keySize !== 16 && keySize !== 32) return [];
  const out: { path: string; key: Uint8Array }[] = [];
  // Each entry is local key, REFERENCE COUNT, then the unique key.  The
  // middle field is always 1 in practice and is easy not to notice, which
  // makes every entry after the first land on a storage that is not there.
  const stride = 4 + 4 + keySize;
  let at = 15;
  for (let i = 0; i < count; i++) {
    if (at + stride > index.length) break;
    const local = view.getUint32(at, true);
    out.push({
      path: join(parentPath, `${indexName}{${local.toString(16)}}`),
      key: index.subarray(at + 8, at + 8 + keySize),
    });
    at += stride;
  }
  return out;
}

/**
 * The members of whatever kind of collection a property is.
 *
 * Vectors and sets look identical from the outside — a base name and a
 * companion index — and their index streams are laid out differently.  The
 * stored form in the property entry is the only thing that says which, so
 * reading it is not optional: treating a vector as a set finds one member
 * and then walks off into storages that do not exist.
 */
export function collectionMembers(
  file: CfbFile, parentPath: string, props: Map<number, AafProperty>, pid: number,
): { path: string; key: Uint8Array | null }[] {
  const prop = props.get(pid);
  if (!prop) return [];
  const name = decodeString(prop.data);
  if (!name) return [];
  if (prop.form === SF_STRONG_REF_SET) {
    return setMembers(file, parentPath, name).map((m) => ({ path: m.path, key: m.key }));
  }
  if (prop.form === SF_STRONG_REF_VECTOR) {
    return vectorMembers(file, parentPath, name).map((path) => ({ path, key: null }));
  }
  return [];
}

export const join = (base: string, name: string): string => (base ? `${base}/${name}` : name);

/** Every property of the object at `path`, by property id. */
export function objectProperties(file: CfbFile, path: string): Map<number, AafProperty> {
  const stream = file.streams.get(join(path, 'properties'));
  const out = new Map<number, AafProperty>();
  if (!stream) return out;
  for (const p of decodeProperties(stream)) out.set(p.pid, p);
  return out;
}

/** Follow a single strong reference, returning the child object's path. */
export function strongRef(
  props: Map<number, AafProperty>, pid: number, path: string,
): string | null {
  const prop = props.get(pid);
  if (!prop || prop.form !== SF_STRONG_REF) return null;
  const name = decodeString(prop.data);
  return name ? join(path, name) : null;
}

/** The index base name of a collection property, or null when absent. */
export function collectionName(props: Map<number, AafProperty>, pid: number): string | null {
  const prop = props.get(pid);
  if (!prop) return null;
  if (prop.form !== SF_STRONG_REF_VECTOR && prop.form !== SF_STRONG_REF_SET) return null;
  return decodeString(prop.data) || null;
}
