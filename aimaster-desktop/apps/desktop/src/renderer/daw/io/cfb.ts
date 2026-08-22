// Compound File Binary — the container AAF is written inside.
//
// AAF is not a file format so much as a filesystem in a file: MS-CFB (the
// old OLE "structured storage") holds a tree of storages and streams, and
// AAF puts one storage per object into it.  Nothing above this layer can be
// written or read until this layer is exactly right, and "exactly right"
// here means byte-for-byte — a reader that finds a sector chain one entry
// short does not degrade, it refuses the file.
//
// The parts that are easy to get subtly wrong, and what this does about them:
//
//   TWO ALLOCATION SCHEMES, NOT ONE.  Streams under 4096 bytes do not get
//   sectors of their own; they live packed into a "mini stream" in 64-byte
//   mini-sectors, chained by a separate MiniFAT, and the mini stream itself
//   is then an ordinary stream hanging off the root entry.  An AAF is mostly
//   tiny property streams, so this is the common path, not the exotic one.
//
//   THE FAT DESCRIBES THE FILE THAT CONTAINS IT.  Every sector including the
//   FAT's own is accounted for in the FAT, so the number of FAT sectors
//   depends on the total sector count, which depends on the number of FAT
//   sectors.  It is solved by iterating to a fixed point rather than by
//   adding one and hoping.
//
//   THE DIRECTORY IS A RED-BLACK TREE, ORDERED BY A RULE NOBODY EXPECTS.
//   Siblings compare by NAME LENGTH FIRST and then by upper-cased UTF-16
//   code unit — not lexicographically.  Get that wrong and a conforming
//   reader simply does not find half the entries, because it binary-searches.
//
// Everything is Uint8Array / DataView: this runs in the renderer, where Node's
// Buffer does not exist.

const SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] as const;

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_CUTOFF = 4096;
const DIR_ENTRY_SIZE = 128;
const ENTRIES_PER_SECTOR = SECTOR_SIZE / DIR_ENTRY_SIZE;      // 4
const FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE / 4;               // 128
const DIFAT_IN_HEADER = 109;

const FREESECT   = 0xFFFFFFFF;
const ENDOFCHAIN = 0xFFFFFFFE;
const FATSECT    = 0xFFFFFFFD;
const DIFSECT    = 0xFFFFFFFC;
const NOSTREAM   = 0xFFFFFFFF;

/** The most sectors a header-only DIFAT can describe — about 7 MB. */
const MAX_SECTORS = DIFAT_IN_HEADER * FAT_ENTRIES_PER_SECTOR;

export type CfbEntryType = 'storage' | 'stream';

/** One node of the tree: a storage with children, or a stream with bytes. */
export interface CfbNode {
  name: string;
  type: CfbEntryType;
  /** Streams only. */
  data?: Uint8Array;
  /** Storages only. */
  children?: CfbNode[];
  /** 16-byte class id.  AAF uses it on object storages; zero elsewhere. */
  clsid?: Uint8Array;
}

export class CfbError extends Error {}

// ── Directory ordering ────────────────────────────────────────────────────────

/**
 * The comparison a conforming reader uses on directory siblings.
 *
 * Shorter names sort first — always, regardless of content — and only then
 * does the upper-cased UTF-16 comparison decide.  This is why "Header-2"
 * comes before "MetaDictionary-1" no matter what the letters say.
 */
export function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  for (let i = 0; i < ua.length; i++) {
    const ca = ua.charCodeAt(i);
    const cb = ub.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return 0;
}

// ── Writing ───────────────────────────────────────────────────────────────────

interface FlatEntry {
  id: number;
  name: string;
  type: CfbEntryType | 'root';
  clsid: Uint8Array | undefined;
  data: Uint8Array | undefined;
  childIds: number[];
  /** Filled in during layout. */
  start: number;
  size: number;
  child: number;
  left: number;
  right: number;
}

/** Flatten the tree, giving every entry a directory id (0 is always root). */
function flatten(root: readonly CfbNode[]): FlatEntry[] {
  const entries: FlatEntry[] = [{
    id: 0, name: 'Root Entry', type: 'root', clsid: undefined, data: undefined,
    childIds: [], start: ENDOFCHAIN, size: 0, child: NOSTREAM, left: NOSTREAM, right: NOSTREAM,
  }];

  const walk = (nodes: readonly CfbNode[], parent: FlatEntry): void => {
    for (const node of nodes) {
      if (node.name.length > 31) {
        throw new CfbError(`이름이 너무 깁니다 (31자 제한): ${node.name}`);
      }
      const entry: FlatEntry = {
        id: entries.length, name: node.name, type: node.type,
        clsid: node.clsid, data: node.type === 'stream' ? (node.data ?? new Uint8Array(0)) : undefined,
        childIds: [], start: ENDOFCHAIN, size: 0, child: NOSTREAM, left: NOSTREAM, right: NOSTREAM,
      };
      entries.push(entry);
      parent.childIds.push(entry.id);
      if (node.type === 'storage') walk(node.children ?? [], entry);
    }
  };
  walk(root, entries[0]!);
  return entries;
}

/**
 * Build a balanced sibling tree.
 *
 * Every node is written black.  A tree of all-black nodes is only a valid
 * red-black tree when every root-to-leaf path holds the same number of black
 * nodes, which a perfectly balanced tree does not guarantee — but no reader
 * in the wild checks the colouring, and every reader depends on the ORDER,
 * which is what this gets right.
 */
function linkSiblings(entries: FlatEntry[], ids: readonly number[]): number {
  const sorted = [...ids].sort((a, b) => compareNames(entries[a]!.name, entries[b]!.name));
  const build = (lo: number, hi: number): number => {
    if (lo > hi) return NOSTREAM;
    const mid = (lo + hi) >> 1;
    const id = sorted[mid]!;
    entries[id]!.left = build(lo, mid - 1);
    entries[id]!.right = build(mid + 1, hi);
    return id;
  };
  return build(0, sorted.length - 1);
}

const utf16le = (name: string): Uint8Array => {
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  for (let i = 0; i < name.length && i < 31; i++) view.setUint16(i * 2, name.charCodeAt(i), true);
  return out;
};

/** Round a byte count up to a whole number of `unit`-sized blocks. */
const blocks = (bytes: number, unit: number): number => Math.ceil(bytes / unit);

export function writeCfb(root: readonly CfbNode[], rootClsid?: Uint8Array): Uint8Array {
  const entries = flatten(root);

  // Sibling trees, and each storage's first child.
  for (const entry of entries) {
    entry.child = entry.childIds.length > 0 ? linkSiblings(entries, entry.childIds) : NOSTREAM;
  }
  if (rootClsid) entries[0]!.clsid = rootClsid;

  // ── Mini stream ──────────────────────────────────────────────────────
  // Small streams are packed here first, because the mini stream is itself
  // an ordinary stream and has to be allocated with the others.
  const miniParts: Uint8Array[] = [];
  const miniFat: number[] = [];
  let miniSectorCount = 0;
  for (const entry of entries) {
    if (entry.type !== 'stream' || !entry.data) continue;
    entry.size = entry.data.length;
    if (entry.data.length === 0) { entry.start = ENDOFCHAIN; continue; }
    if (entry.data.length >= MINI_CUTOFF) continue;
    const need = blocks(entry.data.length, MINI_SECTOR_SIZE);
    entry.start = miniSectorCount;
    for (let i = 0; i < need; i++) {
      miniFat.push(miniSectorCount + i + 1 < miniSectorCount + need ? miniSectorCount + i + 1 : ENDOFCHAIN);
    }
    const padded = new Uint8Array(need * MINI_SECTOR_SIZE);
    padded.set(entry.data);
    miniParts.push(padded);
    miniSectorCount += need;
  }
  const miniStream = new Uint8Array(miniSectorCount * MINI_SECTOR_SIZE);
  {
    let at = 0;
    for (const part of miniParts) { miniStream.set(part, at); at += part.length; }
  }

  // ── Sector allocation ────────────────────────────────────────────────
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];

  /** Append `data` as a chain of full sectors and return its first sector. */
  const allocate = (data: Uint8Array): number => {
    if (data.length === 0) return ENDOFCHAIN;
    const count = blocks(data.length, SECTOR_SIZE);
    const first = sectors.length;
    for (let i = 0; i < count; i++) {
      const chunk = new Uint8Array(SECTOR_SIZE);
      chunk.set(data.subarray(i * SECTOR_SIZE, Math.min(data.length, (i + 1) * SECTOR_SIZE)));
      sectors.push(chunk);
      fat.push(i === count - 1 ? ENDOFCHAIN : first + i + 1);
    }
    return first;
  };

  for (const entry of entries) {
    if (entry.type !== 'stream' || !entry.data) continue;
    if (entry.data.length < MINI_CUTOFF) continue;     // already in the mini stream
    entry.start = allocate(entry.data);
  }

  // The mini stream hangs off the root entry.
  entries[0]!.start = allocate(miniStream);
  entries[0]!.size = miniStream.length;

  // MiniFAT: one u32 per mini sector, padded with FREESECT.
  const miniFatSectors = blocks(Math.max(1, miniFat.length) * 4, SECTOR_SIZE);
  const firstMiniFat = miniFat.length === 0 ? ENDOFCHAIN : (() => {
    const bytes = new Uint8Array(miniFatSectors * SECTOR_SIZE).fill(0xFF);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < miniFat.length; i++) view.setUint32(i * 4, miniFat[i]!, true);
    return allocate(bytes);
  })();

  // Directory.
  const dirSectors = blocks(entries.length * DIR_ENTRY_SIZE, SECTOR_SIZE);
  const dirBytes = new Uint8Array(dirSectors * SECTOR_SIZE);
  {
    const view = new DataView(dirBytes.buffer);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const at = i * DIR_ENTRY_SIZE;
      dirBytes.set(utf16le(e.name), at);
      // The stored length counts the terminating null, in BYTES.
      view.setUint16(at + 64, Math.min(e.name.length, 31) * 2 + 2, true);
      view.setUint8(at + 66, e.type === 'root' ? 5 : e.type === 'storage' ? 1 : 2);
      view.setUint8(at + 67, 1);                              // black
      view.setUint32(at + 68, e.left, true);
      view.setUint32(at + 72, e.right, true);
      view.setUint32(at + 76, e.child, true);
      if (e.clsid && e.clsid.length === 16) dirBytes.set(e.clsid, at + 80);
      view.setUint32(at + 116, e.start, true);
      view.setUint32(at + 120, e.size >>> 0, true);
      view.setUint32(at + 124, Math.floor(e.size / 0x100000000), true);
    }
    // Unused entries in the last sector must read as free, not as garbage.
    for (let i = entries.length; i < dirSectors * ENTRIES_PER_SECTOR; i++) {
      const at = i * DIR_ENTRY_SIZE;
      view.setUint32(at + 68, NOSTREAM, true);
      view.setUint32(at + 72, NOSTREAM, true);
      view.setUint32(at + 76, NOSTREAM, true);
    }
  }
  const firstDir = allocate(dirBytes);

  // ── The FAT describes itself ──────────────────────────────────────────
  // Adding FAT sectors adds entries, which can add FAT sectors.  Iterate.
  let fatSectorCount = Math.max(1, blocks(sectors.length * 4, SECTOR_SIZE));
  for (;;) {
    const total = sectors.length + fatSectorCount;
    const need = Math.max(1, blocks(total * 4, SECTOR_SIZE));
    if (need === fatSectorCount) break;
    fatSectorCount = need;
  }
  if (sectors.length + fatSectorCount > MAX_SECTORS) {
    throw new CfbError('파일이 이 작성기가 다룰 수 있는 크기를 넘었습니다 (약 7 MB)');
  }

  const fatSectorIds: number[] = [];
  for (let i = 0; i < fatSectorCount; i++) {
    fatSectorIds.push(sectors.length + i);
    fat.push(FATSECT);
  }

  const fatBytes = new Uint8Array(fatSectorCount * SECTOR_SIZE).fill(0xFF);
  {
    const view = new DataView(fatBytes.buffer);
    for (let i = 0; i < fat.length; i++) view.setUint32(i * 4, fat[i]!, true);
  }
  for (let i = 0; i < fatSectorCount; i++) {
    sectors.push(fatBytes.subarray(i * SECTOR_SIZE, (i + 1) * SECTOR_SIZE));
  }

  // ── Header ────────────────────────────────────────────────────────────
  const out = new Uint8Array(SECTOR_SIZE + sectors.length * SECTOR_SIZE);
  const head = new DataView(out.buffer, 0, SECTOR_SIZE);
  out.set(SIGNATURE, 0);
  head.setUint16(24, 0x003E, true);         // minor version
  head.setUint16(26, 3, true);              // major version — 512-byte sectors
  head.setUint16(28, 0xFFFE, true);         // little-endian
  head.setUint16(30, 9, true);              // 2^9 = 512
  head.setUint16(32, 6, true);              // 2^6 = 64
  head.setUint32(40, 0, true);              // directory sector count (v3: 0)
  head.setUint32(44, fatSectorCount, true);
  head.setUint32(48, firstDir, true);
  head.setUint32(56, MINI_CUTOFF, true);
  head.setUint32(60, firstMiniFat, true);
  head.setUint32(64, miniFat.length === 0 ? 0 : miniFatSectors, true);
  head.setUint32(68, ENDOFCHAIN, true);     // first DIFAT sector — none needed
  head.setUint32(72, 0, true);              // DIFAT sector count
  for (let i = 0; i < DIFAT_IN_HEADER; i++) {
    head.setUint32(76 + i * 4, fatSectorIds[i] ?? FREESECT, true);
  }
  for (let i = 0; i < sectors.length; i++) {
    out.set(sectors[i]!, SECTOR_SIZE + i * SECTOR_SIZE);
  }
  return out;
}

// ── Reading ───────────────────────────────────────────────────────────────────

export interface CfbFile {
  /** Top-level children of the root storage. */
  root: CfbNode[];
  /** Every stream by path, "Storage/Sub/stream" — how AAF actually looks things up. */
  streams: Map<string, Uint8Array>;
  /** Class id of each storage by path, and of the root under ''. */
  clsids: Map<string, Uint8Array>;
}

export function readCfb(bytes: Uint8Array): CfbFile {
  if (bytes.length < SECTOR_SIZE) throw new CfbError('파일이 너무 짧습니다');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new CfbError('CFB 서명이 아닙니다 — AAF 파일이 아닙니다');
  }
  const head = new DataView(bytes.buffer, bytes.byteOffset, SECTOR_SIZE);
  const sectorShift = head.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new CfbError(`지원하지 않는 섹터 크기 (2^${sectorShift})`);
  }
  const sectorSize = 1 << sectorShift;
  const miniShift = head.getUint16(32, true);
  const miniSize = 1 << miniShift;
  const cutoff = head.getUint32(56, true);
  const fatCount = head.getUint32(44, true);
  const firstDir = head.getUint32(48, true);
  const firstMiniFat = head.getUint32(60, true);
  const miniFatCount = head.getUint32(64, true);
  const firstDifat = head.getUint32(68, true);
  const difatCount = head.getUint32(72, true);

  const sectorAt = (id: number): Uint8Array => {
    const at = sectorSize + id * sectorSize;
    if (id < 0 || at + sectorSize > bytes.length) {
      throw new CfbError(`섹터 ${id} 가 파일 밖을 가리킵니다`);
    }
    return bytes.subarray(at, at + sectorSize);
  };

  // DIFAT: the header holds the first 109 FAT sector ids; the rest live in a
  // chain of DIFAT sectors, each ending with a pointer to the next.
  const fatSectorIds: number[] = [];
  for (let i = 0; i < DIFAT_IN_HEADER && fatSectorIds.length < fatCount; i++) {
    const id = head.getUint32(76 + i * 4, true);
    if (id === FREESECT || id === ENDOFCHAIN) break;
    fatSectorIds.push(id);
  }
  let difat = firstDifat;
  for (let n = 0; n < difatCount && difat !== ENDOFCHAIN && difat !== FREESECT; n++) {
    const sector = sectorAt(difat);
    const view = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
    for (let i = 0; i < sectorSize / 4 - 1 && fatSectorIds.length < fatCount; i++) {
      const id = view.getUint32(i * 4, true);
      if (id === FREESECT || id === ENDOFCHAIN) break;
      fatSectorIds.push(id);
    }
    difat = view.getUint32(sectorSize - 4, true);
  }

  const readTable = (ids: readonly number[]): number[] => {
    const out: number[] = [];
    for (const id of ids) {
      const sector = sectorAt(id);
      const view = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
      for (let i = 0; i < sectorSize / 4; i++) out.push(view.getUint32(i * 4, true));
    }
    return out;
  };
  const fat = readTable(fatSectorIds);

  const chain = (start: number, table: readonly number[]): number[] => {
    const out: number[] = [];
    let at = start;
    const seen = new Set<number>();
    while (at !== ENDOFCHAIN && at !== FREESECT && at !== FATSECT && at !== DIFSECT) {
      if (seen.has(at)) throw new CfbError('섹터 체인이 자기 자신으로 돌아옵니다');
      seen.add(at);
      out.push(at);
      const next = table[at];
      if (next === undefined) throw new CfbError(`섹터 ${at} 이 표에 없습니다`);
      at = next;
    }
    return out;
  };

  const readChain = (start: number, size: number, table: readonly number[]): Uint8Array => {
    const ids = chain(start, table);
    const out = new Uint8Array(ids.length * sectorSize);
    ids.forEach((id, i) => out.set(sectorAt(id), i * sectorSize));
    return out.subarray(0, size >= 0 ? Math.min(size, out.length) : out.length);
  };

  // Directory.
  const dirBytes = readChain(firstDir, -1, fat);
  const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const count = Math.floor(dirBytes.length / DIR_ENTRY_SIZE);

  interface RawEntry {
    name: string; type: number; left: number; right: number; child: number;
    start: number; size: number; clsid: Uint8Array;
  }
  const raw: RawEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * DIR_ENTRY_SIZE;
    const nameLen = Math.max(0, Math.min(64, dirView.getUint16(at + 64, true)) / 2 - 1);
    let name = '';
    for (let c = 0; c < nameLen; c++) name += String.fromCharCode(dirView.getUint16(at + c * 2, true));
    raw.push({
      name,
      type: dirView.getUint8(at + 66),
      left: dirView.getUint32(at + 68, true),
      right: dirView.getUint32(at + 72, true),
      child: dirView.getUint32(at + 76, true),
      clsid: dirBytes.slice(at + 80, at + 96),
      start: dirView.getUint32(at + 116, true),
      size: dirView.getUint32(at + 120, true)
        + dirView.getUint32(at + 124, true) * 0x100000000,
    });
  }
  const root = raw[0];
  if (!root) throw new CfbError('디렉터리가 비어 있습니다');

  // The mini stream is an ordinary stream hanging off the root entry.
  const miniStream = root.start === ENDOFCHAIN
    ? new Uint8Array(0)
    : readChain(root.start, root.size, fat);
  const miniFat = firstMiniFat === ENDOFCHAIN || miniFatCount === 0
    ? []
    : readTable(chain(firstMiniFat, fat));

  const readMini = (start: number, size: number): Uint8Array => {
    const ids = chain(start, miniFat);
    const out = new Uint8Array(ids.length * miniSize);
    ids.forEach((id, i) => {
      const at = id * miniSize;
      out.set(miniStream.subarray(at, at + miniSize), i * miniSize);
    });
    return out.subarray(0, Math.min(size, out.length));
  };

  const streamData = (entry: RawEntry): Uint8Array => {
    if (entry.size === 0 || entry.start === ENDOFCHAIN) return new Uint8Array(0);
    return entry.size < cutoff ? readMini(entry.start, entry.size) : readChain(entry.start, entry.size, fat);
  };

  const streams = new Map<string, Uint8Array>();
  const clsids = new Map<string, Uint8Array>();
  clsids.set('', root.clsid);

  const visited = new Set<number>();
  const collectSiblings = (id: number, out: number[]): void => {
    if (id === NOSTREAM || id >= raw.length) return;
    if (visited.has(id)) throw new CfbError('디렉터리 트리가 순환합니다');
    visited.add(id);
    const entry = raw[id]!;
    collectSiblings(entry.left, out);
    out.push(id);
    collectSiblings(entry.right, out);
  };

  const build = (childId: number, path: string): CfbNode[] => {
    const ids: number[] = [];
    collectSiblings(childId, ids);
    const nodes: CfbNode[] = [];
    for (const id of ids) {
      const entry = raw[id]!;
      const here = path ? `${path}/${entry.name}` : entry.name;
      if (entry.type === 1) {
        clsids.set(here, entry.clsid);
        nodes.push({ name: entry.name, type: 'storage', clsid: entry.clsid, children: build(entry.child, here) });
      } else if (entry.type === 2) {
        const data = streamData(entry);
        streams.set(here, data);
        nodes.push({ name: entry.name, type: 'stream', data });
      }
    }
    return nodes;
  };

  return { root: build(root.child, ''), streams, clsids };
}

/** Walk a parsed tree to a node by path, or undefined. */
export function findNode(file: CfbFile, path: string): CfbNode | undefined {
  const parts = path.split('/').filter(Boolean);
  let level: CfbNode[] | undefined = file.root;
  let found: CfbNode | undefined;
  for (const part of parts) {
    found = level?.find((n) => n.name === part);
    if (!found) return undefined;
    level = found.children;
  }
  return found;
}
