// 치트시트 — the keyboard on one page, next to the monitor.
//
// A student has three places to look up a key: the `?` overlay, a right-click
// menu, and the palette.  All three need the app to be in front of them and a
// hand on the mouse.  What a beginner actually wants, for the first week, is a
// sheet of paper beside the screen — and the sheet has to be THEIRS: their
// remaps, their keymap preset, the stage their class is on.
//
// So this builds the page from the live table rather than shipping a picture
// of the factory defaults, which would be wrong for anybody who changed a key
// and wrong for everybody the day a default changes.
//
// ── Why HTML ────────────────────────────────────────────────────────────────
//
// There is no PDF path in this app — nothing wires Electron's printToPDF —
// and inventing one for a cheat sheet is a lot of surface for a sheet of
// paper.  A self-contained HTML file opens in any browser and prints from
// there, which is the shortest honest route from "I want this on my wall" to
// paper.  Self-contained matters: no fonts, no stylesheet, no script to fetch,
// so it still prints on a classroom machine with no network.

import { SHORTCUTS, type CommandId, type ShortcutDef } from './definitions.js';
import { describeSpec, effectiveChords, isOverridden, type Overrides } from './key-overrides.js';
import type { Platform } from './keys.js';
import { stageOf } from './lesson-plan.js';

/** Text into HTML.  A label with a `<` in it must print, not break the page. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface CheatSheetInput {
  /** What this sheet is — a stage's title, or the whole table. */
  title: string;
  /** In the order they should print. */
  commands: readonly CommandId[];
  overrides: Overrides;
  platform: Platform;
  /** For the footer, so a printed sheet says when it was true. */
  printedAt: Date;
}

/**
 * One self-contained HTML page.
 *
 * Two columns at A4 width, the chord in a monospace chip, the command's note
 * under its name — a sheet with only names and keys is a list, and a list does
 * not answer "which one was that".  Changed keys are marked, because a
 * student comparing their sheet with a classmate's needs to know which lines
 * are their own doing.
 */
export function buildCheatSheet(input: CheatSheetInput): string {
  const rows = input.commands
    .map((id) => SHORTCUTS.find((s) => s.id === id))
    .filter((def): def is ShortcutDef => def !== undefined);

  // A badge that is the same on every row says nothing: a stage's own sheet
  // already carries the stage in its title, and twelve "1단계" chips down the
  // page are noise.  On the whole table they are the map of the course.
  const stages = new Set(rows.map((def) => stageOf(def.id)));
  const showStage = stages.size > 1;

  const items = rows.map((def) => {
    const chords = effectiveChords(def, input.overrides)
      .map((spec) => describeSpec(spec, input.platform));
    const changed = isOverridden(def.id, input.overrides);
    const stage = showStage ? stageOf(def.id) : null;
    return `      <li class="row${changed ? ' changed' : ''}">
        <div class="what">
          <span class="label">${esc(def.label)}</span>${stage === null ? '' : `<span class="stage">${stage}단계</span>`}
          <span class="note">${esc(def.note)}</span>
        </div>
        <div class="keys">${chords.length === 0
          ? '<span class="none">없음</span>'
          : chords.map((c) => `<kbd>${esc(c)}</kbd>`).join('<span class="slash">/</span>')}</div>
      </li>`;
  }).join('\n');

  const stamp = input.printedAt.toISOString().slice(0, 16).replace('T', ' ');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${esc(input.title)} — 단축키</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11px/1.35 -apple-system, "Segoe UI", system-ui, sans-serif; color: #111; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .sub { font-size: 10px; color: #666; margin: 0 0 10px; }
  ul { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 10mm; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 6px;
         break-inside: avoid; padding: 2.5px 0; border-bottom: 1px solid #eee; }
  .what { min-width: 0; }
  .label { font-weight: 600; }
  .stage { font-size: 8px; color: #666; border: 1px solid #ccc; border-radius: 3px;
           padding: 0 3px; margin-left: 4px; vertical-align: 1px; }
  .note { display: block; font-size: 9px; color: #666; }
  .keys { white-space: nowrap; flex-shrink: 0; }
  kbd { font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        border: 1px solid #bbb; border-bottom-width: 2px; border-radius: 3px;
        padding: 2px 4px; background: #fafafa; }
  .slash { color: #bbb; margin: 0 2px; font-size: 9px; }
  .none { font-size: 9px; color: #999; }
  .changed .label::after { content: " ●"; color: #0a7; font-size: 8px; }
  footer { margin-top: 8px; font-size: 9px; color: #888; }
  @media print { footer { position: fixed; bottom: 0; } }
</style>
</head>
<body>
  <h1>${esc(input.title)}</h1>
  <p class="sub">${rows.length}개 · ${input.platform === 'mac' ? 'macOS (⌘ / ⌥)' : 'Windows (Ctrl / Alt)'} 기준 · ● 는 직접 바꾼 키</p>
  <ul>
${items}
  </ul>
  <footer>LV DAW · ${esc(stamp)} 기준 — 키를 바꾸면 이 종이가 아니라 앱이 맞습니다</footer>
</body>
</html>
`;
}
