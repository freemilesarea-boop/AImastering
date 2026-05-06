/**
 * masteringReportExport.ts — pure helpers that turn a `MasteringResult`
 * (plus the Phase-D fields) into TXT and JSON exports.
 *
 * Pure: no DOM, no React, no DSP.  Consumed by `ExportReportPanel.tsx`
 * for the actual download UX, and by the safety test harness.
 *
 * Goals:
 *   • Single self-contained snapshot the user can email / paste into a
 *     support ticket.
 *   • Includes every Phase-D field, NEVER fabricates a value that was
 *     not analyzed.
 *   • User-safe: file system paths, debug-only fields, and analyzer
 *     internals are kept OUT of the report by construction (we
 *     enumerate only the fields we want to export).
 *   • Stable schema (`schemaVersion: 'phase-e/1'`) so support tooling
 *     can parse the JSON unchanged across builds.
 */

import type {
  MasteringResult,
  SectionAnalysis,
  AIArtifactCheck,
  AIArtifactFinding,
  VocalIntelligence,
  TranslationCheck,
  ModeSuggestion,
} from '@aimaster/shared-types';

// ── Public payload ──────────────────────────────────────────────────────────

export const REPORT_SCHEMA_VERSION = 'phase-e/1' as const;

export interface ExportPayload {
  /** Stable schema tag — bump when the JSON shape changes incompatibly. */
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  /** ISO-8601 UTC timestamp. */
  generatedAt:   string;
  /** App identification (no host-specific paths). */
  app: {
    name:    string;
    version: string;
  };
  loudness: {
    beforeIntegratedLufs: number | null;
    afterIntegratedLufs:  number | null;
    beforeTruePeakDbtp:   number | null;
    afterTruePeakDbtp:    number | null;
    beforeLra:            number | null;
    afterLra:             number | null;
  };
  selectedMode:        string | null;
  appliedCorrections:  string[];
  sectionAnalysis:     SectionAnalysis     | null;
  aiArtifactCheck:     AIArtifactCheck     | null;
  vocalIntelligence:   VocalIntelligence   | null;
  translationCheck:    TranslationCheck    | null;
  modeSuggestion:      ModeSuggestion      | null;
  pipelineWarnings:    Array<{ code: string; level: string; userMessage: string }>;
  processingTimeSec:   number | null;
}

export interface ExportOptions {
  /** Override the app name (defaults to the Vite-injected `__APP_NAME__`). */
  appName?:    string | undefined;
  /** Override the app version (defaults to `__APP_VERSION__`). */
  appVersion?: string | undefined;
  /** Override the timestamp (useful in tests). */
  now?:        string | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function array<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function safeGlobal(name: '__APP_NAME__' | '__APP_VERSION__'): string {
  // Vite replaces these literals at build time.  At runtime, in tests,
  // the identifiers are undefined — fall back gracefully.
  try {
    if (name === '__APP_NAME__'    && typeof __APP_NAME__    === 'string') return __APP_NAME__;
    if (name === '__APP_VERSION__' && typeof __APP_VERSION__ === 'string') return __APP_VERSION__;
  } catch { /* ReferenceError outside Vite — fall through */ }
  return '';
}

/** Strip fields we never want to leak into a user-shared file. */
function sanitizeWarning(w: unknown): { code: string; level: string; userMessage: string } | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  return {
    code:        typeof o['code']        === 'string' ? o['code'] : 'unknown',
    level:       typeof o['level']       === 'string' ? o['level'] : 'info',
    userMessage: typeof o['userMessage'] === 'string' ? o['userMessage'] : '',
  };
}

// ── Build payload (pure) ───────────────────────────────────────────────────

export function buildExportPayload(
  result:       Partial<MasteringResult> | null | undefined,
  selectedMode: string | null | undefined,
  options:      ExportOptions = {},
): ExportPayload {
  const r = (result ?? {}) as Partial<MasteringResult>;

  const before = r.loudnessBefore ?? null;
  const after  = r.loudnessAfter  ?? null;

  const appName    = options.appName    ?? safeGlobal('__APP_NAME__')    ?? '';
  const appVersion = options.appVersion ?? safeGlobal('__APP_VERSION__') ?? '';
  const generatedAt = options.now ?? new Date().toISOString();

  const warnings = array<unknown>(r.pipelineWarnings)
    .map(sanitizeWarning)
    .filter((w): w is { code: string; level: string; userMessage: string } => w !== null);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt,
    app: {
      name:    appName    || 'aimaster-desktop',
      version: appVersion || '0.0.0',
    },
    loudness: {
      beforeIntegratedLufs: n(before?.integratedLufs),
      afterIntegratedLufs:  n(after?.integratedLufs),
      beforeTruePeakDbtp:   n(before?.truePeakDbtp),
      afterTruePeakDbtp:    n(after?.truePeakDbtp),
      beforeLra:            n(before?.lra),
      afterLra:             n(after?.lra),
    },
    selectedMode:       selectedMode ?? null,
    appliedCorrections: array<string>(r.appliedCorrections).filter((c) => typeof c === 'string'),
    sectionAnalysis:    r.sectionAnalysis    ?? null,
    aiArtifactCheck:    r.aiArtifactCheck    ?? null,
    vocalIntelligence:  r.vocalIntelligence  ?? null,
    translationCheck:   r.translationCheck   ?? null,
    modeSuggestion:     r.modeSuggestion     ?? null,
    pipelineWarnings:   warnings,
    processingTimeSec:  n(r.processingTimeSec),
  };
}

// ── Format JSON ────────────────────────────────────────────────────────────

export function exportAsJson(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2);
}

// ── Format TXT ─────────────────────────────────────────────────────────────

function fmt(n: number | null, suffix: string, digits = 1): string {
  if (n === null) return '—';
  return `${n.toFixed(digits)} ${suffix}`.trim();
}

function isFindingPresent(f: AIArtifactFinding | null | undefined): boolean {
  return !!f && typeof f === 'object' && f.present === true;
}

export function exportAsTxt(payload: ExportPayload): string {
  const lines: string[] = [];
  lines.push('=== AI Mastering Report ===');
  lines.push(`App         : ${payload.app.name} v${payload.app.version}`);
  lines.push(`Generated   : ${payload.generatedAt}`);
  lines.push(`Schema      : ${payload.schemaVersion}`);
  lines.push(`Mode        : ${payload.selectedMode ?? '—'}`);
  if (payload.processingTimeSec !== null) {
    lines.push(`Processing  : ${payload.processingTimeSec.toFixed(2)} s`);
  }
  lines.push('');
  lines.push('이 리포트는 마스터링 전후 측정값과 곡 분석 결과를 요약한 것입니다.');
  lines.push('수치 외 항목은 모두 "감지된 패턴" 으로 해석해 주세요.');
  lines.push('');

  lines.push('-- Loudness --');
  lines.push(`  Integrated LUFS  : ${fmt(payload.loudness.beforeIntegratedLufs, 'LUFS')}` +
             ` → ${fmt(payload.loudness.afterIntegratedLufs,  'LUFS')}`);
  lines.push(`  True Peak        : ${fmt(payload.loudness.beforeTruePeakDbtp, 'dBTP')}` +
             ` → ${fmt(payload.loudness.afterTruePeakDbtp,  'dBTP')}`);
  lines.push(`  Loudness Range   : ${fmt(payload.loudness.beforeLra, 'LU')}` +
             ` → ${fmt(payload.loudness.afterLra,  'LU')}`);
  lines.push('');

  if (payload.appliedCorrections.length > 0) {
    lines.push('-- Applied Corrections --');
    for (const c of payload.appliedCorrections) lines.push(`  · ${c}`);
    lines.push('');
  }

  // Section analysis
  const sa = payload.sectionAnalysis;
  if (sa) {
    lines.push('-- Section Analysis --');
    lines.push(`  Sections        : ${sa.sections?.length ?? 0}`);
    lines.push(`  DR (LU)         : ${fmt(n(sa.dynamicRangeLu), 'LU')}`);
    lines.push(`  Alternation     : ${fmt(n(sa.alternationScore), '', 2)}`);
    const c = sa.sectionCounts ?? { high: 0, mid: 0, low: 0 };
    lines.push(`  High/Mid/Low    : ${c.high} / ${c.mid} / ${c.low}`);
    if (Array.isArray(sa.sections)) {
      for (const s of sa.sections) {
        const start = typeof s.start === 'number' ? s.start.toFixed(1) : '?';
        const end   = typeof s.end   === 'number' ? s.end.toFixed(1)   : '?';
        lines.push(`    [${s.kind}] ${start}s–${end}s` +
                   ` energy=${s.energy}${s.label ? ` (${s.label})` : ''}`);
      }
    }
    lines.push('');
  }

  // Mode suggestion
  const ms = payload.modeSuggestion ?? sa?.modeSuggestion ?? null;
  if (ms) {
    lines.push('-- Mode Suggestion --');
    lines.push(`  Suggested       : ${str(ms.suggestedMode) ?? '—'}`);
    lines.push(`  Current         : ${str(ms.currentMode)   ?? '—'}`);
    if (str(ms.reason)) lines.push(`  Reason          : ${ms.reason}`);
    if (typeof ms.confidence === 'number' && Number.isFinite(ms.confidence)) {
      const c = Math.max(0, Math.min(1, ms.confidence));
      lines.push(`  Confidence      : ~${Math.round(c * 100)}%`);
    }
    lines.push('');
  }

  // AI artifact check
  const ac = payload.aiArtifactCheck;
  if (ac) {
    lines.push('-- AI Artifact Check --');
    if (ac.analyzerVersion) lines.push(`  Analyzer        : v${ac.analyzerVersion}`);
    const findings: Array<[string, AIArtifactFinding | undefined]> = [
      ['Phase anomaly      ', ac.phaseAnomaly],
      ['Metallic high-freq ', ac.metallicHighFreq],
      ['Sub-rumble         ', ac.subRumble],
    ];
    for (const [label, f] of findings) {
      if (!f || typeof f !== 'object') continue;
      const flag = isFindingPresent(f) ? `⚠ ${f.severity ?? 'warn'}` : 'ok';
      const msg  = str(f.message) ?? '';
      lines.push(`  ${label}: ${flag}${msg ? ` — ${msg}` : ''}`);
    }
    lines.push('');
  }

  // Vocal intelligence
  const vi = payload.vocalIntelligence;
  if (vi) {
    lines.push('-- Vocal Intelligence --');
    lines.push(`  Vocal present   : ${vi.vocalPresent ? 'yes' : 'no'}`);
    if (n(vi.clarityScore) !== null) lines.push(`  Clarity         : ${fmt(n(vi.clarityScore), '', 2)}`);
    if (str(vi.mood))                lines.push(`  Mood            : ${vi.mood}`);
    if (n(vi.sibilanceHz)  !== null) lines.push(`  Sibilance       : ${fmt(n(vi.sibilanceHz), 'Hz', 0)}`);
    if (str(vi.note))                lines.push(`  Note            : ${vi.note}`);
    lines.push('');
  }

  // Translation
  const tc = payload.translationCheck;
  if (tc) {
    lines.push('-- Translation Check --');
    lines.push(`  Phone           : ${fmt(n(tc.phone), '', 2)}`);
    lines.push(`  Laptop          : ${fmt(n(tc.laptop), '', 2)}`);
    lines.push(`  Club            : ${fmt(n(tc.club), '', 2)}`);
    if (Array.isArray(tc.notes)) {
      for (const note of tc.notes) {
        if (str(note)) lines.push(`    · ${note}`);
      }
    }
    lines.push('');
  }

  // Warnings
  if (payload.pipelineWarnings.length > 0) {
    lines.push('-- Pipeline Warnings --');
    for (const w of payload.pipelineWarnings) {
      lines.push(`  [${w.level}] ${w.code} — ${w.userMessage}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
