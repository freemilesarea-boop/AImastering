// batch-rename.ts — rename many tracks or clips in one pass.
//
// After a stem split or an import you have "audio_01_bounced", "audio_02_
// bounced", twelve times.  Renaming them one at a time is the job this
// replaces, and every DAW that has it has the same three verbs:
//
//   • a NUMBERED pattern — "Gtr 1", "Gtr 2" — from a name plus a counter,
//   • find/replace, on the existing names,
//   • prefix / suffix, bolted onto whatever is there.
//
// The rule that makes it safe is that everything here is a PREVIEW first.
// `planRename` returns what each name would become without touching the
// session, so the dialog shows the twelve lines and the user reads them before
// anything happens.  Renaming is cheap to undo but expensive to notice.

const PAD_MAX = 6;

export type RenameKind = 'pattern' | 'replace' | 'affix';

export interface RenameOptions {
  kind: RenameKind;
  /**
   * The pattern for `kind: 'pattern'`.  `#` is the counter; a run of them sets
   * the width, so "Gtr ##" gives "Gtr 01".  A pattern with no `#` at all gets
   * the counter appended, because twelve tracks all named "Gtr" is never what
   * the user meant by asking to rename twelve things.
   */
  pattern?: string;
  /** First counter value.  Pro Tools starts at 1; so do we. */
  start?: number;
  /** Counter step, so "1, 3, 5" is reachable. */
  step?: number;
  /** For `kind: 'replace'` — what to look for.  Empty means no change. */
  find?: string;
  /** For `kind: 'replace'` — what to put there.  Empty deletes the match. */
  replace?: string;
  /** Case-insensitive matching for `find`. */
  ignoreCase?: boolean;
  /** For `kind: 'affix'`. */
  prefix?: string;
  suffix?: string;
  /** Trim whitespace off the result.  On by default — a trailing space is never wanted. */
  trim?: boolean;
}

export const DEFAULT_RENAME: Required<Pick<RenameOptions, 'start' | 'step' | 'trim' | 'ignoreCase'>> = {
  start: 1, step: 1, trim: true, ignoreCase: false,
};

/** One line of the preview. */
export interface RenameLine {
  id: string;
  from: string;
  to: string;
  /** True when this line would change nothing — greyed out in the dialog. */
  same: boolean;
}

export interface RenamePlan {
  lines: RenameLine[];
  /** How many names actually move. */
  changed: number;
  /** Names that would collide with another name in the SAME plan. */
  duplicates: string[];
}

export interface Renameable { id: string; name: string }

/**
 * Expand the counter marks in a pattern.
 *
 * A run of `#` is one field, padded to its own length: "##" at 7 is "07".
 * Several runs all get the same number — "A#-#" is "A1-1" — because a second
 * independent counter is a feature nobody has asked for and would need a
 * second start and step to be meaningful.
 */
export function expandPattern(pattern: string, n: number): string {
  if (!pattern.includes('#')) return `${pattern} ${n}`.trimStart();
  return pattern.replace(/#+/g, (run) => {
    const width = Math.min(run.length, PAD_MAX);
    return String(Math.abs(n)).padStart(width, '0');
  });
}

/** Escape a user string so it can go in a RegExp as a literal. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What one name becomes.  Exported so the tests can hit the rules directly. */
export function renameOne(name: string, options: RenameOptions, index: number): string {
  const start = options.start ?? DEFAULT_RENAME.start;
  const step = options.step ?? DEFAULT_RENAME.step;
  const trim = options.trim ?? DEFAULT_RENAME.trim;

  let out: string;
  switch (options.kind) {
    case 'pattern':
      out = expandPattern(options.pattern ?? '', start + index * step);
      break;
    case 'replace': {
      const find = options.find ?? '';
      if (find === '') { out = name; break; }
      const flags = options.ignoreCase ?? DEFAULT_RENAME.ignoreCase ? 'gi' : 'g';
      out = name.replace(new RegExp(escapeRe(find), flags), options.replace ?? '');
      break;
    }
    case 'affix':
      out = `${options.prefix ?? ''}${name}${options.suffix ?? ''}`;
      break;
    default:
      out = name;
  }
  const finished = trim ? out.trim() : out;
  // An empty name would make a nameless track in the mixer — refuse and keep
  // the old one instead, which the preview then shows as unchanged.
  return finished === '' ? name : finished;
}

/**
 * The whole preview.
 *
 * `index` is the position in the list GIVEN, not in the session: renaming the
 * three selected tracks of twelve numbers them 1, 2, 3, which is what selecting
 * three things and asking for a numbered pattern means.
 */
export function planRename(items: readonly Renameable[], options: RenameOptions): RenamePlan {
  const lines: RenameLine[] = items.map((item, i) => {
    const to = renameOne(item.name, options, i);
    return { id: item.id, from: item.name, to, same: to === item.name };
  });

  const seen = new Map<string, number>();
  for (const line of lines) seen.set(line.to, (seen.get(line.to) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort();

  return { lines, changed: lines.filter((l) => !l.same).length, duplicates };
}

/**
 * The plan as a lookup the caller applies.
 *
 * A map rather than a mutated session because the same plan renames tracks,
 * clips and playlists, which live in three different places — the caller knows
 * which, this does not.
 */
export function renameMap(plan: RenamePlan): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of plan.lines) if (!line.same) out.set(line.id, line.to);
  return out;
}

export function describeRename(plan: RenamePlan): string {
  if (plan.changed === 0) return '바뀌는 이름이 없습니다';
  const dup = plan.duplicates.length > 0
    ? ` — 같은 이름 ${plan.duplicates.length}개: ${plan.duplicates.slice(0, 3).join(', ')}`
    : '';
  return `${plan.changed}/${plan.lines.length}개 이름 변경${dup}`;
}
