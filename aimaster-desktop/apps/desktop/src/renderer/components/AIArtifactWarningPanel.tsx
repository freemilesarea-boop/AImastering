/**
 * AIArtifactWarningPanel — Phase-E UI for Phase-D `aiArtifactCheck`.
 *
 * Surfaces three heuristic findings produced by the analyzer:
 *   • Phase anomaly       — L/R 위상 이상 (모노 재생 시 사라지는 트랙 등)
 *   • Metallic high-freq  — 4–7 kHz 인공적 금속성
 *   • Sub-rumble          — ~30 Hz 이하 저역 잡음
 *
 * Wording is deliberately conservative — we say "감지된 패턴",
 * "가능성이 있습니다" instead of asserting definitive defects.
 *
 * Safety contract:
 *   • Renders nothing when `check` is missing.
 *   • Findings with `present === false` are hidden silently — we only
 *     surface possible issues, never "all good" filler.
 *   • Unknown / extra finding fields are ignored.
 */
import React from 'react';
import type { AIArtifactCheck, AIArtifactFinding, AIArtifactSeverity } from '@aimaster/shared-types';

interface Props {
  check?: AIArtifactCheck | null | undefined;
}

const SEVERITY_CHIP: Record<AIArtifactSeverity, string> = {
  info:   'bg-sky-900/40 text-sky-300',
  warn:   'bg-amber-900/40 text-amber-300',
  danger: 'bg-red-900/40 text-red-300',
};

const SEVERITY_BORDER: Record<AIArtifactSeverity, string> = {
  info:   'border-sky-900/40',
  warn:   'border-amber-900/40',
  danger: 'border-red-900/40',
};

const SEVERITY_LABEL: Record<AIArtifactSeverity, string> = {
  info:   '참고',
  warn:   '주의',
  danger: '확인 필요',
};

interface FindingDescriptor {
  key:        string;
  title:      string;
  fallback:   string;
}

const DESCRIPTORS: Record<keyof AIArtifactCheck & string, FindingDescriptor> = {
  phaseAnomaly: {
    key:      'phaseAnomaly',
    title:    '위상 이상 가능성',
    fallback: '모노로 재생할 때 일부 음원이 작아질 수 있는 감지된 패턴입니다.',
  },
  metallicHighFreq: {
    key:      'metallicHighFreq',
    title:    '금속성 고역 가능성',
    fallback: '4–7 kHz 부근에서 AI 음원 특유의 금속성 패턴이 감지되었습니다.',
  },
  subRumble: {
    key:      'subRumble',
    title:    '서브 럼블 가능성',
    fallback: '약 30 Hz 이하 저역 럼블의 감지된 패턴이 있습니다.',
  },
  // analyzerVersion is metadata, not a finding — handled separately.
  analyzerVersion: { key: 'analyzerVersion', title: '', fallback: '' },
};

function isFinding(v: unknown): v is AIArtifactFinding {
  return typeof v === 'object'
    && v !== null
    && typeof (v as { present?: unknown }).present === 'boolean';
}

function FindingCard({
  descriptor, finding,
}: {
  descriptor: FindingDescriptor;
  finding:    AIArtifactFinding;
}) {
  const sev = finding.severity ?? 'warn';
  const border = SEVERITY_BORDER[sev] ?? SEVERITY_BORDER.warn;
  return (
    <div className={`rounded-md border ${border} bg-zinc-900/40 px-3 py-2`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-[12px] text-zinc-200">{descriptor.title}</p>
        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wider ${SEVERITY_CHIP[sev]}`}>
          {SEVERITY_LABEL[sev]}
        </span>
      </div>
      <p className="text-[11px] text-zinc-400 leading-snug">
        {finding.message?.trim() ? finding.message : descriptor.fallback}
      </p>
      {typeof finding.confidence === 'number' && Number.isFinite(finding.confidence) && (
        <p className="text-[11px] text-zinc-400 mt-1 font-mono">
          신뢰도 ~{Math.round(Math.max(0, Math.min(1, finding.confidence)) * 100)}%
        </p>
      )}
    </div>
  );
}

export function AIArtifactWarningPanel({ check }: Props) {
  if (!check) return null;

  const items: Array<{ descriptor: FindingDescriptor; finding: AIArtifactFinding }> = [];
  for (const key of ['phaseAnomaly', 'metallicHighFreq', 'subRumble'] as const) {
    const f = check[key];
    if (isFinding(f) && f.present) {
      items.push({ descriptor: DESCRIPTORS[key], finding: f });
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="rounded-xl bg-zinc-800/50 border border-zinc-800 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-400 uppercase tracking-wider">AI 아티팩트 감지</p>
        <span className="text-[11px] text-zinc-400">
          {items.length}건 가능성
          {check.analyzerVersion ? ` · v${check.analyzerVersion}` : ''}
        </span>
      </div>
      <div className="space-y-1.5">
        {items.map(({ descriptor, finding }) => (
          <FindingCard key={descriptor.key} descriptor={descriptor} finding={finding} />
        ))}
      </div>
      <p className="text-[11px] text-zinc-400 leading-snug pt-1 border-t border-zinc-800">
        ※ 위 항목들은 감지된 패턴일 뿐이며, 자동 보정은 수행하지 않습니다.
      </p>
    </div>
  );
}

export default AIArtifactWarningPanel;
