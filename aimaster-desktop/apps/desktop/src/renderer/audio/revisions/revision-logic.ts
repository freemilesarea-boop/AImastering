// Pure revision-group logic (M3-REVISION-WORKFLOW).  No React, no store —
// every function is a pure transform so it can be unit-tested headlessly.

import type { MasteringOptions } from '../../stores/audioStore.js';
import type {
  MasteringRevision,
  RevisionGroup,
  RevisionInput,
  RevisionMetrics,
} from './revision-types.js';

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Next "Revision N" label given the current group size. */
export function nextRevisionLabel(group: RevisionGroup | null): string {
  const n = (group?.revisions.length ?? 0) + 1;
  return `Revision ${n}`;
}

/** Build a revision from a master result + the options that produced it. */
export function createRevision(input: RevisionInput, label: string): MasteringRevision {
  return {
    id: genId(),
    label: input.label ?? label,
    createdAt: Date.now(),
    sourceFilePath: input.sourceFilePath,
    sourceFileName: input.sourceFileName,
    optionsSnapshot: { ...input.optionsSnapshot },
    ...(input.presetId !== undefined ? { presetId: input.presetId } : {}),
    outputPath: input.outputPath,
    previewPath: input.previewPath,
    metrics: { ...input.metrics },
    ...(input.formatSummary !== undefined ? { formatSummary: input.formatSummary } : {}),
    ...(input.renderDurationMs !== undefined ? { renderDurationMs: input.renderDurationMs } : {}),
  };
}

/** Start a new group from the first revision (it becomes active). */
export function initGroup(input: RevisionInput): RevisionGroup {
  const rev = createRevision(input, 'Revision 1');
  return {
    sourceFilePath: input.sourceFilePath,
    sourceFileName: input.sourceFileName,
    activeRevisionId: rev.id,
    revisions: [rev],
  };
}

/**
 * Add a revision to a group (created from `input`); the new revision
 * becomes active.  If `group` is null, starts a fresh group.
 */
export function addRevision(group: RevisionGroup | null, input: RevisionInput): RevisionGroup {
  if (!group || group.sourceFilePath !== input.sourceFilePath) {
    return initGroup(input);
  }
  const rev = createRevision(input, nextRevisionLabel(group));
  return {
    ...group,
    activeRevisionId: rev.id,
    revisions: [...group.revisions, rev],
  };
}

/** Select an existing revision as active (no-op if id unknown). */
export function setActiveRevision(group: RevisionGroup, id: string): RevisionGroup {
  if (!group.revisions.some((r) => r.id === id)) return group;
  return { ...group, activeRevisionId: id };
}

/**
 * Remove a revision.  Never removes the LAST one (a group always keeps at
 * least one revision; the source file is separate and never deleted here).
 * If the active revision is removed, the previous one becomes active.
 */
export function removeRevision(group: RevisionGroup, id: string): RevisionGroup {
  if (group.revisions.length <= 1) return group;
  const idx = group.revisions.findIndex((r) => r.id === id);
  if (idx < 0) return group;
  const revisions = group.revisions.filter((r) => r.id !== id);
  let activeRevisionId = group.activeRevisionId;
  if (activeRevisionId === id) {
    const fallback = revisions[Math.max(0, idx - 1)] ?? revisions[0]!;
    activeRevisionId = fallback.id;
  }
  return { ...group, activeRevisionId, revisions };
}

function patchRevision(group: RevisionGroup, id: string, patch: Partial<MasteringRevision>): RevisionGroup {
  return { ...group, revisions: group.revisions.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

export function renameRevision(group: RevisionGroup, id: string, label: string): RevisionGroup {
  const trimmed = label.trim();
  if (!trimmed) return group;
  return patchRevision(group, id, { label: trimmed });
}

export function toggleFavorite(group: RevisionGroup, id: string): RevisionGroup {
  const rev = group.revisions.find((r) => r.id === id);
  if (!rev) return group;
  return patchRevision(group, id, { isFavorite: !rev.isFavorite });
}

export function getActiveRevision(group: RevisionGroup | null): MasteringRevision | undefined {
  if (!group) return undefined;
  return group.revisions.find((r) => r.id === group.activeRevisionId);
}

/** The baseline (first) revision — A in the A/B compare. */
export function getBaselineRevision(group: RevisionGroup | null): MasteringRevision | undefined {
  return group?.revisions[0];
}

// ── Display helpers ───────────────────────────────────────────────────

export function formatMetrics(m: RevisionMetrics): string {
  const lra = typeof m.lra === 'number' ? ` · LRA ${m.lra.toFixed(1)}` : '';
  return `${m.integratedLufs.toFixed(1)} LUFS · TP ${m.truePeakDbtp.toFixed(1)} dBTP${lra}`;
}

/** Short options summary for a revision card. */
export function formatOptionsSummary(o: MasteringOptions): string {
  const parts = [
    `${o.targetLufs.toFixed(1)} LUFS`,
    `${o.targetTp.toFixed(1)} dBTP`,
  ];
  if (typeof o.stereoWidth === 'number' && o.stereoWidth !== 1) parts.push(`W ${Math.round(o.stereoWidth * 100)}%`);
  if (typeof o.outputGainDb === 'number' && o.outputGainDb !== 0) parts.push(`G ${o.outputGainDb > 0 ? '+' : ''}${o.outputGainDb.toFixed(1)}`);
  return parts.join(' · ');
}

/** Whether `options`+`presetId` match an existing revision (duplicate badge). */
export function findDuplicate(
  group: RevisionGroup | null,
  options: MasteringOptions,
  presetId?: string,
): MasteringRevision | undefined {
  if (!group) return undefined;
  const keys: (keyof MasteringOptions)[] = ['style', 'targetLufs', 'targetTp', 'sampleRate', 'bitDepth', 'limiterStrength', 'stereoWidth', 'outputGainDb', 'saturationAmount'];
  return group.revisions.find((r) => {
    if ((r.presetId ?? undefined) !== (presetId ?? undefined)) return false;
    return keys.every((k) => (r.optionsSnapshot[k] ?? undefined) === (options[k] ?? undefined));
  });
}
