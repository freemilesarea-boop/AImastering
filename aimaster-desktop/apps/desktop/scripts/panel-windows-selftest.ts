/**
 * panel-windows-selftest.ts — panels you can tear off the tab strip.
 *
 * The tab strip shows ONE panel at a time, and most of the work is two at
 * once: a fader while watching the arrangement, notes while watching the
 * mixer, a reference against the spectrum.  A strip of tabs can only ever
 * answer "which one INSTEAD of the other".
 *
 * `pluginWindowStore` had already made this argument, in its own docblock,
 * for plugins — the compressor and the EQ both in front of you while the
 * track plays.  This is the same idea aimed at the panels, built to the same
 * shape so a person who has learnt one floating window has learnt them all.
 *
 * AND ONE LIST INSTEAD OF TWO.  The tab strip spelled its labels out in a
 * thirteen-arm ternary; the body switch repeated the same thirteen names a
 * hundred and forty lines further down.  Two parallel lists of the same
 * things drift, and the drift is silent: a tab that opens nothing, or a panel
 * nothing can reach.  Both now come from DAW_PANELS, and the checks below are
 * mostly about keeping it that way.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DAW_PANELS, panelLabel, type DawWindow,
} from '../src/renderer/daw/model/view-window.js';
import {
  nextPanelPosition, topZ, PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT,
  type PanelWindowState,
} from '../src/renderer/stores/panelWindowStore.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const win = (id: DawWindow, z: number): PanelWindowState =>
  ({ id, x: 0, y: 0, width: 720, height: 420, z });

// ── 1. The registry ─────────────────────────────────────────────────────────

check('every panel has a label', DAW_PANELS.every((p) => p.label.length > 0));

check('no two panels share an id',
  new Set(DAW_PANELS.map((p) => p.id)).size === DAW_PANELS.length);

check('no two panels share a label',
  new Set(DAW_PANELS.map((p) => p.label)).size === DAW_PANELS.length);

check('panelLabel finds what the strip shows',
  panelLabel('mix') === 'MIX' && panelLabel('midi') === 'KEY');

// A window id the registry has never heard of should still be nameable — a
// floating window with a blank title bar is worse than one named clumsily.
check('an unknown id still gets a title rather than nothing',
  panelLabel('nonesuch' as DawWindow) === 'NONESUCH');

// ── 2. Where a torn-off panel lands ────────────────────────────────────────

check('the first panel lands somewhere on screen',
  nextPanelPosition(0).x > 0 && nextPanelPosition(0).y > 0);

// Two windows opened one after the other and placed identically look like ONE
// window, and the second appears not to have opened.
check('the second does not land exactly on the first',
  nextPanelPosition(1).x !== nextPanelPosition(0).x
  || nextPanelPosition(1).y !== nextPanelPosition(0).y);

check('the cascade wraps rather than marching off the screen',
  nextPanelPosition(60).x < 1000 && nextPanelPosition(60).y < 1000,
  `${JSON.stringify(nextPanelPosition(60))}`);

// ── 3. Stacking ────────────────────────────────────────────────────────────

check('the first window opens above nothing', topZ([]) === 1);

check('focusing puts a window above every other',
  topZ([win('mix', 1), win('edit', 7), win('chain', 3)]) > 7);

// ── 4. A floating panel is worth tearing off ───────────────────────────────

// A mixer squeezed into a tooltip is not a mixer; the commonest reason a
// floating panel is closed again at once is that it opened too small to do
// the job it was opened for.
check('the minimum size is big enough to be a panel',
  PANEL_MIN_WIDTH >= 320 && PANEL_MIN_HEIGHT >= 200,
  `${PANEL_MIN_WIDTH}×${PANEL_MIN_HEIGHT}`);

// ── 5. The wiring, read from code and not from comments ────────────────────

const page  = stripComments(read('src/renderer/pages/DawPage.tsx'));
const layer = stripComments(read('src/renderer/components/daw/PanelWindowLayer.tsx'));
const store = stripComments(read('src/renderer/stores/panelWindowStore.ts'));

check('the tab strip is built from the registry, not from a ternary',
  /DAW_PANELS\.map\s*\(/.test(page));

// The defect this replaces: thirteen names in the strip and thirteen more in
// the body switch.  If either list is spelled out again, they can drift again.
check('the labels are not spelled out a second time in the page',
  !/'EDIT'[\s\S]{0,400}?'SPECTRAL'/.test(page));

check('one renderer serves both the dock and the float',
  /function renderPanel\s*\(/.test(page)
  && /renderPanel\(windowMode\)/.test(page)
  && /<PanelWindowLayer\s+render=\{renderPanel\}/.test(page));

check('a tab can tear its panel off',
  /onDoubleClick=\{\(\)\s*=>\s*floatPanel\(/.test(page));

// Floating must not be a silent state: the strip says where the copy went.
check('the strip marks a panel that is also floating',
  /floatingIds\.includes\(/.test(page));

check('the window can be dragged, resized and closed',
  /onPointerDown=\{onTitleDown\}/.test(layer)
  && /resize\(win\.id/.test(layer)
  && /close\(win\.id\)/.test(layer));

// A fast drag outsprints the element; listening on it would drop the window
// mid-move when the pointer crossed onto whatever is underneath.
check('drag listens on the window, not on the frame it is moving',
  /window\.addEventListener\('pointermove'/.test(layer)
  && /window\.removeEventListener\('pointermove'/.test(layer));

check('tearing off a panel that is already out focuses it instead of doubling it',
  /float:\s*\(id\)\s*=>\s*\{[\s\S]{0,300}?some\(\(w\)\s*=>\s*w\.id === id\)[\s\S]{0,80}?focus\(id\)/
    .test(store));

// Dragged off the top or the left, the title bar is unreachable and the
// window can never be brought back.
check('a window cannot be dragged out of reach',
  /move:[\s\S]{0,300}?Math\.max\(0, x\)[\s\S]{0,60}?Math\.max\(0, y\)/.test(store));

check('resize cannot make a panel smaller than its minimum',
  /resize:[\s\S]{0,400}?Math\.max\(PANEL_MIN_WIDTH/.test(store));

// ── 6. The sweep is looking at the real thing ──────────────────────────────

check('the sources were actually read',
  page.length > 20_000 && layer.length > 3_000 && store.length > 2_000,
  `${page.length}/${layer.length}/${store.length}`);

check('stripComments removes comments but keeps code',
  !stripComments('// DAW_PANELS.map(x)\nconst y = 1;').includes('DAW_PANELS')
  && stripComments('// DAW_PANELS.map(x)\nconst y = 1;').includes('const y = 1'));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
