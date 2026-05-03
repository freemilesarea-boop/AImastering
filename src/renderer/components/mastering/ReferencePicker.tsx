/**
 * Reference picker (v3.4.1).
 *
 * 사용자가 reference 파일을 잘 못 고르면 결과가 망하기 때문에:
 *
 *  1. 항상 보이는 가이드 문구 — "어떤 곡을 골라야 하는지"
 *  2. 파일 선택 + (선택 안 하고) 프리셋 드롭다운 (장르별 built-in 프로파일)
 *  3. 입력 파일이 있으면 "이 곡에는 ___ 프리셋이 어울려요" 자동 추천
 *
 * 아래 props 는 부모 컴포넌트가 IPC 로 받은 데이터를 그대로 전달.
 */
import React from 'react'
import clsx from 'clsx'
import type {
  ReferencePreset, ReferencePresetRecommendation,
} from '../../types/audio'

const GUIDE_BULLETS = [
  '✓ 비슷한 장르의 곡을 선택하세요 (K-Pop → K-Pop, 록 → 록).',
  '✓ 보컬 / 톤이 비슷한 곡을 선택하세요 (남보컬 ↔ 남보컬, 어쿠스틱 ↔ 어쿠스틱).',
  '✓ 최종 목표 사운드에 가까운 곡을 넣으세요 — 마스터링은 그 곡에 가까워지려 합니다.',
]

const ANTI_BULLETS = [
  '✗ 미마스터링 데모 / 믹스 단계 곡은 피하세요 (LUFS 너무 낮음).',
  '✗ 1분 미만의 짧은 클립은 피하세요 (측정이 부정확).',
  '✗ MP3 < 192 kbps 는 피하세요 (코덱 손실).',
]

interface Props {
  /** Currently selected reference file path, or null. */
  referencePath?: string | null
  /** All built-in presets (from list_reference_presets RPC). */
  presets: ReferencePreset[]
  /** Currently selected preset key, or null. */
  selectedPresetKey?: string | null
  /** Auto-recommended preset for the input file (from recommend_reference_preset RPC). */
  recommendation?: ReferencePresetRecommendation | null

  onPickReferenceFile?: () => void
  onClearReferenceFile?: () => void
  onPickPreset?:        (key: string) => void
}

export function ReferencePicker({
  referencePath, presets, selectedPresetKey, recommendation,
  onPickReferenceFile, onClearReferenceFile, onPickPreset,
}: Props) {
  const usingFile   = !!referencePath
  const usingPreset = !!selectedPresetKey
  const nothingPicked = !usingFile && !usingPreset

  return (
    <div className="space-y-3">
      {/* Header + guidance */}
      <div className="rounded-2xl border border-blue-800/30 bg-blue-950/20 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-base">🎯</span>
          <h3 className="text-sm font-semibold text-gray-100">레퍼런스 선택 가이드</h3>
        </div>
        <p className="text-[11px] text-gray-400">
          마스터링 결과는 레퍼런스에 가깝게 만들어집니다. 어떤 곡을 고르느냐가 결과를 좌우합니다.
        </p>
        <div className="grid grid-cols-1 gap-1 text-[11px] mt-2">
          {GUIDE_BULLETS.map((b, i) => (
            <div key={i} className="text-emerald-300/90">{b}</div>
          ))}
          {ANTI_BULLETS.map((b, i) => (
            <div key={i} className="text-red-300/70">{b}</div>
          ))}
        </div>
      </div>

      {/* File picker */}
      <div className="rounded-2xl border border-surface-700 bg-surface-900/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-gray-200">레퍼런스 파일</h4>
            <p className="text-[11px] text-gray-500">발매된 마스터링 곡을 추천합니다.</p>
          </div>
          {usingFile ? (
            <button
              type="button"
              onClick={onClearReferenceFile}
              className="text-[11px] text-gray-400 hover:text-gray-200"
            >
              제거
            </button>
          ) : (
            <button
              type="button"
              onClick={onPickReferenceFile}
              className="text-[11px] px-3 py-1.5 rounded-md bg-surface-800 hover:bg-surface-700
                         text-gray-200 border border-surface-700"
            >
              파일 선택
            </button>
          )}
        </div>
        {usingFile && (
          <div className="text-[11px] font-mono text-gray-300 truncate bg-surface-900 rounded p-2">
            {referencePath}
          </div>
        )}
      </div>

      {/* OR divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-surface-700" />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider">또는</span>
        <div className="flex-1 border-t border-surface-700" />
      </div>

      {/* Preset selector */}
      <div className="rounded-2xl border border-surface-700 bg-surface-900/40 p-4 space-y-3">
        <div>
          <h4 className="text-sm font-medium text-gray-200">장르 프리셋 (레퍼런스 없이 시작)</h4>
          <p className="text-[11px] text-gray-500 mt-0.5">
            적절한 레퍼런스가 없을 때 — 장르별로 미리 만들어진 타깃 프로파일.
          </p>
        </div>

        {recommendation && nothingPicked && (
          <div className="rounded-lg border border-yellow-800/40 bg-yellow-900/10 p-2.5">
            <div className="flex items-start gap-2">
              <span className="text-sm">💡</span>
              <div className="min-w-0">
                <div className="text-[11px] text-yellow-300 font-medium">
                  자동 추천: {recommendation.label} ({recommendation.targetLufs} LUFS)
                </div>
                <p className="text-[10px] text-gray-400 mt-0.5">{recommendation.reason}</p>
              </div>
              <button
                type="button"
                onClick={() => onPickPreset?.(recommendation.key)}
                className="text-[10px] px-2 py-1 rounded bg-yellow-900/40 hover:bg-yellow-900/60
                           text-yellow-200 border border-yellow-800/50 shrink-0"
              >
                적용
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {presets.map(p => {
            const isSelected = selectedPresetKey === p.key
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => onPickPreset?.(p.key)}
                disabled={usingFile}
                className={clsx(
                  'text-left rounded-lg border p-2.5 transition-colors',
                  isSelected
                    ? 'border-emerald-700 bg-emerald-900/20'
                    : 'border-surface-700 bg-surface-900/40 hover:border-surface-600',
                  usingFile && 'opacity-50 cursor-not-allowed',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-gray-100">{p.label}</span>
                  <span className="text-[10px] font-mono text-gray-400">
                    {p.targetLufs} LUFS
                  </span>
                </div>
                <p className="text-[10px] text-gray-500 mt-0.5">{p.description}</p>
                <p className="text-[10px] text-gray-600 mt-1 italic">→ {p.bestFor}</p>
              </button>
            )
          })}
        </div>

        {usingFile && (
          <p className="text-[10px] text-gray-500 italic">
            파일이 선택되어 있어 프리셋이 비활성화되어 있습니다.
          </p>
        )}
      </div>
    </div>
  )
}
