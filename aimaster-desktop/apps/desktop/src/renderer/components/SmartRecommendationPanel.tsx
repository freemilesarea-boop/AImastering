/**
 * SmartRecommendationPanel — Phase-E UI surface for the combined
 * Phase-D analyzers.  Pulls together sectionAnalysis, modeSuggestion,
 * aiArtifactCheck, vocalIntelligence and translationCheck and renders
 * 3–5 plain-language Korean recommendations.
 *
 * The actual logic lives in `./smartRecommendations.ts` so it is
 * testable without React.
 *
 * Safety contract:
 *   • Empty findings → component renders a quiet "특별히 권장 사항이
 *     없습니다." note.  We never assert "all good" with a green tick.
 *   • Any subset of inputs may be missing — the helper handles it.
 */
import React from 'react';
import {
  buildSmartRecommendations,
  SmartRecommendation,
  RecommendationSeverity,
  SmartRecommendationInput,
} from './smartRecommendations.js';

interface Props extends SmartRecommendationInput {
  /** Tailwind class overrides for the outer container. */
  className?: string;
}

const SEV_DOT: Record<RecommendationSeverity, string> = {
  danger: 'bg-red-400',
  warn:   'bg-amber-400',
  info:   'bg-sky-400',
};

const SEV_LABEL: Record<RecommendationSeverity, string> = {
  danger: '확인 필요',
  warn:   '주의',
  info:   '참고',
};

const SEV_TEXT: Record<RecommendationSeverity, string> = {
  danger: 'text-red-300',
  warn:   'text-amber-300',
  info:   'text-sky-300',
};

function Row({ rec }: { rec: SmartRecommendation }) {
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className={`mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${SEV_DOT[rec.severity]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-200 leading-snug">{rec.text}</p>
        <span className={`text-[11px] uppercase tracking-wider font-mono ${SEV_TEXT[rec.severity]}`}>
          {SEV_LABEL[rec.severity]}
        </span>
      </div>
    </li>
  );
}

export function SmartRecommendationPanel(props: Props) {
  const recs = buildSmartRecommendations(props);

  return (
    <div className={`rounded-xl bg-zinc-800/50 border border-zinc-800 p-4 ${props.className ?? ''}`}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-zinc-400 uppercase tracking-wider">스마트 권장 사항</p>
        <span className="text-[11px] text-zinc-400">
          {recs.length > 0 ? `${recs.length}개` : '0개'}
        </span>
      </div>

      {recs.length === 0 ? (
        <p className="text-[11px] text-zinc-300 leading-snug">
          특별히 권장 사항이 없습니다. 곡 자체를 더 잘 이해하기 위한 추가 분석은
          다음 마스터링 시 다시 시도됩니다.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {recs.map((r) => <Row key={r.id} rec={r} />)}
        </ul>
      )}
    </div>
  );
}

export default SmartRecommendationPanel;
