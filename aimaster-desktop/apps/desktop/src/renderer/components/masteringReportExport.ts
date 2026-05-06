/**
 * masteringReportExport.ts — pure helpers that turn a `MasteringResult`
 * (plus the Phase-D fields) into TXT and JSON exports.
 *
 * Pure: no DOM, no React, no DSP.  Consumed by `ExportReportPanel.tsx`
 * for the actual download UX, and by the safety test harness.
 *
 * Goal: a single self-contained snapshot the user can email / paste into
 * a ticket / archive.  Includes every Phase-D field, NEVER fabricates
 * a value that wasn't analyzed.
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

export interface ExportPayload {
  schemaVersion: 'phase-e/1';
  generatedAt:   string;
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

// ── Build payload (pure) ───────────────────────────────────────────────────

export function buildExportPayload(
  result:       Partial<MasteringResult> | null | undefined,
  selectedMode: string | null | undefined,
): ExportPayload {
  const r = (result ?? {}) as Partial<MasteringResult>;

  const before = r.loudnessBefore ?? null;
  const after  = r.loudnessAfter  ?? null;

  return {
    schemaVersion: 'phase-e/1',
    generatedAt:   new Date().toISOString(),
    loudness: {
      beforeIntegratedLufs: n(before?.integratedLufs),
      afterIntegratedLufs:  n(after?.integratedLufs),
      beforeTruePeakDbtp:   n(before?.truePeakDbtp),
      afterTruePeakDbtp:    n(after?.truePeakDbtp),
      beforeLra:            n(before?.lra),
      afterLra:             n(after?.lra),
    },
    selectedMode:       selectedMode ?? null,
    appliedCorrections: array<string>(r.appliedCorrections),
    sectionAnalysis:    r.sectionAnalysis    ?? null,
    aiArtifactCheck:    r.aiArtifactCheck    ?? null,
    vocalIntelligence:  r.vocalIntelligence  ?? null,
    translationCheck:   r.translationCheck   ?? null,
    modeSuggestion:     r.modeSuggestion     ?? null,
    pipelineWarnings:   array(r.pipelineWarnings),
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
  lines.push(`Generated:   ${payload.generatedAt}`);
  lines.push(`Schema:      ${payload.schemaVersion}`);
  lines.push(`Mode:        ${payload.selectedMode ?? '—'}`);
  if (payload.processingTimeSec !== null) {
    lines.push(`Processing:  ${payload.processingTimeSec.toFixed(2)} s`);
  }
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
        lines.push(`    [${s.kind}] ${s.start.toFixed(1)}s–${s.end.toFixed(1)}s` +
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
    if (typeof ms.confidence === 'number') {
      lines.push(`  Confidence      : ~${Math.round(ms.confidence * 100)}%`);
    }
    lines.push('');
  }

  // AI artifact check
  const ac = payload.aiArtifactCheck;
  if (ac) {
    lines.push('-- AI Artifact Check --');
    if (ac.analyzerVersion) lines.push(`  Analyzer        : v${ac.analyzerVersion}`);
    const findings: Array<[string, AIArtifactFinding | undefined]> = [
      ['Phase anomaly      ', (ac as Record<string, unknown>).phaseAnomaly     as AIArtifactFinding | undefined],
      ['Metallic high-freq ', (ac as Record<string, unknown>).metallicHighFreq as AIArtifactFinding | undefined],
      ['Sub-rumble         ', (ac as Record<string, unknown>).subRumble        as AIArtifactFinding | undefined],
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
      lines.push(`  [${w.level ?? 'info'}] ${w.code ?? '?'} — ${w.userMessage ?? ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
