// adm — ADM BWF (bed-based) authoring for the multichannel output (Phase 4).
//
// Wraps the multichannel WAV as an ADM Broadcast-WAV: adds a `chna` chunk
// (track → channel/pack mapping) and an `axml` chunk (the ADM XML describing the
// channel BED as DirectSpeakers with standard positions).  This is the
// standards-compliant authoring step that lets ADM/Atmos-aware tools ingest the
// program.  Scope: a channel BED (self-describing custom definitions) — NOT
// dynamic objects with positional automation, binaural render, or Dolby encode.
//
// Pure (Buffer/string generation); fully headless-testable.

import { LAYOUT_CHANNELS, type ChannelRole } from './surround.js';
import type { SurroundLayout } from '@aimaster/shared-types';

interface SpeakerDef { az: number; el: number; lfe: boolean; label: string }

// Standard DirectSpeakers positions (azimuth°, elevation°).
const SPEAKER: Record<ChannelRole, SpeakerDef> = {
  FL: { az: 30, el: 0, lfe: false, label: 'RoomCentredLeft' },
  FR: { az: -30, el: 0, lfe: false, label: 'RoomCentredRight' },
  FC: { az: 0, el: 0, lfe: false, label: 'RoomCentredCentre' },
  LFE: { az: 0, el: -30, lfe: true, label: 'LFE' },
  BL: { az: 110, el: 0, lfe: false, label: 'RoomCentredBackLeft' },
  BR: { az: -110, el: 0, lfe: false, label: 'RoomCentredBackRight' },
  SL: { az: 90, el: 0, lfe: false, label: 'RoomCentredSideLeft' },
  SR: { az: -90, el: 0, lfe: false, label: 'RoomCentredSideRight' },
};

const id4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

export interface AdmValidation { ok: boolean; errors: string[] }

/**
 * Structural + reference-integrity validation of an ADM XML (NOT a full XSD
 * check): required elements present, every *IDRef resolves to a declared ID,
 * and tags are balanced.  A headless substitute for "will an ADM tool accept
 * it" — catches broken references / missing elements without the tool.
 */
export function validateAdm(xml: string): AdmValidation {
  const errors: string[] = [];
  for (const tag of ['audioProgramme', 'audioContent', 'audioObject', 'audioPackFormat', 'audioChannelFormat', 'audioTrackUID']) {
    if (!new RegExp(`<${tag}[ >]`).test(xml)) errors.push(`missing <${tag}>`);
  }
  // Declared IDs: attributes ending in `ID` + audioTrackUID's UID attribute.
  const ids = new Set<string>();
  for (const m of xml.matchAll(/\b\w+ID="([^"]+)"/g)) ids.add(m[1]!);
  for (const m of xml.matchAll(/<audioTrackUID\b[^>]*\bUID="([^"]+)"/g)) ids.add(m[1]!);
  // Every *IDRef / audioTrackUIDRef must resolve.
  for (const m of xml.matchAll(/<(\w*IDRef|audioTrackUIDRef)>([^<]+)<\/\1>/g)) {
    const ref = m[2]!.trim();
    if (!ids.has(ref)) errors.push(`unresolved reference: ${ref}`);
  }
  // Rough tag balance for the ADM container.
  const open = (xml.match(/<audioChannelFormat\b/g) ?? []).length;
  const close = (xml.match(/<\/audioChannelFormat>/g) ?? []).length;
  if (open !== close) errors.push(`unbalanced audioChannelFormat (${open}/${close})`);
  return { ok: errors.length === 0, errors };
}

/** Build the ADM XML for a channel bed.  Deterministic, well-formed UTF-8. */
export function buildAdmXml(layout: SurroundLayout): string {
  const roles = LAYOUT_CHANNELS[layout];
  const packId = `AP_00011001`;
  const chFmts: string[] = [];
  const trackFmts: string[] = [];
  const streamFmts: string[] = [];
  const trackUids: string[] = [];

  roles.forEach((role, i) => {
    const sp = SPEAKER[role];
    const cid = `AC_0001${id4(0x1001 + i)}`;
    const sid = `AS_0001${id4(0x1001 + i)}`;
    const tid = `AT_0001${id4(0x1001 + i)}_01`;
    const uid = `ATU_0000${id4(0x1001 + i)}`;
    chFmts.push(
      `    <audioChannelFormat audioChannelFormatID="${cid}" audioChannelFormatName="${sp.label}" typeLabel="0001" typeDefinition="DirectSpeakers">\n` +
      `      <audioBlockFormat audioBlockFormatID="AB_0001${id4(0x1001 + i)}_00000001">\n` +
      (sp.lfe ? '        <frequency typeDefinition="lowPass">120</frequency>\n' : '') +
      `        <position coordinate="azimuth">${sp.az}</position>\n` +
      `        <position coordinate="elevation">${sp.el}</position>\n` +
      `        <position coordinate="distance">1</position>\n` +
      `      </audioBlockFormat>\n    </audioChannelFormat>`,
    );
    streamFmts.push(
      `    <audioStreamFormat audioStreamFormatID="${sid}" audioStreamFormatName="PCM_${sp.label}" formatLabel="0001" formatDefinition="PCM">\n` +
      `      <audioChannelFormatIDRef>${cid}</audioChannelFormatIDRef>\n` +
      `      <audioTrackFormatIDRef>${tid}</audioTrackFormatIDRef>\n    </audioStreamFormat>`,
    );
    trackFmts.push(
      `    <audioTrackFormat audioTrackFormatID="${tid}" audioTrackFormatName="PCM_${sp.label}" formatLabel="0001" formatDefinition="PCM">\n` +
      `      <audioStreamFormatIDRef>${sid}</audioStreamFormatIDRef>\n    </audioTrackFormat>`,
    );
    trackUids.push(`    <audioTrackUID UID="${uid}" sampleRate="48000" bitDepth="24">\n` +
      `      <audioTrackFormatIDRef>${tid}</audioTrackFormatIDRef>\n      <audioPackFormatIDRef>${packId}</audioPackFormatIDRef>\n    </audioTrackUID>`);
  });

  const chRefs = roles.map((_, i) => `      <audioChannelFormatIDRef>AC_0001${id4(0x1001 + i)}</audioChannelFormatIDRef>`).join('\n');
  const uidRefs = roles.map((_, i) => `      <audioTrackUIDRef>ATU_0000${id4(0x1001 + i)}</audioTrackUIDRef>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ebuCoreMain xmlns="urn:ebu:metadata-schema:ebuCore_2016">
  <coreMetadata><format><audioFormatExtended version="ITU-R_BS.2076-2">
    <audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="${layout} bed">
      <audioContentIDRef>ACO_1001</audioContentIDRef>
    </audioProgramme>
    <audioContent audioContentID="ACO_1001" audioContentName="${layout} bed">
      <audioObjectIDRef>AO_1001</audioObjectIDRef>
    </audioContent>
    <audioObject audioObjectID="AO_1001" audioObjectName="${layout} bed">
      <audioPackFormatIDRef>${packId}</audioPackFormatIDRef>
${uidRefs}
    </audioObject>
    <audioPackFormat audioPackFormatID="${packId}" audioPackFormatName="${layout}" typeLabel="0001" typeDefinition="DirectSpeakers">
${chRefs}
    </audioPackFormat>
${chFmts.join('\n')}
${streamFmts.join('\n')}
${trackFmts.join('\n')}
${trackUids.join('\n')}
  </audioFormatExtended></format></coreMetadata>
</ebuCoreMain>
`;
}

/** Build the BWF `chna` chunk payload (track → UID/track/pack mapping). */
export function buildChnaPayload(layout: SurroundLayout): Buffer {
  const roles = LAYOUT_CHANNELS[layout];
  const n = roles.length;
  const buf = Buffer.alloc(4 + n * 40);
  buf.writeUInt16LE(n, 0); // numTracks
  buf.writeUInt16LE(n, 2); // numUIDs
  const writeFixed = (s: string, off: number, len: number): void => {
    buf.write(s.slice(0, len), off, 'ascii'); // remainder stays NUL
  };
  roles.forEach((_, i) => {
    const rec = 4 + i * 40;
    buf.writeUInt16LE(i + 1, rec);                                  // 1-based track index
    writeFixed(`ATU_0000${id4(0x1001 + i)}`, rec + 2, 12);          // UID (12)
    writeFixed(`AT_0001${id4(0x1001 + i)}_01`, rec + 14, 14);       // trackRef (14)
    writeFixed(`AP_00011001`, rec + 28, 11);                        // packRef (11)
    // rec+39: 1 byte padding (NUL)
  });
  return buf;
}

/** Wrap a chunk (id + LE size + even-padded payload). */
function riffChunk(id: string, payload: Buffer): Buffer {
  const padded = payload.length % 2 === 1 ? Buffer.concat([payload, Buffer.from([0])]) : payload;
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, padded]);
}

/**
 * Wrap a multichannel WAV buffer as an ADM BWF by appending `chna` + `axml`
 * chunks and fixing the RIFF size.  Pure.  Throws on a non-RIFF/WAVE input.
 */
export function wrapAdmBwf(wav: Buffer, layout: SurroundLayout): Buffer {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wrapAdmBwf: not a RIFF/WAVE buffer');
  }
  const chna = riffChunk('chna', buildChnaPayload(layout));
  const axml = riffChunk('axml', Buffer.from(buildAdmXml(layout), 'utf8'));
  const out = Buffer.concat([wav, chna, axml]);
  out.writeUInt32LE(out.length - 8, 4); // RIFF chunk size = total − 8
  return out;
}
