/**
 * phase-e-render-safety.tsx — render-level safety tests for the Phase-E
 * panels.  Uses `react-dom/server.renderToStaticMarkup` (no jsdom, no
 * worker, no electron).  Each component is exercised with three input
 * shapes:
 *
 *   1. all Phase-D fields PRESENT  → component renders meaningful HTML
 *   2. all Phase-D fields MISSING  → component renders without throwing
 *   3. fields with EMPTY findings  → component degrades gracefully
 *      (e.g. SmartRecommendationPanel shows the "no recs" copy,
 *      SectionAnalysisPanel and AIArtifactWarningPanel render NOTHING).
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:phase-e-render
 *   (or: pnpm dlx tsx apps/desktop/scripts/phase-e-render-safety.tsx)
 *
 * The ResultPage itself depends on Zustand stores + IPC, which would
 * require heavy mocking to render.  The panels we test here are the
 * exact set ResultPage adds for Phase-E, so a panel-level smoke test
 * gives us high confidence ResultPage will not crash on missing
 * Phase-D fields.
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SectionAnalysisPanel    from '../src/renderer/components/SectionAnalysisPanel.js';
import AIArtifactWarningPanel  from '../src/renderer/components/AIArtifactWarningPanel.js';
import SmartRecommendationPanel from '../src/renderer/components/SmartRecommendationPanel.js';
import ExportReportPanel       from '../src/renderer/components/ExportReportPanel.js';
import {
  buildExportPayload,
  exportAsJson,
  exportAsTxt,
} from '../src/renderer/components/masteringReportExport.js';

import type {
  AIArtifactCheck,
  MasteringResult,
  SectionAnalysis,
  TranslationCheck,
  VocalIntelligence,
  ModeSuggestion,
} from '@aimaster/shared-types';

// ── Tiny harness ────────────────────────────────────────────────────────────

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true, detail: '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const FULL_SECTION: SectionAnalysis = {
  sections: [
    { start: 0,  end: 12, kind: 'verse',  energy: 'mid'  },
    { start: 12, end: 32, kind: 'chorus', energy: 'high' },
  ],
  dynamicRangeLu:   9.2,
  alternationScore: 0.74,
  sectionCounts:    { high: 1, mid: 1, low: 0 },
  modeSuggestion: {
    suggestedMode: 'natural',
    currentMode:   'loud',
    reason:        '벌스/코러스 대비가 강합니다.',
    confidence:    0.78,
  },
};

const FULL_ARTIFACT: AIArtifactCheck = {
  phaseAnomaly:     { present: true,  severity: 'warn', message: '위상 이상 감지된 패턴.' },
  metallicHighFreq: { present: true,  severity: 'warn', message: '금속성 패턴.' },
  subRumble:        { present: false, severity: 'info', message: '' },
  analyzerVersion:  '0.1.0',
};

const FULL_VOCAL: VocalIntelligence = {
  vocalPresent: true, clarityScore: 0.42, mood: 'breathy', sibilanceHz: 6800,
  note: '보컬이 부드럽게 감지됩니다.',
};

const FULL_TRANSLATION: TranslationCheck = {
  phone:  0.4, laptop: 0.7, club: 0.6, notes: ['전화기 저역 약함 가능성.'],
};

const FULL_MODE: ModeSuggestion = FULL_SECTION.modeSuggestion as ModeSuggestion;

const FULL_RESULT: Partial<MasteringResult> = {
  outputPath:  '/tmp/x.wav', previewPath: '/tmp/x.mp3',
  loudnessBefore: { integratedLufs: -19, truePeakDbtp: -1, lra: 8 },
  loudnessAfter:  { integratedLufs: -10, truePeakDbtp: -1, lra: 5, shortTermMax: -7 },
  appliedCorrections: ['ai_low_cut'],
  spectralBalance: null, analysisReport: null,
  pipelineWarnings: [], processingTimeSec: 4.2,
  sectionAnalysis:   FULL_SECTION,
  aiArtifactCheck:   FULL_ARTIFACT,
  vocalIntelligence: FULL_VOCAL,
  translationCheck:  FULL_TRANSLATION,
  modeSuggestion:    FULL_MODE,
};

// ── 1. SectionAnalysisPanel ────────────────────────────────────────────────

check('SectionAnalysisPanel: renders with full data', () => {
  const html = renderToStaticMarkup(
    <SectionAnalysisPanel analysis={FULL_SECTION} currentMode="loud" />
  );
  assert(html.includes('구간 분석'),  'title');
  assert(html.includes('2개 구간'),   'count');
  assert(html.includes('9.2'),       'DR value');
  assert(html.includes('0.74'),      'alternation');
  assert(html.includes('권장 모드'),  'mode hint shown');
  assert(html.includes('natural'),   'suggested mode');
});

check('SectionAnalysisPanel: null analysis renders nothing', () => {
  const html = renderToStaticMarkup(
    <SectionAnalysisPanel analysis={null} currentMode="loud" />
  );
  assert(html === '', `expected '' got ${JSON.stringify(html)}`);
});

check('SectionAnalysisPanel: undefined analysis renders nothing', () => {
  const html = renderToStaticMarkup(<SectionAnalysisPanel />);
  assert(html === '', `expected '' got ${JSON.stringify(html)}`);
});

check('SectionAnalysisPanel: empty fields → no card', () => {
  const html = renderToStaticMarkup(
    <SectionAnalysisPanel
      analysis={{ sections: [], dynamicRangeLu: null, alternationScore: null,
                  sectionCounts: { high: 0, mid: 0, low: 0 } }}
    />
  );
  // No useful data → entire card is hidden.
  assert(html === '', `expected '' got ${JSON.stringify(html)}`);
});

check('SectionAnalysisPanel: mode hint suppressed when same as currentMode', () => {
  const html = renderToStaticMarkup(
    <SectionAnalysisPanel analysis={FULL_SECTION} currentMode="natural" />
  );
  assert(html.includes('구간 분석'), 'still renders');
  assert(!html.includes('권장 모드'),  'mode hint hidden');
});

// ── 2. AIArtifactWarningPanel ──────────────────────────────────────────────

check('AIArtifactWarningPanel: renders only present findings', () => {
  const html = renderToStaticMarkup(
    <AIArtifactWarningPanel check={FULL_ARTIFACT} />
  );
  assert(html.includes('AI 아티팩트'),       'title');
  assert(html.includes('위상 이상'),         'phase finding');
  assert(html.includes('금속성'),           'metallic finding');
  assert(!html.includes('서브 럼블'),        'sub-rumble (present=false) hidden');
});

check('AIArtifactWarningPanel: missing check renders nothing', () => {
  const html = renderToStaticMarkup(<AIArtifactWarningPanel check={null} />);
  assert(html === '', `expected '' got ${JSON.stringify(html)}`);
});

check('AIArtifactWarningPanel: all-absent findings renders nothing', () => {
  const html = renderToStaticMarkup(
    <AIArtifactWarningPanel
      check={{
        phaseAnomaly:     { present: false, severity: 'info', message: '' },
        metallicHighFreq: { present: false, severity: 'info', message: '' },
        subRumble:        { present: false, severity: 'info', message: '' },
      }}
    />
  );
  assert(html === '', `expected '' got ${JSON.stringify(html)}`);
});

// ── 3. SmartRecommendationPanel ────────────────────────────────────────────

check('SmartRecommendationPanel: renders recs with full input', () => {
  const html = renderToStaticMarkup(
    <SmartRecommendationPanel
      sectionAnalysis={FULL_SECTION}
      aiArtifactCheck={FULL_ARTIFACT}
      vocalIntelligence={FULL_VOCAL}
      translationCheck={FULL_TRANSLATION}
      modeSuggestion={FULL_MODE}
      currentMode="loud"
    />
  );
  assert(html.includes('스마트 권장'),       'title');
  assert(html.includes('가능성'),            'conservative wording present');
});

check('SmartRecommendationPanel: empty input shows fallback copy', () => {
  const html = renderToStaticMarkup(<SmartRecommendationPanel />);
  assert(html.includes('스마트 권장'),               'title still present');
  assert(html.includes('특별히 권장 사항이 없습니다'), 'fallback note');
});

check('SmartRecommendationPanel: all-null inputs do not crash', () => {
  const html = renderToStaticMarkup(
    <SmartRecommendationPanel
      sectionAnalysis={null}
      aiArtifactCheck={null}
      vocalIntelligence={null}
      translationCheck={null}
      modeSuggestion={null}
    />
  );
  assert(html.includes('특별히 권장 사항이 없습니다'), 'fallback note on nulls');
});

// ── 4. ExportReportPanel ───────────────────────────────────────────────────

check('ExportReportPanel: renders both buttons even with null result', () => {
  const html = renderToStaticMarkup(
    <ExportReportPanel result={null} selectedMode={null} />
  );
  assert(html.includes('TXT 저장'),  'TXT button');
  assert(html.includes('JSON 저장'), 'JSON button');
});

check('ExportReportPanel: renders with full result', () => {
  const html = renderToStaticMarkup(
    <ExportReportPanel result={FULL_RESULT as MasteringResult} selectedMode="loud" />
  );
  assert(html.includes('TXT 저장'),  'TXT button');
  assert(html.includes('JSON 저장'), 'JSON button');
});

// ── 5. End-to-end export pipeline (covers ResultPage's export path) ────────

check('Export pipeline: full payload → valid TXT and JSON', () => {
  const payload = buildExportPayload(FULL_RESULT, 'loud',
    { appName: 'aimaster-desktop', appVersion: '3.5.0', now: '2024-01-01T00:00:00.000Z' });
  const txt  = exportAsTxt(payload);
  const json = exportAsJson(payload);
  assert(txt.length  > 200,  'TXT length');
  assert(json.length > 200,  'JSON length');
  const parsed = JSON.parse(json);
  assert(parsed.schemaVersion === 'phase-e/1', 'schema');
  assert(parsed.app.version   === '3.5.0',    'app version embedded');
});

// ── ResultPage-shape: all panels render together with no Phase-D ───────────

check('ResultPage panel-stack: every panel survives missing Phase-D', () => {
  // Render all four panels with null inputs, mirroring the ResultPage
  // wiring exactly.  Should produce some HTML for the always-visible
  // ones (SmartRecommendation, ExportReport) and empty for the
  // optional ones (Section, Artifact).
  const html = [
    renderToStaticMarkup(<SectionAnalysisPanel    analysis={null} />),
    renderToStaticMarkup(<AIArtifactWarningPanel  check={null} />),
    renderToStaticMarkup(
      <SmartRecommendationPanel
        sectionAnalysis={null} aiArtifactCheck={null}
        vocalIntelligence={null} translationCheck={null}
        modeSuggestion={null} currentMode={undefined}
      />
    ),
    renderToStaticMarkup(<ExportReportPanel result={null} selectedMode={null} />),
  ].join('\n');
  assert(html.includes('스마트 권장'),               'recs visible');
  assert(html.includes('특별히 권장 사항이 없습니다'), 'fallback note');
  assert(html.includes('TXT 저장'),                 'export buttons present');
  assert(!/section\s+analysis|구간 분석/i.test(html.split('스마트')[0]!),
    'no section analysis card without data');
});

// ── Run summary ────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log('\n=== Phase-E render-safety tests ===');
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);

if (failed > 0) process.exit(1);
