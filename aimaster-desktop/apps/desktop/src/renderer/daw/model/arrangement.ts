// Sections — the shape of the song, as data.
//
// Markers already exist and are the wrong tool for this: a marker is a POINT,
// and "the chorus" is a RANGE.  Two markers pretending to be a range is how you
// get gaps, overlaps, and an editor that cannot answer "what is at 1:12".
//
// So a section is stored as a start only, and its end is the next section's
// start.  That single decision removes a whole class of bugs:
//
//   NO GAPS AND NO OVERLAPS ARE REPRESENTABLE.  There is nothing to keep in
//   sync, because the end is not stored anywhere to drift from.
//
//   MOVING A BOUNDARY IS ONE EDIT.  Dragging the line between the verse and
//   the chorus moves both of them, which is what dragging that line means.
//
//   EVERY POINT IN THE SONG HAS EXACTLY ONE ANSWER.  `sectionAt` is a lookup,
//   not a search through overlapping ranges with a tie-break rule.
//
// Everything here is pure.  The ripple edits that MOVE audio when a section is
// duplicated or deleted live in edit/arrange-ops.ts.

import { nextId } from './ids.js';
import type { DawSession } from './types.js';

/**
 * What a section is, musically.
 *
 * A closed list rather than free text, because the kind is what colours the
 * lane and what a future feature would reason about ("make the last chorus
 * bigger").  `custom` exists so the list never becomes a cage.
 */
export type SectionKind =
  | 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge'
  | 'solo' | 'breakdown' | 'drop' | 'outro' | 'custom';

export interface Section {
  id: string;
  /** What it is called.  Empty means "use the kind's own name". */
  name: string;
  kind: SectionKind;
  /** Timeline seconds.  The END is the next section's start — never stored. */
  startSec: number;
}

/** The default name and colour of each kind, in the app's language. */
export const SECTION_KINDS: ReadonlyArray<{
  kind: SectionKind; label: string; color: string;
}> = [
  { kind: 'intro',     label: '인트로',   color: '#5B7C99' },
  { kind: 'verse',     label: '벌스',     color: '#4F8A6B' },
  { kind: 'prechorus', label: '프리코러스', color: '#7A8A4F' },
  { kind: 'chorus',    label: '코러스',   color: '#C6A768' },
  { kind: 'bridge',    label: '브리지',   color: '#8A6BA8' },
  { kind: 'solo',      label: '솔로',     color: '#A8746B' },
  { kind: 'breakdown', label: '브레이크', color: '#6B7A8A' },
  { kind: 'drop',      label: '드롭',     color: '#B85C5C' },
  { kind: 'outro',     label: '아웃트로', color: '#5F5F7A' },
  { kind: 'custom',    label: '구간',     color: '#7A7A7A' },
];

export function kindLabel(kind: SectionKind): string {
  return SECTION_KINDS.find((k) => k.kind === kind)?.label ?? '구간';
}

export function kindColor(kind: SectionKind): string {
  return SECTION_KINDS.find((k) => k.kind === kind)?.color ?? '#7A7A7A';
}

/** What to show on the lane: the given name, or the kind's own. */
export function sectionLabel(section: Section): string {
  return section.name.trim() || kindLabel(section.kind);
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * The session's sections, sorted.
 *
 * Absent in sessions written before sections existed, which is why every
 * reader goes through this rather than touching `session.sections`.
 */
export function sectionsOf(session: DawSession): Section[] {
  const raw = (session as { sections?: Section[] }).sections;
  if (!Array.isArray(raw)) return [];
  return [...raw]
    .filter((s) => !!s && typeof s.id === 'string' && Number.isFinite(s.startSec))
    .sort((a, b) => a.startSec - b.startSec);
}

export function withSections(session: DawSession, sections: readonly Section[]): DawSession {
  return {
    ...session,
    sections: [...sections].sort((a, b) => a.startSec - b.startSec),
  } as DawSession;
}

export interface SectionRange {
  section: Section;
  startSec: number;
  /** The next section's start, or `songEndSec` for the last one. */
  endSec: number;
  index: number;
}

/**
 * Every section as a range.
 *
 * `songEndSec` is what the LAST section runs to.  The caller supplies it
 * because "where the song ends" is a question about the clips, not about the
 * sections, and this module deliberately does not know about clips.
 */
export function sectionRanges(
  sections: readonly Section[], songEndSec: number,
): SectionRange[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  return sorted.map((section, index) => {
    const next = sorted[index + 1];
    return {
      section,
      index,
      startSec: section.startSec,
      endSec: next ? next.startSec : Math.max(section.startSec, songEndSec),
    };
  });
}

/** The section a moment is inside, or null before the first one. */
export function sectionAt(
  sections: readonly Section[], timeSec: number,
): Section | null {
  let found: Section | null = null;
  for (const section of [...sections].sort((a, b) => a.startSec - b.startSec)) {
    if (section.startSec <= timeSec + 1e-9) found = section; else break;
  }
  return found;
}

/** One section's range, or null when it is not in the list. */
export function rangeOf(
  sections: readonly Section[], sectionId: string, songEndSec: number,
): SectionRange | null {
  return sectionRanges(sections, songEndSec).find((r) => r.section.id === sectionId) ?? null;
}

/** The section before / after a moment — what the jump shortcuts land on. */
export function nextSectionStart(
  sections: readonly Section[], timeSec: number,
): number | null {
  for (const section of [...sections].sort((a, b) => a.startSec - b.startSec)) {
    if (section.startSec > timeSec + 1e-6) return section.startSec;
  }
  return null;
}

export function previousSectionStart(
  sections: readonly Section[], timeSec: number,
): number | null {
  let best: number | null = null;
  for (const section of [...sections].sort((a, b) => a.startSec - b.startSec)) {
    if (section.startSec < timeSec - 1e-6) best = section.startSec; else break;
  }
  return best;
}

// ── Editing the list ──────────────────────────────────────────────────────────

/** Two boundaries closer than this are the same boundary. */
export const MIN_SECTION_SEC = 0.05;

export type SectionEdit =
  | { ok: true; sections: Section[] }
  | { ok: false; reason: string };

export function createSection(
  kind: SectionKind, startSec: number, name = '',
): Section {
  return { id: nextId('sect'), kind, startSec: Math.max(0, startSec), name };
}

/**
 * Add a section boundary.
 *
 * Refused when it lands on top of one that is already there: two boundaries at
 * the same second would make a zero-length section, and a zero-length section
 * is a row in the lane that can never be clicked.
 */
export function addSection(
  sections: readonly Section[], section: Section,
): SectionEdit {
  const at = Math.max(0, section.startSec);
  if (sections.some((s) => Math.abs(s.startSec - at) < MIN_SECTION_SEC)) {
    return { ok: false, reason: '이미 여기에 구간 경계가 있습니다' };
  }
  return {
    ok: true,
    sections: [...sections, { ...section, startSec: at }]
      .sort((a, b) => a.startSec - b.startSec),
  };
}

export function removeSectionMarker(
  sections: readonly Section[], sectionId: string,
): Section[] {
  return sections.filter((s) => s.id !== sectionId);
}

export function renameSection(
  sections: readonly Section[], sectionId: string, name: string,
): Section[] {
  return sections.map((s) => (s.id === sectionId
    ? { ...s, name: name.replace(/\s+/g, ' ').trim().slice(0, 40) } : s));
}

export function setSectionKind(
  sections: readonly Section[], sectionId: string, kind: SectionKind,
): Section[] {
  return sections.map((s) => (s.id === sectionId ? { ...s, kind } : s));
}

/**
 * Move a boundary.
 *
 * Clamped between its neighbours rather than allowed past them: a boundary
 * that overtakes the next one would silently reorder the song, and dragging a
 * line is never a request to reorder anything.
 */
export function moveSectionStart(
  sections: readonly Section[], sectionId: string, toSec: number,
): Section[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  const index = sorted.findIndex((s) => s.id === sectionId);
  const target = sorted[index];
  if (index < 0 || !target) return [...sections];
  const before = sorted[index - 1];
  const after = sorted[index + 1];
  const lo = before ? before.startSec + MIN_SECTION_SEC : 0;
  const hi = after ? after.startSec - MIN_SECTION_SEC : Infinity;
  const next = Math.min(hi, Math.max(lo, toSec));
  if (Math.abs(next - target.startSec) < 1e-9) return [...sections];
  sorted[index] = { ...target, startSec: next };
  return sorted;
}

/**
 * Shift every boundary at or after `fromSec` by `deltaSec`.
 *
 * The list half of a ripple edit; `edit/arrange-ops.ts` does the same to the
 * clips, the automation, the markers and the tempo map in the same breath.
 */
export function shiftSections(
  sections: readonly Section[], fromSec: number, deltaSec: number,
): Section[] {
  if (deltaSec === 0) return [...sections];
  return sections
    .map((s) => (s.startSec >= fromSec - 1e-9
      ? { ...s, startSec: Math.max(0, s.startSec + deltaSec) } : s))
    .sort((a, b) => a.startSec - b.startSec);
}

// ── Describing ────────────────────────────────────────────────────────────────

/** `인트로 · 벌스 · 코러스` — the song's shape, in one line. */
export function describeArrangement(sections: readonly Section[]): string {
  if (sections.length === 0) return '구간 없음';
  return [...sections]
    .sort((a, b) => a.startSec - b.startSec)
    .map(sectionLabel)
    .join(' · ');
}

/** `0:32 → 1:04 (32.0초)` — one section's extent, for a tooltip. */
export function describeRange(range: SectionRange): string {
  const clock = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  return `${clock(range.startSec)} → ${clock(range.endSec)} (${(range.endSec - range.startSec).toFixed(1)}초)`;
}
