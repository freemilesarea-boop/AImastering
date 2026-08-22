// Writing an AAF.
//
// The reader walks a graph; the writer has to BUILD one, and an AAF's graph
// is three mobs deep for every clip.  A single sound on a timeline is:
//
//   CompositionMob → TimelineMobSlot → Sequence → SourceClip
//        ↓ SourceID
//   MasterMob → TimelineMobSlot → SourceClip
//        ↓ SourceID
//   SourceMob → WAVEDescriptor → NetworkLocator("file:///…")
//
// The two mobs in the middle look like ceremony and are not.  The MasterMob
// is the name the receiving application shows in its bin; the SourceMob is
// the physical media.  Collapsing them — pointing the composition straight
// at a source mob — produces a file that opens with every clip offline.
//
// Media is LINKED, never embedded.  An AAF with essence inside it is a
// different and much larger format, and a mixer who receives one has to
// unpack it before they can work; a linked AAF beside a folder of WAVs is
// what post actually passes around.  This says so rather than pretending.

import { writeCfb, type CfbNode } from './cfb.js';
import {
  PID, SF_DATA, SF_STRONG_REF, SF_STRONG_REF_SET, SF_STRONG_REF_VECTOR,
  USAGE_TOP_LEVEL, auidToBytes, encodeInt64, encodeProperties, encodeRational,
  encodeString, encodeUint32,
} from './aaf-format.js';
import type { AafProperty } from './aaf-format.js';
import type { InterchangeSession } from './interchange.js';

/** The root object's class — the signature every AAF reader looks for first. */
const ROOT_CLASS = 'b3b398a5-1c90-11d4-8053-080036210804';
const AAF_FILE_KIND = '42464141-000d-4d4f-060e-2b34-01010102'.replace('-01010102', '') ;

const CLASS_AUID = {
  MetaDictionary:  '0d010101-0225-0000-060e-2b3402060101',
  DataDefinition:  '0d010101-0101-1b00-060e-2b3402060101',
  Header:          '0d010101-0101-2f00-060e-2b3402060101',
  ContentStorage:  '0d010101-0101-1800-060e-2b3402060101',
  Dictionary:      '0d010101-0101-2200-060e-2b3402060101',
  Identification:  '0d010101-0101-3000-060e-2b3402060101',
  CompositionMob:  '0d010101-0101-3500-060e-2b3402060101',
  MasterMob:       '0d010101-0101-3600-060e-2b3402060101',
  SourceMob:       '0d010101-0101-3700-060e-2b3402060101',
  TimelineMobSlot: '0d010101-0101-3b00-060e-2b3402060101',
  Sequence:        '0d010101-0101-0f00-060e-2b3402060101',
  SourceClip:      '0d010101-0101-1100-060e-2b3402060101',
  Filler:          '0d010101-0101-0900-060e-2b3402060101',
  WAVEDescriptor:  '0d010101-0101-2c00-060e-2b3402060101',
  NetworkLocator:  '0d010101-0101-3200-060e-2b3402060101',
} as const;

const DATADEF_SOUND = '01030202-0200-0000-060e-2b3404010101';

/** A weak reference: table index, the key's property id, then the key. */
function weakRef(auid: string, keyPid: number, index = 2): Uint8Array {
  const key = auidToBytes(auid);
  const out = new Uint8Array(5 + key.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, index, true);
  view.setUint16(2, keyPid, true);
  view.setUint8(4, key.length);
  out.set(key, 5);
  return out;
}

/**
 * A MobID.
 *
 * 32 bytes: a SMPTE UMID header, then a material number that has to be
 * unique across every file this one will ever sit beside.  It is derived
 * from a counter and a per-file seed rather than taken from a clock, so
 * writing the same session twice produces the same file — a diffable export
 * is worth more than an unpredictable one.
 */
function makeMobId(seed: number, index: number): Uint8Array {
  const out = new Uint8Array(32);
  // SMPTE UL for a UMID with a UUID material number.
  out.set([0x06, 0x0a, 0x2b, 0x34, 0x01, 0x01, 0x01, 0x05, 0x01, 0x01, 0x0f, 0x10], 0);
  out[12] = 0x13;          // length
  out[13] = 0x00; out[14] = 0x00; out[15] = 0x00;
  const view = new DataView(out.buffer);
  view.setUint32(16, (seed ^ (index * 0x9e3779b1)) >>> 0, true);
  view.setUint16(20, (index * 7919) & 0xffff, true);
  view.setUint16(22, 0x4000 | ((index * 104729) & 0x0fff), true);
  out.set([0x80, 0x21, 0x4c, 0x4f, 0x55, 0x49, 0x00, 0x00], 24);
  return out;
}

/** AAF TimeStamp: date then time, both packed. */
function timestamp(date: Date): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setInt16(0, date.getUTCFullYear(), true);
  view.setUint8(2, date.getUTCMonth() + 1);
  view.setUint8(3, date.getUTCDate());
  view.setUint8(4, date.getUTCHours());
  view.setUint8(5, date.getUTCMinutes());
  view.setUint8(6, date.getUTCSeconds());
  view.setUint8(7, 0);
  return out;
}

const data = (pid: number, bytes: Uint8Array): AafProperty =>
  ({ pid, form: SF_DATA, data: bytes });
const ref = (pid: number, name: string): AafProperty =>
  ({ pid, form: SF_STRONG_REF, data: encodeString(name) });
const vectorRef = (pid: number, name: string): AafProperty =>
  ({ pid, form: SF_STRONG_REF_VECTOR, data: encodeString(name) });
const setRef = (pid: number, name: string): AafProperty =>
  ({ pid, form: SF_STRONG_REF_SET, data: encodeString(name) });

/** A vector's index stream: count, next free key, last free key, then keys. */
function vectorIndex(count: number): Uint8Array {
  const out = new Uint8Array(12 + count * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, count, true);
  view.setUint32(4, count, true);
  view.setUint32(8, 0xFFFFFFFF, true);
  for (let i = 0; i < count; i++) view.setUint32(12 + i * 4, i, true);
  return out;
}

/** A set's index: the header, then local key, reference count and unique key. */
function setIndex(keys: readonly Uint8Array[], keyPid: number): Uint8Array {
  const keySize = keys[0]?.length ?? 32;
  const out = new Uint8Array(15 + keys.length * (8 + keySize));
  const view = new DataView(out.buffer);
  view.setUint32(0, keys.length, true);
  view.setUint32(4, keys.length, true);
  view.setUint32(8, 0xFFFFFFFF, true);
  view.setUint16(12, keyPid, true);
  view.setUint8(14, keySize);
  let at = 15;
  for (let i = 0; i < keys.length; i++) {
    view.setUint32(at, i, true);
    view.setUint32(at + 4, 1, true);
    out.set(keys[i]!, at + 8);
    at += 8 + keySize;
  }
  return out;
}

/**
 * The weak-reference table, exactly as every AAF carries it.
 *
 * Three paths: the meta dictionary's classes and types, and the dictionary's
 * data definitions.  Index 2 is the one this writer uses — it is what
 * "DataDefinition = Sound" resolves through.
 */
function referencedProperties(): Uint8Array {
  const paths: number[][] = [
    [0x0001, 0x0003],
    [0x0001, 0x0004],
    [0x0002, 0x3b04, 0x2605],
  ];
  const pidCount = paths.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(1 + 2 + 4 + pidCount * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0x4c);
  view.setUint16(1, paths.length, true);
  view.setUint32(3, pidCount, true);
  let at = 7;
  for (const path of paths) {
    for (const pid of path) { view.setUint16(at, pid, true); at += 2; }
    view.setUint16(at, 0, true);            // 0 terminates a path
    at += 2;
  }
  return out;
}

/** A set with no members — still needs its header, or a reader stops. */
function emptySetIndex(keyPid: number): Uint8Array {
  const out = new Uint8Array(15);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, 0xFFFFFFFF, true);
  view.setUint16(12, keyPid, true);
  view.setUint8(14, 16);
  return out;
}

const object = (name: string, clsid: string, props: AafProperty[], children: CfbNode[] = []): CfbNode => ({
  name,
  type: 'storage',
  clsid: auidToBytes(clsid),
  children: [
    { name: 'properties', type: 'stream', data: encodeProperties(props) },
    ...children,
  ],
});

export interface WriteOptions {
  /** Stamped into the file so two exports of one session are identical. */
  now?: Date;
  seed?: number;
}

export interface WriteResult {
  bytes: Uint8Array;
  /** What the format could not carry, named. */
  problems: string[];
}

export function writeAaf(session: InterchangeSession, options: WriteOptions = {}): WriteResult {
  const now = options.now ?? new Date(0);
  const seed = options.seed ?? 0x4C4F5549;                  // "LOUI"
  const rate = session.sampleRate > 0 ? Math.round(session.sampleRate) : 48_000;
  const editRate = encodeRational({ numerator: rate, denominator: 1 });
  const problems = [...session.problems];

  const mobs: CfbNode[] = [];
  const mobIds: Uint8Array[] = [];
  let mobIndex = 0;
  const nextMobId = (): Uint8Array => {
    const id = makeMobId(seed, mobIndex++);
    return id;
  };

  // ── One master + source mob per distinct media file ───────────────────
  const masterFor = new Map<string, Uint8Array>();
  for (const track of session.tracks) {
    for (const clip of track.clips) {
      if (!clip.sourceUrl || masterFor.has(clip.sourceUrl)) continue;

      const sourceId = nextMobId();
      const masterId = nextMobId();
      masterFor.set(clip.sourceUrl, masterId);
      // Long enough to hold anything the composition asks for; the receiving
      // application reads the real length from the file itself.
      const sourceLength = Math.max(1, Math.round((clip.sourceOffsetSec + clip.durationSec) * rate) * 4);

      const descriptor = object('EssenceDescription-4701', CLASS_AUID.WAVEDescriptor, [
        data(PID.SampleRate, editRate),
        data(PID.EssenceLength, encodeInt64(sourceLength)),
        data(PID.Summary, new Uint8Array(0)),
        vectorRef(PID.Locator, 'Locator-2f01'),
      ], [
        { name: 'Locator-2f01 index', type: 'stream', data: vectorIndex(1) },
        object('Locator-2f01{0}', CLASS_AUID.NetworkLocator, [
          data(PID.URLString, encodeString(clip.sourceUrl)),
        ]),
      ]);

      mobs.push(object(`Mobs-1901{${mobs.length.toString(16)}}`, CLASS_AUID.SourceMob, [
        data(PID.MobID, sourceId),
        data(PID.MobName, encodeString(clip.sourceName || 'Source')),
        data(0x4404, timestamp(now)),
        data(0x4405, timestamp(now)),
        vectorRef(PID.Slots, 'Slots-4403'),
        ref(PID.EssenceDescription, 'EssenceDescription-4701'),
      ], [
        { name: 'Slots-4403 index', type: 'stream', data: vectorIndex(1) },
        object('Slots-4403{0}', CLASS_AUID.TimelineMobSlot, [
          data(PID.SlotID, encodeUint32(1)),
          data(PID.EditRate, editRate),
          data(PID.Origin, encodeInt64(0)),
          ref(PID.Segment, 'Segment-4803'),
        ], [
          object('Segment-4803', CLASS_AUID.SourceClip, [
            { pid: PID.DataDefinition, form: 0x02, data: weakRef(DATADEF_SOUND, 0x1b01) },
            data(PID.Length, encodeInt64(sourceLength)),
            data(PID.SourceID, new Uint8Array(32)),      // the physical original: none
            data(PID.SourceMobSlotID, encodeUint32(0)),
            data(PID.StartTime, encodeInt64(0)),
          ]),
        ]),
        descriptor,
      ]));
      mobIds.push(sourceId);

      mobs.push(object(`Mobs-1901{${mobs.length.toString(16)}}`, CLASS_AUID.MasterMob, [
        data(PID.MobID, masterId),
        data(PID.MobName, encodeString(clip.sourceName || 'Master')),
        data(0x4404, timestamp(now)),
        data(0x4405, timestamp(now)),
        vectorRef(PID.Slots, 'Slots-4403'),
      ], [
        { name: 'Slots-4403 index', type: 'stream', data: vectorIndex(1) },
        object('Slots-4403{0}', CLASS_AUID.TimelineMobSlot, [
          data(PID.SlotID, encodeUint32(1)),
          data(PID.EditRate, editRate),
          data(PID.Origin, encodeInt64(0)),
          ref(PID.Segment, 'Segment-4803'),
        ], [
          object('Segment-4803', CLASS_AUID.SourceClip, [
            { pid: PID.DataDefinition, form: 0x02, data: weakRef(DATADEF_SOUND, 0x1b01) },
            data(PID.Length, encodeInt64(sourceLength)),
            data(PID.SourceID, sourceId),
            data(PID.SourceMobSlotID, encodeUint32(1)),
            data(PID.StartTime, encodeInt64(0)),
          ]),
        ]),
      ]));
      mobIds.push(masterId);
    }
  }

  // ── The composition ───────────────────────────────────────────────────
  const compositionId = nextMobId();
  const slots: CfbNode[] = [];
  session.tracks.forEach((track, index) => {
    const components: CfbNode[] = [];
    let position = 0;
    let n = 0;
    const ordered = [...track.clips].sort((a, b) => a.startSec - b.startSec);
    for (const clip of ordered) {
      const start = Math.round(clip.startSec * rate);
      const length = Math.max(1, Math.round(clip.durationSec * rate));
      if (start > position) {
        // Silence between clips is a Filler, not a gap: a sequence's
        // components are contiguous and their lengths ARE the timeline.
        components.push(object(`Components-1001{${(n++).toString(16)}}`, CLASS_AUID.Filler, [
          { pid: PID.DataDefinition, form: 0x02, data: weakRef(DATADEF_SOUND, 0x1b01) },
          data(PID.Length, encodeInt64(start - position)),
        ]));
        position = start;
      }
      const masterId = clip.sourceUrl ? masterFor.get(clip.sourceUrl) : undefined;
      if (!masterId) {
        problems.push(`${track.name} · ${clip.name} — 원본이 없어 무음으로 나갔습니다`);
        components.push(object(`Components-1001{${(n++).toString(16)}}`, CLASS_AUID.Filler, [
          { pid: PID.DataDefinition, form: 0x02, data: weakRef(DATADEF_SOUND, 0x1b01) },
          data(PID.Length, encodeInt64(length)),
        ]));
        position += length;
        continue;
      }
      const props: AafProperty[] = [
        { pid: PID.DataDefinition, form: 0x02, data: weakRef(DATADEF_SOUND, 0x1b01) },
        data(PID.Length, encodeInt64(length)),
        data(PID.SourceID, masterId),
        data(PID.SourceMobSlotID, encodeUint32(1)),
        data(PID.StartTime, encodeInt64(Math.round(clip.sourceOffsetSec * rate))),
      ];
      if (clip.fadeInSec > 0) {
        props.push(data(PID.FadeInLength, encodeInt64(Math.round(clip.fadeInSec * rate))));
        props.push(data(PID.FadeInType, encodeUint32(1)));
      }
      if (clip.fadeOutSec > 0) {
        props.push(data(PID.FadeOutLength, encodeInt64(Math.round(clip.fadeOutSec * rate))));
        props.push(data(PID.FadeOutType, encodeUint32(1)));
      }
      components.push(object(`Components-1001{${(n++).toString(16)}}`, CLASS_AUID.SourceClip, props));
      position += length;
    }

    slots.push(object(`Slots-4403{${index.toString(16)}}`, CLASS_AUID.TimelineMobSlot, [
      data(PID.SlotID, encodeUint32(index + 1)),
      data(PID.SlotName, encodeString(track.name || `Track ${index + 1}`)),
      data(PID.EditRate, editRate),
      data(PID.Origin, encodeInt64(0)),
      data(PID.PhysicalTrackNumber, encodeUint32(index + 1)),
      ref(PID.Segment, 'Segment-4803'),
    ], [
      object('Segment-4803', CLASS_AUID.Sequence, [
        { pid: PID.DataDefinition, form: 0x02, data: weakRef(DATADEF_SOUND, 0x1b01) },
        data(PID.Length, encodeInt64(position)),
        vectorRef(PID.Components, 'Components-1001'),
      ], [
        { name: 'Components-1001 index', type: 'stream', data: vectorIndex(components.length) },
        ...components,
      ]),
    ]));
  });

  mobs.push(object(`Mobs-1901{${mobs.length.toString(16)}}`, CLASS_AUID.CompositionMob, [
    data(PID.MobID, compositionId),
    data(PID.MobName, encodeString(session.name || 'Composition')),
    data(0x4404, timestamp(now)),
    data(0x4405, timestamp(now)),
    data(PID.UsageCode, auidToBytes(USAGE_TOP_LEVEL)),
    vectorRef(PID.Slots, 'Slots-4403'),
  ], [
    { name: 'Slots-4403 index', type: 'stream', data: vectorIndex(slots.length) },
    ...slots,
  ]));
  mobIds.push(compositionId);

  // ── Header and root ───────────────────────────────────────────────────
  const content = object('Content-3b03', CLASS_AUID.ContentStorage, [
    setRef(PID.Mobs, 'Mobs-1901'),
  ], [
    { name: 'Mobs-1901 index', type: 'stream', data: setIndex(mobIds, PID.MobID) },
    ...mobs,
  ]);

  const identification = object('IdentificationList-3b06{0}', CLASS_AUID.Identification, [
    data(0x3c01, encodeString('Loui')),
    data(0x3c02, encodeString('LOUI')),
    data(0x3c04, encodeString('1.0')),
    data(0x3c05, auidToBytes('0d011501-0000-0000-060e-2b3404010101')),
    data(0x3c06, timestamp(now)),
    data(0x3c09, auidToBytes('0d011502-0000-0000-060e-2b3404010101')),
  ]);

  const header = object('Header-2', CLASS_AUID.Header, [
    data(0x3b01, new Uint8Array([0x49, 0x49])),        // "II" — little-endian
    data(0x3b02, timestamp(now)),
    data(0x3b05, new Uint8Array([1, 1])),              // object model version
    ref(PID.Content, 'Content-3b03'),
    ref(PID.Dictionary, 'Dictionary-3b04'),
    vectorRef(0x3b06, 'IdentificationList-3b06'),
  ], [
    content,
    object('Dictionary-3b04', CLASS_AUID.Dictionary, [
      setRef(0x2605, 'DataDefinitions-2605'),
    ], [
      {
        name: 'DataDefinitions-2605 index', type: 'stream',
        data: setIndex([auidToBytes(DATADEF_SOUND)], 0x1b01),
      },
      object('DataDefinitions-2605{0}', CLASS_AUID.DataDefinition, [
        data(0x1b01, auidToBytes(DATADEF_SOUND)),
        data(0x1b02, encodeString('Sound')),
        data(0x1b03, encodeString('Sound data')),
      ]),
    ]),
    { name: 'IdentificationList-3b06 index', type: 'stream', data: vectorIndex(1) },
    identification,
  ]);

  // The root object is itself an AAF object: its two strong references are
  // the meta dictionary and the header, and its property stream sits at the
  // top of the container beside them.
  const rootProperties = encodeProperties([
    ref(PID.MetaDictionary, 'MetaDictionary-1'),
    ref(PID.Header, 'Header-2'),
  ]);

  const root: CfbNode[] = [
    { name: 'properties', type: 'stream', data: rootProperties },
    // The weak-reference table: each entry is the path of property ids from
    // the root down to the collection a weak reference points into.  Without
    // it a reader cannot resolve "this component carries sound" at all, and
    // refuses the file before looking at a single mob.
    { name: 'referenced properties', type: 'stream', data: referencedProperties() },
    // The meta dictionary is where a file declares any class or type it uses
    // beyond the standard ones.  This writer uses none — but the two
    // collections still have to BE there, empty, because a reader walks them
    // before it looks at anything else and an absent index stream stops it
    // dead.
    object('MetaDictionary-1', CLASS_AUID.MetaDictionary, [
      setRef(0x0003, 'ClassDefinitions-3'),
      setRef(0x0004, 'TypeDefinitions-4'),
    ], [
      { name: 'ClassDefinitions-3 index', type: 'stream', data: emptySetIndex(0x0005) },
      { name: 'TypeDefinitions-4 index', type: 'stream', data: emptySetIndex(0x0005) },
    ]),
    header,
  ];

  problems.push('AAF 에는 오디오가 들어가지 않고 파일을 가리키기만 합니다 — 원본 WAV 을 함께 보내세요');

  return { bytes: writeCfb(root, auidToBytes(ROOT_CLASS)), problems };
}

/** Exported for the tests: the file kind stamped on an AAF's root storage. */
export const AAF_ROOT_CLASS = ROOT_CLASS;
export { AAF_FILE_KIND };
