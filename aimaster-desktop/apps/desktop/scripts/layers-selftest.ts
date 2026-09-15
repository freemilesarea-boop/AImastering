/**
 * layers-selftest — a message the user cannot see is the same as no message.
 *
 * The toast was `fixed z-50`.  The DAW's overlays are `z-[8000]`…`z-[9000]`,
 * siblings of it in the same stacking context, so opening the shortcut help
 * dropped a 70 %-black scrim over every notification the app raised — including
 * the ones raised BY a shortcut, which is when someone is most likely to be
 * reading them.  Measured before the fix: `document.elementFromPoint` at the
 * toast's own centre returned the help overlay's backdrop.
 *
 * So this holds one rule above all the others: NOTHING in the renderer stacks
 * at or above the notification layer.  It reads the numbers out of the source
 * rather than out of `LAYER`, because the defect was never a wrong constant —
 * it was a component that never asked.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:layers
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { LAYER, PLUGIN_WINDOW_BAND, pluginWindowLayer } from '../src/renderer/theme/layers.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** Source with comments removed, so a check reads code and not the prose about it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

/** Every renderer source that can paint — stories excluded, they never ship. */
const FILES = execSync(
  "find src/renderer \\( -name '*.tsx' -o -name '*.ts' \\) ! -name '*.stories.tsx' ! -path '*/public/*'",
  { encoding: 'utf8' },
).trim().split('\n');

/** Tailwind's own scale, for the `z-40` / `z-50` spellings. */
const TAILWIND_Z: Record<string, number> = {
  '0': 0, '10': 10, '20': 20, '30': 30, '40': 40, '50': 50, auto: 0,
};

interface Stack { file: string; line: number; text: string; value: number }

/**
 * Every stacking value the renderer asks for, resolved to a number.
 *
 * Three spellings, because all three are in the tree: the Tailwind scale
 * (`z-40`), an arbitrary Tailwind value (`z-[8000]`), and an inline
 * `zIndex:` — which may be a bare number, a `LAYER.x`, or `LAYER.x + n`.
 * An expression this cannot resolve is a FAILURE, not a skip: a value nobody
 * can evaluate is a value nobody is holding to the rule.
 */
function stacks(): { found: Stack[]; unresolved: Stack[] } {
  const found: Stack[] = [];
  const unresolved: Stack[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const at = { file, line: i + 1, text: line.trim().slice(0, 90) };

      for (const m of line.matchAll(/\bz-\[(\d+)\]/g)) {
        found.push({ ...at, value: Number(m[1]) });
      }
      for (const m of line.matchAll(/(?:^|[\s"'`{])z-(\d+)(?=[\s"'`}]|$)/g)) {
        const v = TAILWIND_Z[m[1] as string];
        if (v === undefined) unresolved.push({ ...at, value: NaN });
        else found.push({ ...at, value: v });
      }
      for (const m of line.matchAll(/zIndex:\s*([^,}\n]+)/g)) {
        const expr = (m[1] ?? '').trim();
        const bare = /^-?\d+$/.exec(expr);
        if (bare) { found.push({ ...at, value: Number(bare[0]) }); continue; }
        // The plugin band is a function, not a constant, because its input
        // is a runtime rank.  Resolve it to the highest it can ever reach —
        // if THAT is under the notifications, every rank is.
        if (/^pluginWindowLayer\(/.test(expr)) {
          found.push({ ...at, value: pluginWindowLayer(Number.MAX_SAFE_INTEGER) });
          continue;
        }
        const named = /^LAYER\.(\w+)(?:\s*([+-])\s*(\d+))?$/.exec(expr);
        if (named) {
          const base = (LAYER as Record<string, number>)[named[1] as string];
          if (base === undefined) { unresolved.push({ ...at, value: NaN }); continue; }
          const delta = named[3] === undefined ? 0 : Number(named[3]);
          found.push({ ...at, value: named[2] === '-' ? base - delta : base + delta });
          continue;
        }
        unresolved.push({ ...at, value: NaN });
      }
    });
  }
  return { found, unresolved };
}

const { found, unresolved } = stacks();

check('the sweep found the stacking values it is supposed to police', () => {
  // A rule that holds over nothing holds over nothing.  The tree had more
  // than twenty when this was written; anything near zero means the scan
  // stopped matching and every check below is vacuous.
  assert(found.length >= 20, `only ${found.length} stacking values found — the scan is not seeing the app`);
});

check('every stacking value in the renderer can be evaluated', () => {
  assert(unresolved.length === 0,
    `${unresolved.length} zIndex expression(s) nobody can check: `
    + unresolved.map((u) => `${u.file}:${u.line} ${u.text}`).join(' | '));
});

check('nothing stacks at or above the notification layer', () => {
  const over = found.filter((s) => s.value >= LAYER.notification
    && !s.file.endsWith('theme/layers.ts'));
  const offenders = over.filter((s) => !/LAYER\.notification/.test(s.text));
  assert(offenders.length === 0,
    `${offenders.length} surface(s) would cover a toast: `
    + offenders.map((o) => `${o.file}:${o.line} = ${o.value}`).join(' | '));
});

check('the notification layer is the top of the scale', () => {
  const top = Math.max(...Object.values(LAYER));
  assert(LAYER.notification === top,
    `LAYER.notification (${LAYER.notification}) is not the highest layer (${top})`);
  const others = Object.entries(LAYER).filter(([k]) => k !== 'notification');
  for (const [name, v] of others) {
    assert(v < LAYER.notification, `LAYER.${name} (${v}) is not below the notifications`);
  }
});

check('both things that notify actually sit on that layer', () => {
  // The toast and the update card.  Either one left behind is a class of
  // message the user stops seeing.
  for (const file of ['src/renderer/App.tsx', 'src/renderer/components/UpdateToast.tsx']) {
    assert(/zIndex: LAYER\.notification/.test(readFileSync(file, 'utf8')),
      `${file} does not put its notification on the notification layer`);
  }
});

check('the scrims that hid it are on the scale, not on magic numbers', () => {
  const scrims = [
    'src/renderer/components/daw/DawMediaBay.tsx',
    'src/renderer/components/daw/DawShortcutHelp.tsx',
    'src/renderer/components/daw/chain/RackPanel.tsx',
    'src/renderer/components/daw/smart/SmartControlPanel.tsx',
  ];
  for (const file of scrims) {
    const src = readFileSync(file, 'utf8');
    assert(/zIndex: LAYER\./.test(src), `${file} still picks its own stacking number`);
    assert(!/\bz-\[\d+\]/.test(src), `${file} still carries a z-[…] class`);
  }
});

check('a plugin window cannot climb out of its band', () => {
  // `z: top + 1` on every focus is unbounded, and PluginWindow renders
  // LAYER.pluginWindow + win.z.  Nothing goes wrong for a long time and then
  // a compressor window is above the toasts.  Ranks are 0…n-1 now.
  const store = stripComments(readFileSync('src/renderer/stores/pluginWindowStore.ts', 'utf8'));
  assert(!/z:\s*top \+ 1/.test(store), 'focus counts upward again — the band has no ceiling');
  assert(/rank\.set\(/.test(store), 'focus no longer re-ranks the windows');

  // And the clamp itself, because the re-ranking is only half of it: a saved
  // session, a restored window, anything that hands in a rank from elsewhere
  // must still land inside the band.
  const top = LAYER.pluginWindow + PLUGIN_WINDOW_BAND;
  assert(pluginWindowLayer(0) === LAYER.pluginWindow, 'the first window is the bottom of the band');
  assert(pluginWindowLayer(5) === LAYER.pluginWindow + 5, 'an ordinary rank is its own offset');
  assert(pluginWindowLayer(1e9) === top, 'an absurd rank is clamped to the top of the band');
  assert(pluginWindowLayer(-3) === LAYER.pluginWindow, 'a negative rank cannot dive under the band');
  assert(pluginWindowLayer(NaN) === LAYER.pluginWindow, 'a rank that is not a number is not a hole');
  assert(top < LAYER.popover, 'the band overlaps the layer above it');
  assert(top < LAYER.notification, 'the top of the band would cover a toast');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== layers: nothing covers a notification ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${found.length} stacking values across ${FILES.length} files`);
console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
