// Stamp the mastered file on its way out.
//
// The master is written by the Python engine, which knows nothing about
// provenance.  So the record is carried IN by the mix (which does carry it)
// and copied ACROSS at save time, rather than looked up in a store that may
// no longer hold the session — you can close a project and still save its
// master an hour later.
//
// The mastering itself is added here, because here is where it is known: the
// chain that ran, and the loudness it actually achieved.

import { readWavProvenance, stampWav } from '../engine/wav.js';
import { stampMp3 } from '../engine/id3.js';
import {
  emptyProvenance, withAiStep, type Provenance,
} from '../model/provenance.js';
import { toFileUrl } from '../../utils/fileUrl.js';

export interface MasterStampInput {
  /** The mastered file to stamp. */
  outputPath: string;
  /** What went INTO the mastering — carries the record, when it has one. */
  sourcePath: string;
  /** The chain that ran, e.g. "AI Pop · −10 LUFS". */
  chain: string;
  /** What it measured out at, when it was measured. */
  loudness?: { integratedLufs?: number; lra?: number; truePeakDbtp?: number };
  /** Fallback title when the source carried no record. */
  fallbackTitle: string;
  appVersion: string;
}

async function bytesAt(path: string): Promise<Uint8Array> {
  const res = await fetch(toFileUrl(path));
  if (!res.ok) throw new Error(`파일을 읽지 못했습니다 (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Read the master, merge in what the mix knew, add the mastering step, and
 * hand back the stamped bytes.
 *
 * A source with no record is not an error: a file opened from disk has no
 * history the app can vouch for.  What it still knows — that this app
 * AI-mastered it, with this chain — is written either way, because that part
 * is true regardless of where the audio came from.
 */
export async function stampMaster(input: MasterStampInput): Promise<Uint8Array> {
  const master = await bytesAt(input.outputPath);

  let carried: Provenance | null = null;
  try {
    carried = readWavProvenance(await bytesAt(input.sourcePath));
  } catch {
    // The source may be long gone — a temp file swept between mastering and
    // saving.  That loses the history, not the export.
    carried = null;
  }

  const base = carried ?? emptyProvenance(input.fallbackTitle);
  const provenance = withAiStep(base, { kind: 'mastering', detail: input.chain });

  return stampWav(master, {
    provenance,
    appVersion: input.appVersion,
    ...(input.loudness ? { loudness: input.loudness } : {}),
  });
}

/** `AI Pop · −10 LUFS` — the chain, as a person would name it. */
export function chainLabel(style: string, targetLufs: number): string {
  return `${style} · ${targetLufs.toFixed(0)} LUFS`;
}

/**
 * The same record on the preview MP3.
 *
 * The preview is the file that actually gets passed around — emailed to a
 * label, dropped in a chat, uploaded for a first listen.  Leaving it as the
 * only export that says nothing about who made the track would be exactly
 * backwards.
 */
export async function stampPreview(input: MasterStampInput): Promise<Uint8Array> {
  const preview = await bytesAt(input.outputPath);
  let carried: Provenance | null = null;
  try { carried = readWavProvenance(await bytesAt(input.sourcePath)); } catch { carried = null; }
  const base = carried ?? emptyProvenance(input.fallbackTitle);
  const provenance = withAiStep(base, { kind: 'mastering', detail: input.chain });
  return stampMp3(preview, provenance, input.appVersion);
}
