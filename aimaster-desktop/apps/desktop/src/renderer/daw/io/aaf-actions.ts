// The verbs the DAW calls for AAF interchange.
//
// Two jobs, and the interesting half of both is what to say afterwards.
//
// IMPORTING gives you an arrangement whose clips point at files that live on
// somebody else's machine.  The paths in an AAF are the paths the picture
// editor had.  So the import reports how many of them resolve HERE, by name,
// rather than handing over a session of silent rectangles and letting the
// user find out one clip at a time.
//
// EXPORTING writes an edit decision list, not a mix.  Faders, plugins,
// automation and sends do not exist in the format; MIDI parts do not either.
// The export names every one of those rather than producing a file that
// looks complete to the person opening it.

import { readAaf, looksLikeAaf } from './aaf-read.js';
import { writeAaf } from './aaf-write.js';
import { OMF_REFUSAL, looksLikeOmf } from './omf.js';
import {
  describeInterchange, interchangeFromSession, sessionFromInterchange, urlToPath,
} from './interchange.js';
import type { InterchangeSession } from './interchange.js';
import { AafError } from './aaf-format.js';
import { CfbError } from './cfb.js';
import type { DawSession } from '../model/types.js';

export interface ImportResult {
  session: DawSession;
  interchange: InterchangeSession;
  /** Media paths the file referenced, in the order the tracks use them. */
  mediaPaths: string[];
  problems: string[];
  summary: string;
}

/**
 * Read AAF bytes into a session.
 *
 * The refusals come first and are specific: an OMF says it is an OMF, a
 * random file says it is not an AAF at all.  "Import failed" would be true
 * of all three and useful for none.
 */
export function importAaf(bytes: Uint8Array): ImportResult {
  if (looksLikeOmf(bytes) && !looksLikeAaf(bytes)) throw new AafError(OMF_REFUSAL);
  if (!looksLikeAaf(bytes)) {
    throw new AafError('AAF 파일이 아닙니다 — 앞부분이 컴파운드 파일 서명이 아닙니다');
  }

  const interchange = readAaf(bytes);
  const built = sessionFromInterchange(interchange);
  return {
    session: built.session,
    interchange,
    mediaPaths: built.mediaUrls.map(urlToPath),
    problems: built.problems,
    summary: `${interchange.name} — ${describeInterchange(interchange)}`,
  };
}

export interface ExportResult {
  bytes: Uint8Array;
  interchange: InterchangeSession;
  problems: string[];
  summary: string;
}

export function exportAaf(session: DawSession, now?: Date): ExportResult {
  const interchange = interchangeFromSession(session);
  if (interchange.tracks.length === 0) {
    throw new AafError('내보낼 오디오 클립이 없습니다 — AAF 는 편집본이지 믹스가 아닙니다');
  }
  const written = writeAaf(interchange, now === undefined ? {} : { now });
  return {
    bytes: written.bytes,
    interchange,
    problems: written.problems,
    summary: describeInterchange(interchange),
  };
}

/** A message for a failure, whichever layer it came from. */
export function describeFailure(err: unknown): string {
  if (err instanceof AafError || err instanceof CfbError) return err.message;
  return `AAF 처리 실패: ${err instanceof Error ? err.message : String(err)}`;
}
