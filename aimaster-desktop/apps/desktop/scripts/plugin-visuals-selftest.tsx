// plugin-visuals-selftest — every plugin the DAW offers is drawn, not listed.
//
// The DAW's insert panel rendered `ModuleParameterPanel` and nothing else: a
// column of sliders for a compressor, a de-noiser, an imager alike. Correct
// numbers, unreadable as a tool. The pictures already existed — the Studio
// has drawn them for the mastering chain all along — and the DAW simply did
// not use them.
//
// So the thing worth testing is COVERAGE, and it is worth testing because
// the failure is silent: add a module to the picker, forget the view, and it
// still "works" — it just quietly falls back to sliders, and nobody notices
// until a user tries to mix with it.
//
// Every check here therefore starts from the picker itself rather than from
// a list written out by hand, so a module added tomorrow is tested tomorrow.
//
// `renderToStaticMarkup` runs the tree for real without Electron or jsdom.
// Effects do not run, so this proves the editor paints and what it paints
// with — not that a drag lands; the drag maths is `eq-graph-selftest`.
//
// Run:  pnpm --filter @aimaster/desktop test:plugin-visuals

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TrackPluginEditor, hasVisualEditor,
} from '../src/renderer/components/daw/TrackPluginEditor.js';
import {
  addableModules, startingValues, PICKER_GROUPS, TRACK_FORBIDDEN,
} from '../src/renderer/components/daw/InsertRack.js';
import { MODULE_IDS, type ModuleId, type ParameterValue } from '../src/renderer/audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import { EMPTY_METRICS, type RealtimePreviewMetrics } from '../src/renderer/audio/track-metrics-store.js';
import { makeFreeBand, type FreeEqBand } from '../src/renderer/audio/modules/eq-graph-model.js';
import { ModuleParameterPanel } from '../src/renderer/components/product/panels/ModuleParameterPanel.js';

// The views measure themselves with a ResizeObserver. Effects do not run
// under static rendering, but the class has to exist for the module to load.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void { /* effects never run here */ }
  unobserve(): void { }
  disconnect(): void { }
};

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const PICKABLE: ModuleId[] = addableModules([]);

function defaults(id: ModuleId): Record<string, ParameterValue> {
  return startingValues(id).parameters;
}

function render(
  id: ModuleId,
  over: {
    metrics?: RealtimePreviewMetrics;
    bypass?: boolean;
    freeBands?: FreeEqBand[];
    onChange?: (patch: Record<string, ParameterValue>) => void;
  } = {},
): string {
  return renderToStaticMarkup(React.createElement(TrackPluginEditor, {
    moduleId: id,
    values: defaults(id),
    bypass: over.bypass ?? false,
    metrics: over.metrics ?? EMPTY_METRICS,
    analyser: null,
    freeBands: over.freeBands ?? [makeFreeBand(1000, 3)],
    onChange: over.onChange ?? (() => { }),
    onFreeBands: () => { },
  }));
}

/** A drawing, as opposed to a form. */
function isDrawn(markup: string): boolean {
  return markup.includes('<svg') || markup.includes('<canvas');
}

console.log('\n=== EVERY PICKABLE PLUGIN DRAWS SOMETHING ===\n');
{
  check(
    'the picker offers modules at all',
    PICKABLE.length >= 15,
    `${PICKABLE.length}개 — 목록에서 직접 가져온다`,
  );

  const missing: string[] = [];
  const undrawn: string[] = [];
  for (const id of PICKABLE) {
    if (!hasVisualEditor(id)) missing.push(id);
    let markup = '';
    try {
      markup = render(id);
    } catch (e) {
      undrawn.push(`${id} (throw: ${(e as Error).message})`);
      continue;
    }
    if (!markup.includes(`data-plugin-visual="${id}"`) || !isDrawn(markup)) undrawn.push(id);
  }

  check(
    'the mapping claims every one of them',
    missing.length === 0,
    missing.length === 0 ? `${PICKABLE.length}개 전부` : `빠진 모듈: ${missing.join(', ')}`,
  );
  check(
    'and every one actually renders a drawing',
    undrawn.length === 0,
    undrawn.length === 0
      ? `${PICKABLE.length}개 전부 svg/canvas를 그린다`
      : `그림이 없는 모듈: ${undrawn.join(', ')}`,
  );
}

console.log('\n=== THE NUMBERS STAY ===\n');
{
  // The graph is the fast way to work; typing is the exact one. A view that
  // replaced the controls would have taken something away.
  const thin: string[] = [];
  for (const id of PICKABLE) {
    const markup = render(id);
    const def = ALL_MODULE_PARAMETER_DEFS[id];
    // Every module in the picker has parameters — `addableModules` filters
    // out the ones that do not — so each must show controls as well.
    if (def.parameters.length > 0 && !markup.includes('<input')) thin.push(id);
  }
  check(
    'the parameter controls are still rendered under the picture',
    thin.length === 0,
    thin.length === 0 ? `${PICKABLE.length}개 전부 컨트롤 유지` : `컨트롤이 사라진 모듈: ${thin.join(', ')}`,
  );
}

console.log('\n=== WHAT THE PICTURE IS ===\n');
{
  // Spot checks that the right view was chosen, not merely some view. The
  // labels come from the views themselves, so a module wired to the wrong
  // one fails here rather than passing the coverage check above.
  const cases: Array<[ModuleId, string, string]> = [
    ['dynamics', 'Glue', '컴프레서 전달 곡선'],
    ['multiband', 'Low mid', '멀티밴드 4개 곡선'],
    ['parametric-eq', 'Bell', '자유 EQ 밴드 목록'],
    ['denoise', 'Hz', '노이즈 프로파일 주파수 축'],
  ];
  for (const [id, needle, what] of cases) {
    check(`${id} draws ${what}`, render(id).includes(needle), `"${needle}" 포함`);
  }

  // The EQ modules get a curve rather than a transfer graph, and the
  // frequency ruler is what tells them apart.
  const eq = render('eq');
  check('eq draws a frequency ruler', eq.includes('1k') || eq.includes('100'), 'EQ 곡선 축');
}

console.log('\n=== LIVE METRICS REACH THE VIEW ===\n');
{
  // A meter that ignored its input would still have passed every check so
  // far. This one moves the number and looks for it.
  const idle = render('dynamics', { metrics: EMPTY_METRICS });
  const live = render('dynamics', {
    metrics: { ...EMPTY_METRICS, running: true, bypass: false, dynamicsGrDb: 7.3 },
  });
  // Matched on the meter's own text — a typographic minus and one decimal.
  // A bare "7.3" would also match the SVG path data, where every coordinate
  // is printed to one decimal, and the check would pass without a meter.
  check(
    'the compressor meter reads the gain reduction the chain reports',
    live.includes('\u22127.3') && !idle.includes('\u22127.3'),
    '−7.3 dB가 live에만 나타난다',
  );
  check(
    'and an idle chain reads as no measurement, not as 0.0 dB',
    idle.includes('\u2014') && !idle.includes('\u22120.0'),
    '유휴 상태는 "감쇠 없음"이 아니라 대시(—)로 표시된다',
  );

  const band = render('multiband', {
    metrics: { ...EMPTY_METRICS, running: true, bypass: false, multibandGrDb: [1.1, 2.2, 3.3, 4.4] },
  });
  check(
    'the multiband meters read per band',
    band.includes('\u22122.2') && band.includes('\u22124.4'),
    '밴드별 감쇠가 각각 표시된다',
  );
}

console.log('\n=== BYPASS ===\n');
{
  // A bypassed plugin still shows its shape — you have to be able to see
  // what you are about to switch back on — but it must not look live.
  const on = render('dynamics', { bypass: false });
  const off = render('dynamics', { bypass: true });
  check('a bypassed plugin still draws its curve', isDrawn(off), 'svg 유지');
  check('but does not look the same as an engaged one', on !== off, '흐려진다');
}

console.log('\n=== FREE EQ ===\n');
{
  const none = render('parametric-eq', { freeBands: [] });
  check('the free EQ renders with no bands at all', isDrawn(none), '빈 그래프도 그려진다');

  const three = render('parametric-eq', {
    freeBands: [makeFreeBand(80, -4), makeFreeBand(1000, 3), makeFreeBand(9000, 2)],
  });
  check(
    'and lists every band it was given',
    (three.match(/Bell/g) ?? []).length >= 3,
    `${(three.match(/Bell/g) ?? []).length}개 밴드 행`,
  );
}

console.log('\n=== NOT ON A TRACK ===\n');
{
  // The limiter and the export stage belong to the master bus. They are not
  // in the picker, and the editor is never asked for them — but if the
  // filter were ever dropped, this says what would happen.
  for (const id of TRACK_FORBIDDEN) {
    check(
      `${id} is kept off tracks`,
      !PICKABLE.includes(id),
      '마스터 버스 전용 — 트랙 인서트로 제공되지 않는다',
    );
  }
  const grouped = new Set(PICKER_GROUPS.flatMap((g) => g.modules));
  const ungrouped = PICKABLE.filter((id) => !grouped.has(id));
  check(
    'every offered module sits in a named group',
    ungrouped.length === 0,
    ungrouped.length === 0 ? `${grouped.size}개 분류됨` : `미분류: ${ungrouped.join(', ')}`,
  );
}

console.log('\n=== THE CONTROL ===\n');
{
  // If `isDrawn` matched anything at all, the coverage check would be
  // vacuous. A bare parameter panel has to fail it.
  const bare = renderToStaticMarkup(React.createElement(ModuleParameterPanel, {
    moduleId: 'dynamics' as ModuleId,
    def: ALL_MODULE_PARAMETER_DEFS['dynamics'],
    values: defaults('dynamics'),
    bypass: false,
    onChange: () => { },
  }));
  check(
    'control — the old slider-only panel draws nothing',
    !isDrawn(bare) && bare.includes('<input'),
    '이전 패널은 이 테스트를 통과하지 못한다 — 측정이 실제로 작동한다는 증거',
  );

  // And a module id with no view at all must be reported as uncovered
  // rather than silently claimed.
  check(
    'control — an unknown module is not claimed',
    !hasVisualEditor('not-a-module'),
    'hasVisualEditor가 무조건 true를 반환하지 않는다',
  );
  check(
    'every id in the parameter registry is a real module',
    MODULE_IDS.every((id) => ALL_MODULE_PARAMETER_DEFS[id] !== undefined),
    `${MODULE_IDS.length}개`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
