// Revision workflow data model (M3-REVISION-WORKFLOW).
//
// One source file can yield many mastering results ("revisions").  A
// revision is a COMPLETE master (a `audio:master` output): a WAV output +
// MP3 preview + loudness metrics + the options snapshot that produced it.
//
// This is purely additive over the existing single `masteringResult` —
// the first master migrates to "Revision 1".

import type { MasteringOptions } from '../../stores/audioStore.js';

export interface RevisionMetrics {
  integratedLufs: number;
  truePeakDbtp: number;
  lra?: number;
}

export interface MasteringRevision {
  id: string;
  /** Display label — "Revision 1", or a user rename. */
  label: string;
  /** Epoch ms. */
  createdAt: number;
  sourceFilePath: string;
  sourceFileName: string;
  /** The exact options that produced this revision. */
  optionsSnapshot: MasteringOptions;
  /** Loui preset id active when rendered (if any). */
  presetId?: string;
  /** Mastered WAV (temp) — the export-As-is source. */
  outputPath: string;
  /** MP3 preview (temp) — the audio/analyzer/A-B source. */
  previewPath: string;
  metrics: RevisionMetrics;
  /** Human format summary, e.g. "48 kHz · 24-bit". */
  formatSummary?: string;
  notes?: string;
  isFavorite?: boolean;
  renderDurationMs?: number;
}

export interface RevisionGroup {
  sourceFilePath: string;
  sourceFileName: string;
  activeRevisionId: string;
  revisions: MasteringRevision[];
}

/** Input to create a revision from a master result. */
export interface RevisionInput {
  sourceFilePath: string;
  sourceFileName: string;
  optionsSnapshot: MasteringOptions;
  presetId?: string;
  outputPath: string;
  previewPath: string;
  metrics: RevisionMetrics;
  formatSummary?: string;
  renderDurationMs?: number;
  /** Explicit label override (defaults to "Revision N" at insert time). */
  label?: string;
}
