// Bring files into the session that is already open.
//
// Both the toolbar buttons and a drag-and-drop onto the DAW window end up
// here, so "가져오기" means the same thing however you asked for it: tracks
// appear in the session you are looking at, the undo stack keeps them, and the
// page does not change underneath you.

import { useDawStore } from '../../stores/dawStore.js';
import { importAudioFiles } from '../model/import-audio.js';
import { importMidiFile } from '../io/midi-file.js';
import { addTrack, createMidiPart, createTrack, updateClips } from '../model/session-ops.js';
import { toFileUrl } from '../../utils/fileUrl.js';
import type { DecodeProgress } from '../engine/audio-cache.js';
import type { ClipId, TrackId } from '../model/types.js';

export interface SessionImportReport {
  audioTracks: number;
  midiParts: number;
  /** Audio files that would not decode.  MIDI failures throw instead. */
  failed: string[];
  /** Tempo the MIDI file carried, when one was imported. */
  tempoBpm: number | null;
  /** How many MIDI parts carried per-note expression. */
  mpeParts: number;
  /** The first part imported, so a caller can open it in the Key Editor. */
  firstMidiPart: { trackId: TrackId; clipId: ClipId } | null;
}

const EMPTY: SessionImportReport = {
  audioTracks: 0, midiParts: 0, failed: [], tempoBpm: null, mpeParts: 0, firstMidiPart: null,
};

/**
 * Add audio files and MIDI files to the open session.
 *
 * Audio lands at `atSec`, one track per file.  MIDI brings its own tempo and
 * time signature with it — a MIDI file that disagrees with the session is
 * almost always the one that is right, because it was written to a grid.
 */
export async function importIntoSession(
  audio: readonly string[], midi: readonly string[], atSec = 0,
  onProgress?: DecodeProgress,
): Promise<SessionImportReport> {
  if (audio.length === 0 && midi.length === 0) return EMPTY;

  const report: SessionImportReport = { ...EMPTY, failed: [] };

  if (audio.length > 0) {
    const result = await importAudioFiles(
      useDawStore.getState().session, audio, Math.max(0, atSec), onProgress,
    );
    useDawStore.getState().apply(() => result.session);
    report.audioTracks = result.trackIds.length;
    report.failed = result.failed;
  }

  for (const path of midi) {
    const response = await fetch(toFileUrl(path));
    if (!response.ok) throw new Error(`MIDI 로드 실패 (${response.status})`);
    const imported = importMidiFile(new Uint8Array(await response.arrayBuffer()));
    if (imported.parts.length === 0) continue;

    let firstOpen: { trackId: TrackId; clipId: ClipId } | null = null;
    useDawStore.getState().apply((s) => {
      let next = { ...s, tempoBpm: imported.tempoBpm, timeSignature: imported.timeSignature };
      for (const part of imported.parts) {
        const track = createTrack(part.name || 'MIDI', 'instrument');
        const clip = createMidiPart(part.name || 'MIDI', {
          startSec: Math.max(0, atSec),
          durationSec: Math.max(1, part.durationSec),
          notes: part.notes,
          controllers: part.controllers,
          midiConfig: { bendRangeSemitones: part.bendRangeSemitones, mpe: part.mpe },
        });
        next = updateClips(addTrack(next, track), track.id, () => [clip]);
        if (!firstOpen) firstOpen = { trackId: track.id, clipId: clip.id };
      }
      return next;
    });

    report.midiParts += imported.parts.length;
    report.mpeParts += imported.parts.filter((p) => p.mpe).length;
    report.tempoBpm = imported.tempoBpm;
    if (!report.firstMidiPart) report.firstMidiPart = firstOpen;
  }

  return report;
}

/** One sentence describing what an import did, for the toast. */
export function describeImport(report: SessionImportReport): string {
  const parts: string[] = [];
  if (report.audioTracks > 0) parts.push(`오디오 ${report.audioTracks}트랙`);
  if (report.midiParts > 0) {
    const tempo = report.tempoBpm !== null ? ` · ${report.tempoBpm.toFixed(0)} BPM` : '';
    const mpe = report.mpeParts > 0 ? ` · MPE ${report.mpeParts}개` : '';
    parts.push(`MIDI ${report.midiParts}파트${tempo}${mpe}`);
  }
  if (parts.length === 0) return '가져올 것이 없었습니다';
  const failed = report.failed.length > 0 ? ` · ${report.failed.length}개 실패` : '';
  return `${parts.join(' · ')} 추가${failed}`;
}
