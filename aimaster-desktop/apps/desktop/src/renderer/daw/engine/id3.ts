// ID3v2.4 — the same record, in the format an MP3 carries it.
//
// The preview is an MP3, and an MP3 has no RIFF chunks.  Refusing to tag it
// (which `stampWav` correctly does) would leave the file people actually pass
// around — the one that gets emailed to a label, dropped in a chat, uploaded
// for a first listen — as the only one saying nothing about who made it.
//
// ── The two things that go wrong ─────────────────────────────────────────────
//
// SYNCHSAFE sizes.  The tag header's size is stored 7 bits per byte, so a
// decoder scanning for a frame sync (11 set bits) can never mistake it for
// audio.  Writing a plain 32-bit integer there produces a tag that most
// players skip by the wrong number of bytes — they then decode tag bytes as
// audio, which is a burst of noise before the music.
//
// EXISTING TAGS.  Prepending to a file that already has one leaves two, and a
// reader takes the first.  Save twice and you are reading the older record.

import { infoTags, provenanceJson, type Provenance } from '../model/provenance.js';

const utf8 = new TextEncoder();

/** 7 bits per byte, big-endian — the whole point of ID3's size fields. */
function synchsafe(n: number): Uint8Array {
  return new Uint8Array([
    (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f,
  ]);
}

/** A v2.4 frame: id(4) + synchsafe size(4) + flags(2) + body. */
function frame(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + body.length);
  out.set(utf8.encode(id), 0);
  out.set(synchsafe(body.length), 4);
  // flags stay zero
  out.set(body, 10);
  return out;
}

/** A text frame, always UTF-8 (encoding 3) — the text is Korean as often as not. */
function textFrame(id: string, text: string): Uint8Array {
  const value = utf8.encode(text);
  const body = new Uint8Array(1 + value.length);
  body[0] = 3;
  body.set(value, 1);
  return frame(id, body);
}

/** COMM: encoding + language(3) + short description + NUL + the text. */
function commentFrame(text: string): Uint8Array {
  const value = utf8.encode(text);
  const body = new Uint8Array(1 + 3 + 1 + value.length);
  body[0] = 3;
  body.set(utf8.encode('kor'), 1);
  body[4] = 0;                       // empty short description
  body.set(value, 5);
  return frame('COMM', body);
}

/** TXXX: a named user field — where the exact record goes. */
function userTextFrame(description: string, value: string): Uint8Array {
  const d = utf8.encode(description);
  const v = utf8.encode(value);
  const body = new Uint8Array(1 + d.length + 1 + v.length);
  body[0] = 3;
  body.set(d, 1);
  body[1 + d.length] = 0;
  body.set(v, 2 + d.length);
  return frame('TXXX', body);
}

/** The description a reader looks for to find the structured record. */
export const PROVENANCE_FIELD = 'LOUI-PROVENANCE';

/**
 * How far into the file the audio starts — i.e. the length of any ID3v2 tag
 * already at the front.  Zero when there is none.
 */
export function id3TagLength(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;  // 'ID3'
  // Synchsafe again, and it excludes the 10-byte header.
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14)
    | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;   // v2.4 may carry a footer
  const total = 10 + size + footer;
  return total <= bytes.length ? total : 0;
}

/**
 * Put the record on an MP3, replacing any tag already there.
 *
 * Returns the input unchanged when it is not an MP3 this can safely rewrite —
 * the same rule as `stampWav`, and for the same reason.
 */
export function stampMp3(
  bytes: Uint8Array, provenance: Provenance, appVersion: string, at = new Date(),
): Uint8Array {
  const audioAt = id3TagLength(bytes);
  const audio = bytes.subarray(audioAt);
  // After any tag, an MPEG frame starts with 11 set bits.  Anything else is
  // not an MP3, and prepending a tag to it would just make a broken file
  // slightly larger.
  if (audio.length < 2 || audio[0] !== 0xff || (audio[1]! & 0xe0) !== 0xe0) return bytes;

  const tags = new Map(infoTags(provenance, appVersion, at));
  const frames: Uint8Array[] = [];
  const push = (id: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) frames.push(textFrame(id, value));
  };
  push('TIT2', tags.get('INAM'));                 // title
  push('TPE1', tags.get('IART'));                 // artist
  push('TCOP', tags.get('ICOP'));                 // copyright
  push('TDRC', tags.get('ICRD'));                 // recording date
  push('TSSE', tags.get('ISFT'));                 // encoding software
  const comment = tags.get('ICMT');
  if (comment) frames.push(commentFrame(comment));
  frames.push(userTextFrame(PROVENANCE_FIELD, provenanceJson(provenance, appVersion, at)));

  const body = concat(frames);
  const header = new Uint8Array(10);
  header.set(utf8.encode('ID3'), 0);
  header[3] = 4;                                  // v2.4
  header[4] = 0;                                  // revision
  header[5] = 0;                                  // no unsynchronisation, no footer
  header.set(synchsafe(body.length), 6);

  return concat([header, body, audio]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}
