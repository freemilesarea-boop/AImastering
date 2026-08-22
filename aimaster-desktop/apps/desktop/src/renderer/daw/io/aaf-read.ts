// Reading an AAF — what a picture editor sends a mixer.
//
// The file is a graph, not a list, and the shape of the walk is the whole
// job.  A clip on a timeline does not name a file; it names a MOB, which
// names another mob, which eventually names a descriptor that holds a URL.
// Three hops, and any of them can be missing:
//
//   CompositionMob → TimelineMobSlot → Sequence → SourceClip
//        SourceClip.SourceID → MasterMob → its SourceClip.SourceID
//        → SourceMob → EssenceDescription → Locator → URL
//
// The MasterMob in the middle is not decoration: it is where an editor's
// media management lives, and an AAF that has been consolidated points its
// master mobs at freshly written files rather than the camera originals.
//
// What this brings across: audio tracks, clip positions, source offsets,
// clip names, fades, and the media URLs.  What it does not, and says so
// instead: video, effects (OperationGroups), transitions, embedded essence.
// Naming what did not arrive is the only honest way to hand someone a
// timeline that is missing a crossfade they can hear in the Avid.

import { readCfb } from './cfb.js';
import type { CfbFile } from './cfb.js';
import {
  AafError, CLASS, PID, USAGE_TOP_LEVEL, auidFromBytes, clsidHex, collectionName,
  decodeInt64, decodeRational, decodeString, decodeUint32, hex, join,
  collectionMembers, decodeWeakRef, objectProperties, rationalToNumber, strongRef,
  vectorMembers,
} from './aaf-format.js';
import type { AafProperty } from './aaf-format.js';
import { emptyInterchange, fileNameOf } from './interchange.js';
import type { InterchangeClip, InterchangeSession, InterchangeTrack } from './interchange.js';

/** DataDef AUIDs — what a component says it carries. */
const DATADEF_SOUND        = '01030202-0200-0000-060e-2b3404010101';
const DATADEF_SOUND_LEGACY = '78e1ebe1-6cef-11d2-807d-006008143e6f';
const DATADEF_PICTURE      = '01030202-0100-0000-060e-2b3404010101';
const DATADEF_PICTURE_LEGACY = '6f3c8ce1-6cef-11d2-807d-006008143e6f';
const DATADEF_TIMECODE     = '01030201-0100-0000-060e-2b3404010101';

interface Mob {
  path: string;
  clsid: string;
  props: Map<number, AafProperty>;
}

/** A source clip's three hops, resolved as far as the file allows. */
interface Media {
  url: string | null;
  name: string;
}

export function readAaf(bytes: Uint8Array): InterchangeSession {
  const file = readCfb(bytes);
  const out = emptyInterchange('AAF');
  const problems = out.problems;

  const rootProps = objectProperties(file, '');
  const headerPath = strongRef(rootProps, PID.Header, '');
  if (!headerPath) throw new AafError('AAF 헤더가 없습니다 — 이 CFB 파일은 AAF 가 아닙니다');
  const headerProps = objectProperties(file, headerPath);
  const contentPath = strongRef(headerProps, PID.Content, headerPath);
  if (!contentPath) throw new AafError('ContentStorage 가 없습니다');

  // ── Every mob, indexed by MobID ───────────────────────────────────────
  const contentProps = objectProperties(file, contentPath);
  const mobs = new Map<string, Mob>();
  const compositions: Mob[] = [];
  for (const member of collectionMembers(file, contentPath, contentProps, PID.Mobs)) {
    const mob: Mob = {
      path: member.path,
      clsid: clsidHex(file, member.path),
      props: objectProperties(file, member.path),
    };
    // The set's key IS the MobID, which saves decoding it from properties;
    // fall back to the property for a writer that stores it differently.
    const key = member.key ?? mob.props.get(PID.MobID)?.data;
    if (key) mobs.set(hex(key), mob);
    if (mob.clsid === CLASS.CompositionMob) compositions.push(mob);
  }
  if (mobs.size === 0) throw new AafError('이 파일에 Mob 이 없습니다');

  const propString = (props: Map<number, AafProperty>, pid: number): string => {
    const p = props.get(pid);
    return p ? decodeString(p.data) : '';
  };
  const propInt = (props: Map<number, AafProperty>, pid: number): number => {
    const p = props.get(pid);
    return p ? decodeInt64(p.data) : 0;
  };

  /**
   * MasterMob → SourceMob → descriptor → locator.
   *
   * Each hop is optional in the wild: a consolidated AAF may stop at the
   * master mob, and an AAF with embedded essence has no locator at all.
   */
  const resolveMedia = (sourceId: string, depth = 0): Media => {
    const mob = mobs.get(sourceId);
    if (!mob || depth > 4) return { url: null, name: '' };
    const name = propString(mob.props, PID.MobName);

    if (mob.clsid === CLASS.SourceMob) {
      const descriptorPath = strongRef(mob.props, PID.EssenceDescription, mob.path);
      if (!descriptorPath) return { url: null, name };
      const descriptor = objectProperties(file, descriptorPath);
      const locatorName = collectionName(descriptor, PID.Locator);
      if (locatorName) {
        for (const locator of vectorMembers(file, descriptorPath, locatorName)) {
          const url = propString(objectProperties(file, locator), PID.URLString);
          if (url) return { url, name: name || fileNameOf(url) };
        }
      }
      return { url: null, name };
    }

    // A MasterMob points on through its own slot's SourceClip.
    for (const slot of collectionMembers(file, mob.path, mob.props, PID.Slots)) {
      const slotProps = objectProperties(file, slot.path);
      const segment = strongRef(slotProps, PID.Segment, slot.path);
      if (!segment) continue;
      const segmentProps = objectProperties(file, segment);
      const next = segmentProps.get(PID.SourceID);
      if (!next) continue;
      const deeper = resolveMedia(hex(next.data), depth + 1);
      if (deeper.url) return { url: deeper.url, name: deeper.name || name };
    }
    return { url: null, name };
  };

  // ── The composition ───────────────────────────────────────────────────
  if (compositions.length === 0) throw new AafError('CompositionMob 이 없습니다 — 편집본이 담기지 않은 파일입니다');
  // Top-level first, then whichever has the most slots: an AAF often carries
  // sub-compositions, and importing one of those gives you a fragment.
  const usageTopLevel = compositions.filter((m) => {
    const p = m.props.get(PID.UsageCode);
    return p ? auidFromBytes(p.data) === USAGE_TOP_LEVEL : false;
  });
  const pool = usageTopLevel.length > 0 ? usageTopLevel : compositions;
  const composition = pool.reduce((best, m) => {
    const count = (n: Mob): number => collectionMembers(file, n.path, n.props, PID.Slots).length;
    return count(m) > count(best) ? m : best;
  }, pool[0]!);
  if (compositions.length > 1) {
    problems.push(`컴포지션이 ${compositions.length}개 있어 가장 큰 것을 가져왔습니다`);
  }
  out.name = propString(composition.props, PID.MobName) || 'AAF';

  const slotMembers = collectionMembers(file, composition.path, composition.props, PID.Slots);
  if (slotMembers.length === 0) throw new AafError('컴포지션에 슬롯이 없습니다');

  const slots = slotMembers
    .map((m) => ({ path: m.path, props: objectProperties(file, m.path) }))
    .sort((a, b) => decodeUint32(a.props.get(PID.SlotID)?.data ?? new Uint8Array(4))
      - decodeUint32(b.props.get(PID.SlotID)?.data ?? new Uint8Array(4)));

  let skippedVideo = 0;
  const tracks: InterchangeTrack[] = [];

  for (const slot of slots) {
    const clsid = clsidHex(file, slot.path);
    const rateProp = slot.props.get(PID.EditRate);
    if (clsid !== CLASS.TimelineMobSlot || !rateProp) continue;
    const editRate = rationalToNumber(decodeRational(rateProp.data));
    if (editRate <= 0) continue;
    if (out.sampleRate === 48_000 && editRate > 1000) out.sampleRate = Math.round(editRate);

    const segmentPath = strongRef(slot.props, PID.Segment, slot.path);
    if (!segmentPath) continue;

    const name = propString(slot.props, PID.SlotName)
      || `Track ${decodeUint32(slot.props.get(PID.SlotID)?.data ?? new Uint8Array(4))}`;

    // Components, in timeline order.  A bare segment counts as one.
    const segmentProps = objectProperties(file, segmentPath);
    const componentsName = clsidHex(file, segmentPath) === CLASS.Sequence
      ? collectionName(segmentProps, PID.Components)
      : null;
    const components = componentsName
      ? vectorMembers(file, segmentPath, componentsName)
      : [segmentPath];

    const clips: InterchangeClip[] = [];
    let position = 0;
    let videoHere = false;

    for (const path of components) {
      const props = objectProperties(file, path);
      const kind = clsidHex(file, path);
      const lengthUnits = propInt(props, PID.Length);
      const dataDef = props.get(PID.DataDefinition);
      const def = dataDef ? decodeWeakRef(dataDef.data) : '';

      if (def === DATADEF_PICTURE || def === DATADEF_PICTURE_LEGACY) {
        videoHere = true; position += lengthUnits; continue;
      }
      if (def === DATADEF_TIMECODE || kind === CLASS.Timecode) { position += lengthUnits; continue; }

      if (kind === CLASS.Filler) { position += lengthUnits; continue; }

      if (kind === CLASS.Transition) {
        // A transition makes its neighbours overlap by its own length.  The
        // clips still land where they should; the crossfade itself does not
        // come across, and pretending otherwise loses an audible edit.
        problems.push(`${name} — 트랜지션 하나는 가져오지 못했습니다 (클립 위치는 유지)`);
        position -= lengthUnits;
        continue;
      }

      if (kind === CLASS.OperationGroup) {
        problems.push(`${name} — 이펙트(OperationGroup) 하나는 가져오지 못했습니다`);
        position += lengthUnits;
        continue;
      }

      if (kind !== CLASS.SourceClip) {
        problems.push(`${name} — 알 수 없는 구성요소 하나를 건너뛰었습니다`);
        position += lengthUnits;
        continue;
      }

      if (def && def !== DATADEF_SOUND && def !== DATADEF_SOUND_LEGACY) {
        videoHere = true;
        position += lengthUnits;
        continue;
      }

      const sourceProp = props.get(PID.SourceID);
      const media = sourceProp ? resolveMedia(hex(sourceProp.data)) : { url: null, name: '' };
      if (!media.url) {
        problems.push(`${name} — 클립 하나의 원본 미디어를 찾지 못했습니다`
          + ' (AAF 안에 오디오가 들어 있는 파일일 수 있습니다)');
      }

      clips.push({
        name: media.name || fileNameOf(media.url ?? '') || 'Clip',
        startSec: position / editRate,
        durationSec: lengthUnits / editRate,
        sourceOffsetSec: propInt(props, PID.StartTime) / editRate,
        sourceUrl: media.url,
        sourceName: media.name || fileNameOf(media.url ?? ''),
        fadeInSec: propInt(props, PID.FadeInLength) / editRate,
        fadeOutSec: propInt(props, PID.FadeOutLength) / editRate,
      });
      position += lengthUnits;
    }

    if (clips.length === 0) {
      if (videoHere) skippedVideo++;
      continue;
    }
    tracks.push({ name, clips });
  }

  if (skippedVideo > 0) {
    problems.push(`영상 트랙 ${skippedVideo}개는 가져오지 않았습니다 — 이 앱은 오디오 편집본만 읽습니다`);
  }
  if (tracks.length === 0) throw new AafError('가져올 오디오 트랙이 없습니다');
  out.tracks = tracks;
  return out;
}

/** True when these bytes look like an AAF at all — checked before parsing. */
export function looksLikeAaf(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  return sig.every((b, i) => bytes[i] === b);
}

/** Named so the caller can keep the CFB layer out of its imports. */
export const parseCfb = (bytes: Uint8Array): CfbFile => readCfb(bytes);
export { join as joinPath };
