/**
 * window-layout-selftest.ts — the saved rooms nothing could enter.
 *
 * `workspace-view.ts` opens by arguing for window layouts: "a tracking layout
 * and a mixing layout are different rooms, and switching by hand is a minute
 * each time."  Four functions implemented that paragraph — saveLayout,
 * findLayout, removeLayout, describeLayout — all four were covered by
 * tier-c's tests, and NONE of them had a caller anywhere in the app.
 * `dawStore.layouts` was initialised to `[]`, `setLayouts` was never invoked,
 * and so the list could not stop being empty. No shortcut named a layout and
 * no component rendered one. The whole feature was a documented intention.
 *
 * Three kinds of check here, and the third is the one that would have caught
 * it: BEHAVIOUR of the new capture/diff/cycle functions, the SLOT RULE that
 * restoring must not trip, and the ROUTE from a key and a button to those
 * functions. A model with passing unit tests and no way in is exactly the
 * defect, so tests that only exercised the model would have stayed green
 * throughout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureLayout, describeLayoutDiff, layoutDiff, nextLayout,
  type WorkspaceShot,
} from '../src/renderer/daw/edit/layout-ops.js';
import {
  MAX_LAYOUTS, findLayout, removeLayout, saveLayout, type WindowLayout,
} from '../src/renderer/daw/model/workspace-view.js';
import { dropdownOffset } from '../src/renderer/ui/dropdown-place.js';

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

const shot = (over: Partial<WorkspaceShot> = {}): WorkspaceShot => ({
  window: 'edit',
  panels: { inspector: true, mixConsole: false, rightRack: true },
  view: { pxPerSec: 40, scrollSec: 0 },
  floating: [],
  ...over,
});

// ── 1. Capturing ────────────────────────────────────────────────────────────

check('a captured layout takes the name it was given',
  captureLayout('  트래킹  ', shot()).name === '트래킹',
  captureLayout('  트래킹  ', shot()).name);

// The trap mix-snapshot.ts documents for inserts, in another costume: a
// layout that shared the panels object with the store would follow every
// later toggle, which is the one thing a saved layout must not do.
{
  // Mutated IN PLACE, not reassigned.  A first version of this check did
  // `live.floating = [...]`, which an aliased layout survives — it still
  // points at the array from before — so the break that aliases the floats
  // went uncaught.  The screen changing under a saved layout is a mutation,
  // and that is what has to be simulated.
  const floats = [{ id: 'mix' as const, x: 1, y: 2, width: 3, height: 4 }];
  const live = shot({ floating: floats });
  const saved = captureLayout('트래킹', live);
  live.panels['mixConsole'] = true;
  floats.push({ id: 'warp' as never, x: 5, y: 6, width: 7, height: 8 });
  const first = floats[0] as { width: number };
  first.width = 999;
  check('a layout does not follow the screen it was taken from',
    saved.panels['mixConsole'] === false
    && (saved.floating ?? []).length === 1
    && (saved.floating ?? [])[0]?.width === 3,
    `panels=${saved.panels['mixConsole']} n=${(saved.floating ?? []).length} w=${(saved.floating ?? [])[0]?.width}`);
}

{
  const live = shot({ view: { pxPerSec: 40, scrollSec: 0, trackHeights: { 't1': 80 } } });
  const saved = captureLayout('A', live);
  (live.view.trackHeights as Record<string, number>)['t1'] = 200;
  check('track heights are copied out too, not aliased',
    saved.view?.trackHeights?.['t1'] === 80, String(saved.view?.trackHeights?.['t1']));
}

// Stacking order is whatever the last click made it, not something anyone
// saved, so it must not come back as part of a layout.
{
  const saved = captureLayout('A', shot({
    floating: [{ id: 'mix', x: 10, y: 20, width: 300, height: 200 }],
  }));
  const place = (saved.floating ?? [])[0] as unknown as Record<string, unknown> | undefined;
  check('a floated panel keeps its geometry and not its z',
    place?.['width'] === 300 && place?.['z'] === undefined);
}

// ── 2. What recalling would change ──────────────────────────────────────────

{
  const layout = captureLayout('A', shot());
  check('a layout against the screen it came from changes nothing',
    layoutDiff(shot(), layout).same);
  check('and says so', describeLayoutDiff(layoutDiff(shot(), layout)) === '지금 화면과 같습니다');
}

{
  const layout = captureLayout('믹싱', shot({ window: 'mix', panels: { mixConsole: true } }));
  const d = layoutDiff(shot(), layout);
  check('a different docked window is reported', d.window && !d.same);
  // `shot()` has inspector and rightRack on and the layout does not; the
  // layout has mixConsole on and the screen does not.  Both directions, and
  // a panel present on only one side must not be skipped.
  check('panels are compared in both directions',
    d.opening.join() === 'mixConsole' && d.closing.sort().join() === 'inspector,rightRack',
    `opening=${d.opening.join()} closing=${d.closing.join()}`);
}

{
  const layout = captureLayout('A', shot({
    floating: [{ id: 'mix', x: 0, y: 0, width: 400, height: 300 }],
  }));
  const onScreen = shot({ floating: [{ id: 'warp', x: 0, y: 0, width: 400, height: 300 }] });
  const d = layoutDiff(onScreen, layout);
  check('a float that would open and one that would close are both named',
    d.floatingOn.join() === 'mix' && d.floatingOff.join() === 'warp',
    `on=${d.floatingOn.join()} off=${d.floatingOff.join()}`);
}

{
  const layout = captureLayout('A', shot({ view: { pxPerSec: 400, scrollSec: 12 } }));
  check('a zoom that would move is reported', layoutDiff(shot(), layout).zoom);
  const wording = describeLayoutDiff(layoutDiff(shot(), layout));
  check('the description names what it would do', wording.includes('줌 이동'), wording);
}

// ── 3. Saving, replacing, capping ───────────────────────────────────────────

{
  let list: WindowLayout[] = [];
  for (let i = 1; i <= MAX_LAYOUTS + 2; i++) list = saveLayout(list, captureLayout(`L${i}`, shot()));
  check('the cap holds and the oldest goes',
    list.length === MAX_LAYOUTS && list[0]?.name === 'L3', `${list.length} / ${list[0]?.name}`);
}

{
  const list = saveLayout(saveLayout([], captureLayout('믹싱', shot())),
    captureLayout('믹싱', shot({ window: 'mix' })));
  check('saving the same name replaces rather than appends',
    list.length === 1 && findLayout(list, '믹싱')?.window === 'mix');
  check('removing by name empties it', removeLayout(list, '믹싱').length === 0);
}

// ── 4. Cycling ──────────────────────────────────────────────────────────────

const three = ['A', 'B', 'C'].map((n) => captureLayout(n, shot()));
check('cycling walks forward', nextLayout(three, 'A')?.name === 'B');
check('cycling wraps', nextLayout(three, 'C')?.name === 'A');
// Unknown or unset starts at the top rather than at index 1, so the first
// press after a reload lands somewhere predictable.
check('an unknown current starts at the top', nextLayout(three, null)?.name === 'A');
check('nothing to cycle to in an empty list', nextLayout([], null) === null);
// One layout, already on it: "next" would be a no-op that still printed a
// message, which reads as a bug.
check('one layout you are already on has no next',
  nextLayout([three[0] as WindowLayout], 'A') === null);
check('one layout you are not on does have a next',
  nextLayout([three[0] as WindowLayout], null)?.name === 'A');

// ── 4b. Keeping the menu on screen ──────────────────────────────────────────

// Measured in the packaged app at 1100 px: the button sat at x≈835 and a
// left-aligned 320 px menu ran 55 px past the edge, taking the delete buttons
// with it.  They were rendered, and could not be clicked.
check('a menu that fits is not moved', dropdownOffset(100, 320, 1100) === 0);
check('a menu that would overflow slides left',
  dropdownOffset(835, 320, 1100) === -63, String(dropdownOffset(835, 320, 1100)));
check('and lands exactly on the gutter',
  835 + dropdownOffset(835, 320, 1100) + 320 === 1100 - 8);
// Anchoring right instead would only move the problem: the toolbar wraps, so
// the same button can end up near the left edge on a narrow window.
check('it is never pushed past the left gutter',
  dropdownOffset(12, 320, 320) === -4 && 12 + dropdownOffset(12, 320, 320) === 8,
  String(dropdownOffset(12, 320, 320)));
check('a menu wider than the window still starts on screen',
  12 + dropdownOffset(12, 900, 400) === 8);
check('a viewport nobody measured yet does not move it',
  dropdownOffset(835, 320, Number.NaN) === 0);

const menuSrc = stripComments(read('src/renderer/components/daw/LayoutMenu.tsx'));
check('the menu computes its place', /dropdownOffset\(/.test(menuSrc));
// Computing it is not using it.  A first version of this check asked only
// whether `dropdownOffset` was called, and pinning `left: 0` in the style
// while still calling it went straight through.
check('and the offset it computes is the one it renders at',
  /style=\{\{\s*left:\s*offset\b/.test(menuSrc),
  'the computed offset is not what the menu is positioned by');
check('it no longer pins itself to the left',
  !/absolute left-0/.test(menuSrc), 'still absolute left-0');

// ── 5. The slot rule restoring must not trip ────────────────────────────────

const workspace = stripComments(read('src/renderer/stores/workspaceStore.ts'));
// `setPanel` closes the panels sharing a slot with whatever it just opened.
// Replaying a saved record key by key would have each panel evict the one set
// before it, and the room that came back would not be the room that was
// saved.  So the restore path must write the record wholesale.
check('the workspace can take a whole panel record at once',
  /setPanels:\s*\(panels\)\s*=>\s*set\(\{\s*panels:/.test(workspace), 'no setPanels');
check('setPanels does not run the slot-mate eviction',
  !/setPanels:[\s\S]{0,120}closeSlotMates/.test(workspace),
  'setPanels calls closeSlotMates, which would evict its own panels');

const store = stripComments(read('src/renderer/stores/dawStore.ts'));
check('recalling uses it', /setPanels\(/.test(store));

// ── 6. The route that did not exist ─────────────────────────────────────────

const menu = stripComments(read('src/renderer/components/daw/LayoutMenu.tsx'));
const page = stripComments(read('src/renderer/pages/DawPage.tsx'));
const commands = stripComments(read('src/renderer/shortcuts/daw-commands.ts'));
const defs = stripComments(read('src/renderer/shortcuts/definitions.ts'));

check('the store can save a layout', /saveWindowLayout:/.test(store) && /saveLayout\(/.test(store));
check('the store can recall one', /recallWindowLayout:/.test(store) && /findLayout\(/.test(store));
check('the store can drop one', /dropWindowLayout:/.test(store) && /removeLayout\(/.test(store));
check('recalling restores the floats too',
  /closeAll\(\)/.test(store) && /\.float\(/.test(store) && /\.resize\(/.test(store));

check('the menu previews before it moves', /layoutDiff\(/.test(menu));
check('the menu can save, recall and delete',
  /saveWindowLayout\(/.test(menu) && /recallWindowLayout\(/.test(menu)
  && /dropWindowLayout\(/.test(menu));
check('the DAW page renders the menu',
  /import\s+LayoutMenu\s+from/.test(page) && /<LayoutMenu\s*\/>/.test(page));

for (const id of ['daw.layoutMenu', 'daw.layoutSave', 'daw.layoutCycle']) {
  check(`${id} is bound to a key`, new RegExp(`id:\\s*'${id}'`).test(defs));
  check(`${id} does something`, new RegExp(`'${id}':\\s*\\(\\)\\s*=>`).test(commands));
}

// The reason this file exists: all four had a test and no caller.
for (const fn of ['saveLayout', 'findLayout', 'removeLayout', 'describeLayout'] as const) {
  const reached = [store, menu].some((src) => new RegExp(`\\b${fn}\\(`).test(src));
  check(`${fn} is reachable from the app`, reached,
    'implemented and tested, with no route to it');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
