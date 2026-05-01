/**
 * 적용된 처리 체인 표시 컴포넌트 (v3.1)
 * 예: EQ → Dynamic EQ → Compressor → Saturation → Limiter
 */
import React from 'react'

interface Props {
  stages: string[] | undefined
}

export function ProcessingChainBadge({ stages }: Props) {
  if (!stages || stages.length === 0) return null
  return (
    <div className="bg-surface-800 border border-gray-700 rounded-xl px-4 py-3">
      <div className="text-[11px] text-gray-500 uppercase tracking-wide font-medium mb-1.5">
        적용된 처리 체인
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {stages.map((stage, idx) => (
          <React.Fragment key={`${idx}-${stage}`}>
            <span className="text-xs px-2 py-1 rounded-md bg-violet-900/25 text-violet-300 border border-violet-800/30">
              {stage}
            </span>
            {idx < stages.length - 1 && (
              <svg className="w-3 h-3 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}
