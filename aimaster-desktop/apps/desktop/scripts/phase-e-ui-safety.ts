/**
 * phase-e-ui-safety.ts — UI safety tests for Phase-E Intelligence layer.
 *
 * Run via:
 *   pnpm dlx tsx apps/desktop/scripts/phase-e-ui-safety.ts
 *
 * These are *contract* tests for the pure helpers behind the Phase-E
 * UI panels.  They verify the safety rules from the Phase-E spec:
 *
 *   1. Missing sectionAnalysis must not crash the recommendation /
 *      export pipeline.
 *   2. Missing aiArtifactCheck must not crash either.
 *   3. The recommendation panel handles entirely-empty findings
 *      (returns 0 items, no exception).
 *   4. The export report includes every Phase-D field that was
 *      populated, and skips fields that weren't.
 *   5. ResultPage's data shape is exercised by `buildExportPayload`
 *      with both partial and complete inputs.
 *
 * The React components themselves are intentionally not rendered here
 * (no jsdom in repo); their pure logic is tested via the helpers they
 * delegate to (`smartRecommendations`, `masteringReportExport`).  The
 * components ALSO follow the same null-guard contract — see source.
 */

import {
  buildSmartRecommendations,
  type SmartRecommendation,
} from '../src/renderer/components/smartRecommendations.js';
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

// ── Tiny test harness ───────────────────────────────────────────────────────

interface TestResult { name: string; pass: boolean; detail: string; }
const results: TestResult[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true, detail: '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const FULL_SECTION: SectionAnalysis = {
  sections: [
    { start: 0,   end: 12,  kind: 'verse',  energy: 'mid'  },
    { start: 12,  end: 32,  kind: 'chorus', energy: 'high' },
    { start: 32,  end: 50,  kind: 'verse',  energy: 'mid'  },
    { start: 50,  end: 70,  kind: 'chorus', energy: 'high' },
    { start: 70,  end: 80,  kind: 'outro',  energy: 'low'  },
  ],
  dynamicRangeLu:   9.2,
  alternationScore: 0.74,
  sectionCounts:    { high: 2, mid: 2, low: 1 },
  modeSuggestion: {
    suggestedMode: 'natural',
    currentMode:   'loud',
    reason:        '벌스/코러스 대비가 강한 곡입니다.',
    confidence:    0.78,
  },
};

const FULL_ARTIFACT: AIArtifactCheck = {
  phaseAnomaly:     { present: true,  severity: 'warn',   message: '모노 재생 시 일부 음원이 작아질 수 있는 패턴 감지됨.' },
  metallicHighFreq: { present: true,  severity: 'warn',   message: '4–7 kHz 부근 금속성 패턴 감지됨.', confidence: 0.6 },
  subRumble:        { present: false, severity: 'info',   message: '' },
  analyzerVersion:  '0.1.0',
};

const FULL_VOCAL: VocalIntelligence = {
  vocalPresent: true,
  clarityScore: 0.42,
  mood:         'breathy',
  sibilanceHz:  6800,
  note:         '보컬이 부드럽지만 약간 흐릿하게 들립니다.',
};

const FULL_TRANSLATION: TranslationCheck = {
  phone:  0.4,
  laptop: 0.7,
  club:   0.6,
  notes:  ['전화기 스피커에서 저역이 약하게 들릴 수 있습니다.'],
};

const FULL_MODE: ModeSuggestion = FULL_SECTION.modeSuggestion as ModeSuggestion;

const FULL_RESULT: Partial<MasteringResult> = {
  outputPath:  '/tmp/x.wav',
  previewPath: '/tmp/x.mp3',
  loudnessBefore: { integratedLufs: -19.2, truePeakDbtp: -1.4, lra: 8.2 },
  loudnessAfter:  { integratedLufs: -10.0, truePeakDbtp: -1.0, lra: 5.4, shortTermMax: -7.1 },
  appliedCorrections: ['ai_low_cut', 'isp_safety'],
  spectralBalance: null,
  analysisReport:  null,
  pipelineWarnings: [
    { code: 'reference_genre_mismatch', level: 'warn', userMessage: '레퍼런스 장르 불일치 가능성.' },
  ],
  processingTimeSec: 4.21,
  sectionAnalysis:   FULL_SECTION,
  aiArtifactCheck:   FULL_ARTIFACT,
  vocalIntelligence: FULL_VOCAL,
  translationCheck:  FULL_TRANSLATION,
  modeSuggestion:    FULL_MODE,
};

// ── 1. Missing sectionAnalysis must not crash recommendations ───────────────

check('rec: missing sectionAnalysis is a no-op', () => {
  const recs = buildSmartRecommendations({
    sectionAnalysis:   undefined,
    aiArtifactCheck:   FULL_ARTIFACT,
    vocalIntelligence: FULL_VOCAL,
    translationCheck:  FULL_TRANSLATION,
    modeSuggestion:    FULL_MODE,
    currentMode:       'balanced',
  });
  assert(Array.isArray(recs), 'recs must be an array');
  // Section-derived recs absent, but artifact / vocal / translation still present.
  assert(recs.every((r: SmartRecommendation) => r.category !== 'section'),
    'no section-category recs when sectionAnalysis is missing');
});

// ── 2. Missing aiArtifactCheck must not crash recommendations ───────────────

check('rec: missing aiArtifactCheck is a no-op', () => {
  const recs = buildSmartRecommendations({
    sectionAnalysis:   FULL_SECTION,
    aiArtifactCheck:   undefined,
    vocalIntelligence: undefined,
    translationCheck:  undefined,
    modeSuggestion:    undefined,
    currentMode:       'balanced',
  });
  assert(Array.isArray(recs), 'recs must be an array');
  assert(recs.every((r: SmartRecommendation) => r.category !== 'artifact'),
    'no artifact-category recs when aiArtifactCheck is missing');
});

// ── 3. Recommendation panel handles entirely-empty findings ─────────────────

check('rec: every input null/undefined yields []', () => {
  const recs = buildSmartRecommendations({});
  assert(Array.isArray(recs) && recs.length === 0,
    `expected empty array, got ${JSON.stringify(recs)}`);
});

check('rec: literally null findings yields []', () => {
  const recs = buildSmartRecommendations({
    sectionAnalysis:   null,
    aiArtifactCheck:   null,
    vocalIntelligence: null,
    translationCheck:  null,
    modeSuggestion:    null,
  });
  assert(Array.isArray(recs) && recs.length === 0, 'expected []');
});

check('rec: caps at 5 items even with rich input', () => {
  const recs = buildSmartRecommendations({
    sectionAnalysis:   FULL_SECTION,
    aiArtifactCheck:   FULL_ARTIFACT,
    vocalIntelligence: FULL_VOCAL,
    translationCheck:  FULL_TRANSLATION,
    modeSuggestion:    FULL_MODE,
    currentMode:       'loud',
  });
  assert(recs.length >= 1 && recs.length <= 5,
    `recs.length out of [1,5]: ${recs.length}`);
});

check('rec: mode suggestion suppressed when same as currentMode', () => {
  const recs = buildSmartRecommendations({
    modeSuggestion: { suggestedMode: 'balanced', currentMode: 'balanced', reason: 'x' },
    currentMode:    'balanced',
  });
  assert(recs.every((r) => r.category !== 'mode'),
    'mode rec must be suppressed when suggestion === currentMode');
});

// ── 4. Export report includes all new fields ─────────────────────────────────

check('export: full payload contains every Phase-D field', () => {
  const payload = buildExportPayload(FULL_RESULT, 'loud');
  assert(payload.schemaVersion === 'phase-e/1', 'schema version');
  assert(payload.selectedMode === 'loud', 'selectedMode');
  assert(payload.sectionAnalysis !== null, 'sectionAnalysis present');
  assert(payload.aiArtifactCheck !== null, 'aiArtifactCheck present');
  assert(payload.vocalIntelligence !== null, 'vocalIntelligence present');
  assert(payload.translationCheck  !== null, 'translationCheck  present');
  assert(payload.modeSuggestion    !== null, 'modeSuggestion    present');
  assert(payload.appliedCorrections.length === 2, 'appliedCorrections preserved');
  assert(payload.pipelineWarnings.length    === 1, 'pipelineWarnings preserved');
  assert(payload.loudness.beforeIntegratedLufs === -19.2, 'before LUFS');
  assert(payload.loudness.afterIntegratedLufs  === -10,   'after  LUFS');
  assert(payload.loudness.afterTruePeakDbtp    === -1,    'after  TP');
});

check('export: TXT contains the major Phase-D headings', () => {
  const payload = buildExportPayload(FULL_RESULT, 'loud');
  const txt     = exportAsTxt(payload);
  for (const heading of [
    'AI Mastering Report',
    '-- Loudness --',
    '-- Section Analysis --',
    '-- Mode Suggestion --',
    '-- AI Artifact Check --',
    '-- Vocal Intelligence --',
    '-- Translation Check --',
    '-- Pipeline Warnings --',
  ]) {
    assert(txt.includes(heading), `TXT missing section: ${heading}`);
  }
});

check('export: JSON parses and round-trips', () => {
  const payload = buildExportPayload(FULL_RESULT, 'loud');
  const json    = exportAsJson(payload);
  const parsed  = JSON.parse(json);
  assert(parsed.schemaVersion === 'phase-e/1', 'parsed schema');
  assert(parsed.sectionAnalysis.sections.length === 5, 'sections survive JSON');
  assert(parsed.aiArtifactCheck.metallicHighFreq.present === true, 'finding survives JSON');
});

// ── 5. ResultPage data-shape — partial result with missing Phase-D fields ───

check('export: missing Phase-D fields are nulled, not crashed', () => {
  const partial: Partial<MasteringResult> = {
    outputPath:  '/tmp/x.wav',
    previewPath: '/tmp/x.mp3',
    loudnessBefore: { integratedLufs: -18, truePeakDbtp: -1, lra: 7 },
    loudnessAfter:  { integratedLufs: -12, truePeakDbtp: -1, lra: 5, shortTermMax: -8 },
    appliedCorrections: [],
    spectralBalance:    null,
    analysisReport:     null,
    pipelineWarnings:   [],
    processingTimeSec:  3.5,
    // Phase-D fields deliberately absent.
  };
  const payload = buildExportPayload(partial, 'balanced');
  assert(payload.sectionAnalysis   === null, 'sectionAnalysis   nulled');
  assert(payload.aiArtifactCheck   === null, 'aiArtifactCheck   nulled');
  assert(payload.vocalIntelligence === null, 'vocalIntelligence nulled');
  assert(payload.translationCheck  === null, 'translationCheck  nulled');
  assert(payload.modeSuggestion    === null, 'modeSuggestion    nulled');

  // TXT still renders without sections we couldn't fill.
  const txt = exportAsTxt(payload);
  assert(txt.includes('AI Mastering Report'),    'TXT still has header');
  assert(txt.includes('-- Loudness --'),         'TXT still has loudness');
  assert(!txt.includes('-- Section Analysis --'),
    'no section analysis heading without data');
  assert(!txt.includes('-- AI Artifact Check --'),
    'no artifact heading without data');
});

check('export: completely empty result still produces valid output', () => {
  const payload = buildExportPayload(null, null);
  const txt     = exportAsTxt(payload);
  const json    = exportAsJson(payload);
  assert(typeof txt  === 'string' && txt.length  > 0, 'TXT is non-empty');
  assert(typeof json === 'string' && json.length > 0, 'JSON is non-empty');
  const parsed = JSON.parse(json);
  assert(parsed.schemaVersion === 'phase-e/1', 'still tagged');
  assert(parsed.selectedMode === null, 'mode null');
});

// ── 6. Severity ordering — danger first ─────────────────────────────────────

check('rec: severity ordering keeps danger before warn before info', () => {
  const recs = buildSmartRecommendations({
    aiArtifactCheck: {
      phaseAnomaly:     { present: true, severity: 'danger', message: 'd' },
      metallicHighFreq: { present: true, severity: 'warn',   message: 'w' },
      subRumble:        { present: true, severity: 'info',   message: 'i' },
    },
  });
  const ids = recs.map((r) => r.severity);
  for (let i = 1; i < ids.length; i++) {
    const order: Record<string, number> = { danger: 0, warn: 1, info: 2 };
    const prev = ids[i - 1];
    const cur  = ids[i];
    assert(prev !== undefined && cur !== undefined && order[prev]! <= order[cur]!,
      `severity ordering violated: ${ids.join(',')}`);
  }
});

// ── Run summary ─────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log('\n=== Phase-E UI safety tests ===');
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);

if (failed > 0) {
  process.exit(1);
}
