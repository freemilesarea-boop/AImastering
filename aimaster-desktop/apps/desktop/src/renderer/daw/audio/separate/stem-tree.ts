// What a stem is, and which stems can exist.
//
// The first version had four flat stems.  This is the same four with the two
// that CAN be taken further taken further, arranged as a tree:
//
//     보컬 ─┬─ 리드
//           └─ 코러스
//     드럼 ─┬─ 킥
//           └─ 나머지 드럼
//     베이스
//     그 외
//
// ── Why the tree, rather than eight flat stems ───────────────────────────────
//
// The property that makes these stems an EDIT rather than eight new recordings
// is that they add back up to the record.  A tree keeps that at every level: a
// parent's children are masks that sum to the PARENT's mask, so any set of
// nodes that covers the tree exactly once — four parents, or eight leaves, or
// any mixture — still sums to one.  `coverIsValid` is what enforces it, and it
// is enforced rather than documented because "vocals AND lead" would silently
// double the singer.
//
// ── What is NOT here, and why ────────────────────────────────────────────────
//
// 기타 · 건반 · 스트링 · 신스 are not stems here, and adding them as buttons
// would be a lie.  Every split above rests on a cue that is physically in the
// signal — where a sound sits between the speakers, whether it is a transient
// or a note, which octave it lives in.  A guitar and an electric piano playing
// the same chord in the same place differ in TIMBRE, and nothing here can hear
// timbre.  Telling them apart is what a trained model is for; until there is
// one, "그 외" stays one stem and says so.
//
// 스네어 · 탐 · 심벌 are not separate stems either, and that one was NOT
// obvious — the code to split them was written, tuned and measured before it
// was cut.  A kick separates cleanly because it owns the bottom octave: 80 % of
// it comes back, and only 3 % of it leaks out.  A snare does not, because its
// wires are broadband noise in the same band as the hi-hat, AND the hi-hat is
// playing on every eighth note of almost every record ever made — so at the
// exact instant the classifier has to decide, both are sounding.  Every
// approach tried traded one for the other and none of them added up:
//
//     4분할  킥 80 · 스네어 11 · 탐 19 · 심벌 78
//     하이햇 바닥선을 빼고               킥 80 · 스네어 33 · 탐 13 · 심벌 60
//     심벌 템플릿을 8 kHz 위로           킥 80 · 스네어 24 · 탐 19 · 심벌 62
//     스네어+탐을 한 스템으로            킥 80 · 스네어·탐 32 · 심벌 60
//     킥 / 나머지 2분할                  킥 80 · 나머지 66      ← 이것만 맞는다
//
// A stem that returns a fifth of the instrument it is named after is not a
// stem, it is a disappointment with a label on it.  The two that survive are
// the two that ship.

export type StemKind =
  | 'vocals' | 'lead' | 'backing'
  | 'drums' | 'kick' | 'kit'
  | 'bass'
  | 'other';

export interface StemNode {
  kind: StemKind;
  parent: StemKind | null;
  children: readonly StemKind[];
  label: string;
  /** One line on what cue puts a sound here. */
  what: string;
  /** Colour, so a stem is the same colour in the panel and on its track. */
  color: string;
}

const NODES: readonly StemNode[] = [
  {
    kind: 'vocals', parent: null, children: ['lead', 'backing'],
    label: '보컬', what: '가운데에 있고 반복하지 않는 성분', color: '#d67f4f',
  },
  {
    kind: 'lead', parent: 'vocals', children: [],
    label: '리드', what: '정확히 한가운데 — 보통 한 사람', color: '#e09a6a',
  },
  {
    kind: 'backing', parent: 'vocals', children: [],
    label: '코러스', what: '보컬인데 가운데에서 벌어져 있는 것 — 겹쳐 부른 화음', color: '#c06a3a',
  },
  {
    kind: 'drums', parent: null, children: ['kick', 'kit'],
    label: '드럼', what: '넓은 대역을 한순간에 치고 지나가는 성분', color: '#4fd68f',
  },
  {
    kind: 'kick', parent: 'drums', children: [],
    label: '킥', what: '맨 아래에서 나는 타격 — 킥만 따로', color: '#3fa870',
  },
  {
    kind: 'kit', parent: 'drums', children: [],
    label: '나머지 드럼', what: '스네어 · 탐 · 심벌 · 하이햇 — 킥을 뺀 나머지', color: '#7fd6b0',
  },
  {
    kind: 'bass', parent: null, children: [],
    label: '베이스', what: '낮은 음과 그 배음 — 음을 따라갑니다', color: '#4f7fd6',
  },
  {
    kind: 'other', parent: null, children: [],
    label: '그 외', what: '나머지 — 기타 · 건반 · 신스 · 리버브', color: '#9f6fd6',
  },
];

const BY_KIND = new Map<StemKind, StemNode>(NODES.map((n) => [n.kind, n]));

export const STEM_TREE: readonly StemNode[] = NODES;

/** The four top-level stems, in the order they belong in an arrangement. */
export const TOP_STEMS: readonly StemKind[] = ['vocals', 'drums', 'bass', 'other'];

/** Everything split as far as it goes.  What "자세히" asks for. */
export const DETAILED_STEMS: readonly StemKind[] =
  ['lead', 'backing', 'kick', 'kit', 'bass', 'other'];

export function stemNode(kind: StemKind): StemNode {
  const node = BY_KIND.get(kind);
  if (!node) throw new Error(`알 수 없는 스템: ${kind}`);
  return node;
}

export function stemLabel(kind: StemKind): string {
  return stemNode(kind).label;
}

export function stemColor(kind: StemKind): string {
  return stemNode(kind).color;
}

/** The top-level stem a leaf belongs to — the mask it is carved out of. */
export function stemRoot(kind: StemKind): StemKind {
  const node = stemNode(kind);
  return node.parent === null ? kind : stemRoot(node.parent);
}

/** Depth-first order, so a list of stems reads like the tree looks. */
export function orderStems(kinds: readonly StemKind[]): StemKind[] {
  const wanted = new Set(kinds);
  const out: StemKind[] = [];
  const visit = (kind: StemKind): void => {
    if (wanted.has(kind)) out.push(kind);
    for (const child of stemNode(kind).children) visit(child);
  };
  for (const top of TOP_STEMS) visit(top);
  return out;
}

export interface CoverProblem {
  /** Stems that are in the set twice over — a parent and one of its children. */
  overlapping: StemKind[];
  /** Parts of the record no stem in the set would carry. */
  missing: StemKind[];
}

/**
 * Does this set of stems cover the record exactly once?
 *
 * A set that contains both 보컬 and 리드 would write the lead vocal into two
 * files, and playing them together would be the singer at double level — the
 * kind of wrong that sounds like the separator is broken rather than like the
 * user asked for something impossible.  A set missing 베이스 is not wrong at
 * all, it just no longer reconstructs; the caller is told which it is.
 */
export function coverProblems(kinds: readonly StemKind[]): CoverProblem {
  const wanted = new Set(kinds);
  const overlapping: StemKind[] = [];
  const missing: StemKind[] = [];

  const visit = (kind: StemKind, coveredByAncestor: boolean): void => {
    const node = stemNode(kind);
    const here = wanted.has(kind);
    if (here && coveredByAncestor) overlapping.push(kind);
    const covered = coveredByAncestor || here;
    if (node.children.length === 0) {
      if (!covered) missing.push(kind);
      return;
    }
    for (const child of node.children) visit(child, covered);
  };
  for (const top of TOP_STEMS) visit(top, false);
  return { overlapping, missing };
}

export function coverIsValid(kinds: readonly StemKind[]): boolean {
  const { overlapping, missing } = coverProblems(kinds);
  return overlapping.length === 0 && missing.length === 0;
}

/**
 * Toggling one stem, keeping the set a valid cover.
 *
 * Turning a leaf ON turns its siblings on and its parent off, and turning it
 * OFF collapses the family back to the parent.  Anything else would need the
 * user to understand the invariant, and they should not have to.
 */
export function toggleStem(kinds: readonly StemKind[], kind: StemKind): StemKind[] {
  const wanted = new Set(kinds);
  const node = stemNode(kind);
  if (wanted.has(kind)) {
    // Off: fold this family back into its parent, or — for a top-level stem
    // with no parent to fold into — drop it and let the cover be incomplete.
    if (node.parent === null) {
      for (const k of family(kind)) wanted.delete(k);
    } else {
      for (const sibling of stemNode(node.parent).children) {
        for (const k of family(sibling)) wanted.delete(k);
      }
      wanted.add(node.parent);
    }
  } else {
    if (node.parent !== null) {
      // On: the whole level comes on together, and the parent steps aside.
      wanted.delete(node.parent);
      for (const sibling of stemNode(node.parent).children) {
        if (sibling !== kind) {
          const already = family(sibling).some((k) => wanted.has(k));
          if (!already) wanted.add(sibling);
        }
      }
    } else {
      for (const k of family(kind)) wanted.delete(k);
    }
    wanted.add(kind);
  }
  return orderStems([...wanted]);
}

/** A stem and everything under it. */
export function family(kind: StemKind): StemKind[] {
  const out: StemKind[] = [kind];
  for (const child of stemNode(kind).children) out.push(...family(child));
  return out;
}
