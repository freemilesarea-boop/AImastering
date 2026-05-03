/**
 * Reference warning banner (v3.4.1).
 *
 * Reference 관련 자동 경고를 한 곳에 모아 보여줍니다.  Engine 의
 * `validate_reference()` + `compare_input_vs_reference()` 가 만든
 * `referenceWarnings` 배열을 그대로 받아 카드 형태로 렌더링.
 *
 * 표시 우선순위: danger → warn → info.
 */
import React from 'react'
import clsx from 'clsx'
import type { ReferenceWarning } from '../../types/audio'

const SEVERITY_STYLE = {
  info: {
    ring: 'border-blue-800/40',
    bg:   'bg-blue-900/15',
    text: 'text-blue-300',
    icon: 'ℹ️',
    label: '참고',
  },
  warn: {
    ring: 'border-yellow-800/40',
    bg:   'bg-yellow-900/15',
    text: 'text-yellow-300',
    icon: '⚠️',
    label: '주의',
  },
  danger: {
    ring: 'border-red-800/40',
    bg:   'bg-red-900/15',
    text: 'text-red-300',
    icon: '⛔',
    label: '위험',
  },
}

const CODE_HINT: Record<string, string> = {
  REFERENCE_TOO_QUIET:
    '대안: 발매된 마스터링 곡으로 교체하거나, 레퍼런스 없이 "장르 프리셋" 으로 시작.',
  REFERENCE_TOO_LOUD:
    '대안: 클리핑 없는 다른 발매곡으로 교체.',
  REFERENCE_TP_OVER:
    '대안: 인터샘플 피크가 있는 곡 — 레퍼런스로 부적절합니다.',
  REFERENCE_BRICKWALL:
    '결과도 비슷한 압축감을 가질 수 있습니다.  더 다이내믹한 결과를 원하면 다른 곡 권장.',
  REFERENCE_VERY_DYNAMIC:
    '클래식/재즈 라이브 녹음일 가능성 — 일반 스트리밍 마스터링과 다를 수 있음.',
  REFERENCE_TOO_SHORT:
    '대안: 30초 이상의 곡으로 교체.',
  REFERENCE_UNAVAILABLE:
    '파일이 손상되었거나 지원되지 않는 코덱입니다.  WAV/FLAC 권장.',
  GENRE_MISMATCH_WARN:
    '비슷한 장르의 다른 곡을 골라보세요.',
  GENRE_MISMATCH_DANGER:
    '레퍼런스를 더 비슷한 장르로 교체하거나 "장르 프리셋" 사용을 권장합니다.',
  INPUT_FAR_MORE_DYNAMIC:
    '입력이 미마스터링 mix 같습니다.  Reference 매칭 결과가 부자연스러울 수 있습니다.',
  STEREO_WIDTH_MISMATCH:
    '레퍼런스의 스테레오 폭과 입력이 크게 다릅니다.  결과 폭은 입력에 가깝게 유지됩니다.',
}

const SEVERITY_RANK = { danger: 0, warn: 1, info: 2 } as const

interface Props {
  warnings: ReferenceWarning[] | undefined | null
}

export function ReferenceWarningBanner({ warnings }: Props) {
  if (!warnings || warnings.length === 0) return null

  // Sort by severity (danger first), keep input order within same severity
  const sorted = [...warnings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
  )

  const worst = sorted[0].severity
  const banner = SEVERITY_STYLE[worst]

  return (
    <div className={clsx('rounded-2xl border p-4 space-y-2.5', banner.bg, banner.ring)}>
      <div className="flex items-center gap-2">
        <span className="text-base">{banner.icon}</span>
        <h3 className="text-sm font-semibold text-gray-100">
          레퍼런스 점검 결과 ({sorted.length}건)
        </h3>
        <span className={clsx('text-[10px] uppercase font-medium px-1.5 py-0.5 rounded',
                              banner.bg, banner.text)}>
          {banner.label}
        </span>
      </div>

      <div className="space-y-1.5">
        {sorted.map((w, i) => {
          const s = SEVERITY_STYLE[w.severity] ?? SEVERITY_STYLE.info
          const hint = CODE_HINT[w.code]
          return (
            <div key={`${w.code}-${i}`}
                 className="flex items-start gap-2 bg-surface-900/50 rounded-lg px-3 py-2">
              <span className="text-sm leading-tight">{s.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <code className="text-[10px] text-gray-500">{w.code}</code>
                  <span className={clsx('text-[10px] uppercase font-medium', s.text)}>
                    {s.label}
                  </span>
                </div>
                <p className="text-[11px] text-gray-300 mt-0.5">{w.userMessage}</p>
                {hint && (
                  <p className="text-[10px] text-gray-500 mt-1">{hint}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
