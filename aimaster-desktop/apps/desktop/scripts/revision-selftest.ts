/**
 * revision-selftest.ts — pure revision-group logic (M3-REVISION-WORKFLOW).
 *
 * Run via:  pnpm --filter @aimaster/desktop test:revision
 */

import {
  initGroup, addRevision, setActiveRevision, removeRevision, renameRevision,
  toggleFavorite, getActiveRevision, getBaselineRevision, nextRevisionLabel,
  findDuplicate, formatOptionsSummary,
} from '../src/renderer/audio/revisions/revision-logic.js';
import type { RevisionInput } from '../src/renderer/audio/revisions/revision-types.js';
import type { MasteringOptions } from '../src/renderer/stores/audioStore.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void { if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const opts = (over: Partial<MasteringOptions> = {}): MasteringOptions => ({
  style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 44100, bitDepth: 24,
  applyAiCorrections: true, limiterStrength: 'medium', ...over,
});
const input = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  sourceFilePath: '/tmp/song.wav', sourceFileName: 'song.wav',
  optionsSnapshot: opts(), outputPath: '/tmp/out.wav', previewPath: '/tmp/prev.mp3',
  metrics: { integratedLufs: -14, truePeakDbtp: -1 }, ...over,
});

check('initGroup → Revision 1 active', () => {
  const g = initGroup(input());
  eq(g.revisions.length, 1, 'len');
  eq(g.revisions[0]!.label, 'Revision 1', 'label');
  eq(g.activeRevisionId, g.revisions[0]!.id, 'active');
});

check('addRevision appends + activates; labels increment', () => {
  let g = initGroup(input());
  g = addRevision(g, input({ optionsSnapshot: opts({ targetLufs: -10 }) }));
  eq(g.revisions.length, 2, 'len');
  eq(g.revisions[1]!.label, 'Revision 2', 'label2');
  eq(g.activeRevisionId, g.revisions[1]!.id, 'active=new');
  eq(getActiveRevision(g)!.optionsSnapshot.targetLufs, -10, 'active opts');
});

check('addRevision with different source starts a fresh group', () => {
  let g = initGroup(input());
  g = addRevision(g, input({ sourceFilePath: '/tmp/other.wav', sourceFileName: 'other.wav' }));
  eq(g.revisions.length, 1, 'reset to 1');
  eq(g.sourceFileName, 'other.wav', 'source');
});

check('setActiveRevision selects existing; ignores unknown', () => {
  let g = initGroup(input());
  g = addRevision(g, input());
  const first = g.revisions[0]!.id;
  g = setActiveRevision(g, first);
  eq(g.activeRevisionId, first, 'selected');
  const before = g.activeRevisionId;
  g = setActiveRevision(g, 'nope');
  eq(g.activeRevisionId, before, 'unknown ignored');
});

check('baseline = first revision (A in A/B)', () => {
  let g = initGroup(input());
  g = addRevision(g, input());
  eq(getBaselineRevision(g)!.label, 'Revision 1', 'baseline');
});

check('removeRevision never removes the last', () => {
  const g = initGroup(input());
  const g2 = removeRevision(g, g.revisions[0]!.id);
  eq(g2.revisions.length, 1, 'kept last');
});

check('removeRevision re-points active', () => {
  let g = initGroup(input());
  g = addRevision(g, input());            // 2 revs, active=2nd
  const second = g.activeRevisionId;
  g = removeRevision(g, second);
  eq(g.revisions.length, 1, 'len');
  eq(g.activeRevisionId, g.revisions[0]!.id, 'active re-pointed');
});

check('rename + favorite', () => {
  let g = initGroup(input());
  const id = g.revisions[0]!.id;
  g = renameRevision(g, id, '  My Master  ');
  eq(g.revisions[0]!.label, 'My Master', 'trimmed rename');
  g = renameRevision(g, id, '   ');
  eq(g.revisions[0]!.label, 'My Master', 'blank ignored');
  g = toggleFavorite(g, id);
  eq(g.revisions[0]!.isFavorite, true, 'fav on');
  g = toggleFavorite(g, id);
  eq(g.revisions[0]!.isFavorite, false, 'fav off');
});

check('findDuplicate detects identical options + preset', () => {
  let g = initGroup(input({ presetId: 'ai-pop' }));
  assert(findDuplicate(g, opts(), 'ai-pop'), 'should match');
  assert(!findDuplicate(g, opts({ targetLufs: -9 }), 'ai-pop'), 'diff opts no match');
  assert(!findDuplicate(g, opts(), 'kpop-loud'), 'diff preset no match');
});

check('nextRevisionLabel', () => {
  eq(nextRevisionLabel(null), 'Revision 1', 'null');
  const g = initGroup(input());
  eq(nextRevisionLabel(g), 'Revision 2', 'after 1');
});

check('formatOptionsSummary includes width/gain when non-default', () => {
  const s = formatOptionsSummary(opts({ stereoWidth: 1.2, outputGainDb: 1.5 }));
  assert(s.includes('W 120%'), 'width');
  assert(s.includes('G +1.5'), 'gain');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== revision workflow logic ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
