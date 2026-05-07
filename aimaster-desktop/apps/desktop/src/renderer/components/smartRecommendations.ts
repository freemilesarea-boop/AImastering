/**
 * smartRecommendations.ts — pure helper that combines Phase-D analyzer
 * outputs (sectionAnalysis, modeSuggestion, aiArtifactCheck,
 * vocalIntelligence, translationCheck) into a list of plain-language,
 * Korean-first user recommendations.
 *
 * This file contains NO React.  It is consumed by SmartRecommendationPanel
 * in the UI and by `phase-e-ui-safety.ts` in the test harness.
 *
 * Rules baked in here (mirroring the Phase-E spec):
 *   • Conservative wording — "가능성", "권장", "감지된 패턴".
 *   • No fabricated confidence numbers — only echo what the analyzer gave.
 *   • At most 5 recommendations are returned (priority: danger → warn → info).
 *   • Empty / missing inputs are silently ignored (safety contract).
 */

import type {
  AIArtifactCheck,
  AIArtifactFinding,
  AIArtifactSeverity,
  ModeSuggestion,
  SectionAnalysis,
  TranslationCheck,
  VocalIntelligence,
} from '@aimaster/shared-types';

export type RecommendationSeverity = 'info' | 'warn' | 'danger';

export type RecommendationCategory =
  | 'section'
  | 'mode'
  | 'artifact'
  | 'vocal'
  | 'translation';

export interface SmartRecommendation {
  id:        string;
  text:      string;
  category:  RecommendationCategory;
  severity:  RecommendationSeverity;
}

export interface SmartRecommendationInput {
  sectionAnalysis?:   SectionAnalysis | null | undefined;
  modeSuggestion?:    ModeSuggestion  | null | undefined;
  aiArtifactCheck?:   AIArtifactCheck | null | undefined;
  vocalIntelligence?: VocalIntelligence | null | undefined;
  translationCheck?:  TranslationCheck | null | undefined;
  /** Mode the user selected — used to suppress redundant "switch mode" hints. */
  currentMode?:       string | null | undefined;
}

const SEV_RANK: Record<RecommendationSeverity, number> = {
  danger: 0,
  warn:   1,
  info:   2,
};

function pushSafe(out: SmartRecommendation[], r: SmartRecommendation): void {
  if (typeof r.text !== 'string' || r.text.trim() === '') return;
  out.push(r);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function fromSection(
  out: SmartRecommendation[],
  sa: SectionAnalysis,
): void {
  const alt = sa.alternationScore;
  if (isFiniteNumber(alt) && alt >= 0.6) {
    pushSafe(out, {
      id:       'section-alternation-strong',
      category: 'section',
      severity: 'info',
      text:
        '벌스/코러스 대비가 강한 패턴이 감지되었습니다. ' +
        'Natural 모드가 감정선을 더 잘 살릴 가능성이 있습니다.',
    });
  } else if (isFiniteNumber(alt) && alt <= 0.2 && (sa.sections?.length ?? 0) > 0) {
    pushSafe(out, {
      id:       'section-alternation-flat',
      category: 'section',
      severity: 'info',
      text:
        '구간 간 대비가 약한 패턴이 감지되었습니다. ' +
        'Loud 또는 KPOP Loud 모드가 무난할 가능성이 있습니다.',
    });
  }

  const dr = sa.dynamicRangeLu;
  if (isFiniteNumber(dr) && dr >= 8) {
    pushSafe(out, {
      id:       'section-dr-wide',
      category: 'section',
      severity: 'info',
      text:
        `다이내믹 레인지가 약 ${dr.toFixed(1)} LU 로 넓게 감지되었습니다. ` +
        '강한 리미팅 시 감정 표현이 줄어들 가능성이 있습니다.',
    });
  }
}

function fromMode(
  out: SmartRecommendation[],
  ms: ModeSuggestion,
  currentMode?: string | null | undefined,
): void {
  const suggested = typeof ms.suggestedMode === 'string' ? ms.suggestedMode : null;
  if (!suggested) return;
  // Only surface when the suggestion differs from the current selection.
  if (currentMode && suggested === currentMode) return;
  const reason = ms.reason && ms.reason.trim() ? ms.reason.trim() : '곡의 특성과 더 잘 맞을 가능성이 있습니다.';
  pushSafe(out, {
    id:       'mode-suggestion',
    category: 'mode',
    severity: 'info',
    text:     `이 곡에는 "${suggested}" 모드가 더 잘 맞을 가능성이 있습니다. ${reason}`,
  });
}

function isFinding(v: unknown): v is AIArtifactFinding {
  return typeof v === 'object'
    && v !== null
    && typeof (v as { present?: unknown }).present === 'boolean';
}

function severityFromArtifact(s: AIArtifactSeverity | undefined): RecommendationSeverity {
  return s === 'danger' ? 'danger' : s === 'info' ? 'info' : 'warn';
}

function fromArtifact(
  out: SmartRecommendation[],
  ac: AIArtifactCheck,
): void {
  const phase = ac.phaseAnomaly;
  if (isFinding(phase) && phase.present) {
    pushSafe(out, {
      id:       'artifact-phase',
      category: 'artifact',
      severity: severityFromArtifact(phase.severity),
      text:
        '좌/우 위상 이상의 감지된 패턴이 있습니다. ' +
        '모노 재생 시 일부 음원이 작아질 가능성이 있어 확인을 권장합니다.',
    });
  }

  const metallic = ac.metallicHighFreq;
  if (isFinding(metallic) && metallic.present) {
    pushSafe(out, {
      id:       'artifact-metallic',
      category: 'artifact',
      severity: severityFromArtifact(metallic.severity),
      text:
        '4–7 kHz 부근에서 금속성 AI 아티팩트의 감지된 패턴이 있습니다.',
    });
  }

  const sub = ac.subRumble;
  if (isFinding(sub) && sub.present) {
    pushSafe(out, {
      id:       'artifact-subrumble',
      category: 'artifact',
      severity: severityFromArtifact(sub.severity),
      text:
        '약 30 Hz 이하의 저역 럼블이 감지된 패턴이 있습니다. ' +
        '작은 스피커에서는 들리지 않을 가능성이 있습니다.',
    });
  }
}

function fromVocal(
  out: SmartRecommendation[],
  vi: VocalIntelligence,
): void {
  if (vi.vocalPresent) {
    if (isFiniteNumber(vi.clarityScore) && vi.clarityScore <= 0.5) {
      pushSafe(out, {
        id:       'vocal-clarity-low',
        category: 'vocal',
        severity: 'warn',
        text:
          '보컬 명료도가 낮은 패턴이 감지되었습니다. ' +
          'Natural 또는 Bright 모드가 가사 전달에 더 유리할 가능성이 있습니다.',
      });
    } else if (isFiniteNumber(vi.clarityScore) && vi.clarityScore >= 0.8) {
      pushSafe(out, {
        id:       'vocal-clarity-high',
        category: 'vocal',
        severity: 'info',
        text:
          '보컬이 또렷하게 감지되었습니다. ' +
          '강한 압축 시 보컬 자연스러움이 줄어들 가능성이 있습니다.',
      });
    }
    if (typeof vi.note === 'string' && vi.note.trim()) {
      pushSafe(out, {
        id:       'vocal-note',
        category: 'vocal',
        severity: 'info',
        text:     vi.note.trim(),
      });
    }
  }
}

function fromTranslation(
  out: SmartRecommendation[],
  tc: TranslationCheck,
): void {
  if (isFiniteNumber(tc.phone) && tc.phone <= 0.5) {
    pushSafe(out, {
      id:       'translation-phone',
      category: 'translation',
      severity: 'warn',
      text:
        '전화기 스피커에서는 저역이 약하게 들릴 가능성이 있습니다.',
    });
  }
  if (isFiniteNumber(tc.club) && tc.club <= 0.5) {
    pushSafe(out, {
      id:       'translation-club',
      category: 'translation',
      severity: 'warn',
      text:
        '클럽/대형 시스템에서 저역이 부족하게 들릴 가능성이 있습니다.',
    });
  }
  if (isFiniteNumber(tc.laptop) && tc.laptop <= 0.5) {
    pushSafe(out, {
      id:       'translation-laptop',
      category: 'translation',
      severity: 'info',
      text:
        '노트북 스피커에서 일부 음원이 묻혀 들릴 가능성이 있습니다.',
    });
  }
  if (Array.isArray(tc.notes)) {
    for (let i = 0; i < tc.notes.length; i++) {
      const n = tc.notes[i];
      if (typeof n === 'string' && n.trim()) {
        pushSafe(out, {
          id:       `translation-note-${i}`,
          category: 'translation',
          severity: 'info',
          text:     n.trim(),
        });
      }
    }
  }
}

/**
 * Build the recommendation list.  Returns at most 5 items, sorted with
 * danger first, then warn, then info.  Never throws — invalid inputs
 * yield an empty array.
 */
export function buildSmartRecommendations(
  input: SmartRecommendationInput,
): SmartRecommendation[] {
  const out: SmartRecommendation[] = [];

  if (input.sectionAnalysis)   fromSection(out, input.sectionAnalysis);
  if (input.modeSuggestion)    fromMode(out, input.modeSuggestion, input.currentMode ?? null);
  if (input.aiArtifactCheck)   fromArtifact(out, input.aiArtifactCheck);
  if (input.vocalIntelligence) fromVocal(out, input.vocalIntelligence);
  if (input.translationCheck)  fromTranslation(out, input.translationCheck);

  // Stable priority sort.
  out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  // De-duplicate by id (defensive).
  const seen = new Set<string>();
  const dedup: SmartRecommendation[] = [];
  for (const r of out) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    dedup.push(r);
  }

  return dedup.slice(0, 5);
}
