/**
 * 마스터링 전/후 비교 컴포넌트 (v3.1)
 *
 * 다음을 한 화면에 묶어 표시:
 *  · Before / After waveform 이미지 (가로로 stack)
 *  · A/B 미리듣기 플레이어 (원본/결과물 토글)
 *  · 같은 구간 위치 동기화 (currentTime 공유)
 *
 * waveform 이미지 경로가 없으면 fallback 으로 텍스트 메시지 표시
 * (waveform 생성이 실패해도 화면은 정상 동작).
 */
import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

interface Props {
  beforeAudioPath:    string | null
  afterAudioPath:     string | null
  beforeWaveformPath: string | null | undefined
  afterWaveformPath:  string | null | undefined
}

type Side = 'before' | 'after'

export function BeforeAfterCompare({
  beforeAudioPath,
  afterAudioPath,
  beforeWaveformPath,
  afterWaveformPath,
}: Props) {
  const [side, setSide] = useState<Side>('after')
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const audioBeforeRef = useRef<HTMLAudioElement | null>(null)
  const audioAfterRef  = useRef<HTMLAudioElement | null>(null)

  const activeRef = side === 'before' ? audioBeforeRef : audioAfterRef
  const inactiveRef = side === 'before' ? audioAfterRef : audioBeforeRef

  // A/B 토글 시 같은 구간으로 동기화
  useEffect(() => {
    const a = activeRef.current
    const inactive = inactiveRef.current
    if (!a) return
    if (inactive) {
      inactive.pause()
    }
    a.currentTime = currentTime
    if (playing) {
      a.play().catch(() => setPlaying(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side])

  const onPlayPause = () => {
    const a = activeRef.current
    if (!a) return
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else {
      a.pause()
      setPlaying(false)
    }
  }

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value)
    setCurrentTime(t)
    const a = activeRef.current
    if (a) a.currentTime = t
  }

  const onTimeUpdate = () => {
    const a = activeRef.current
    if (a) setCurrentTime(a.currentTime)
  }

  const onLoadedMeta = () => {
    const a = activeRef.current
    if (a && Number.isFinite(a.duration)) setDuration(a.duration)
  }

  const formatTime = (s: number) => {
    if (!Number.isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const beforeSrc = beforeAudioPath ? `file://${beforeAudioPath}` : ''
  const afterSrc  = afterAudioPath  ? `file://${afterAudioPath}`  : ''

  return (
    <div className="bg-surface-800 border border-gray-700 rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">전/후 비교</h3>
          <p className="text-xs text-gray-500">같은 구간을 A/B 로 들어보며 비교합니다</p>
        </div>
        <div className="flex bg-surface-900 rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setSide('before')}
            className={clsx(
              'px-3 py-1 text-xs font-medium rounded-md transition-colors',
              side === 'before' ? 'bg-gray-700 text-gray-100' : 'text-gray-500 hover:text-gray-300',
            )}
            disabled={!beforeAudioPath}
          >
            원본
          </button>
          <button
            type="button"
            onClick={() => setSide('after')}
            className={clsx(
              'px-3 py-1 text-xs font-medium rounded-md transition-colors',
              side === 'after' ? 'bg-violet-700 text-violet-50' : 'text-gray-500 hover:text-gray-300',
            )}
            disabled={!afterAudioPath}
          >
            마스터링 후
          </button>
        </div>
      </div>

      {/* Waveform 비교 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <WaveformCard
          label="원본"
          imagePath={beforeWaveformPath}
          color="text-gray-400"
          highlighted={side === 'before'}
        />
        <WaveformCard
          label="마스터링 후"
          imagePath={afterWaveformPath}
          color="text-violet-300"
          highlighted={side === 'after'}
        />
      </div>

      {/* 플레이어 */}
      <div className="bg-surface-900 rounded-xl p-3 space-y-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPlayPause}
            disabled={!activeRef.current?.src}
            className={clsx(
              'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0',
              playing
                ? 'bg-violet-700 hover:bg-violet-600 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-100',
            )}
          >
            {playing ? (
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6"  y="5" width="4" height="14" rx="1"/>
                <rect x="14" y="5" width="4" height="14" rx="1"/>
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </button>
          <div className="flex-1">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={currentTime}
              onChange={onSeek}
              className="w-full accent-violet-500"
            />
          </div>
          <div className="text-xs text-gray-400 font-mono tabular-nums w-20 text-right">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
        <p className="text-[11px] text-gray-500">
          A/B 토글로 동일 구간에서 즉시 비교됩니다 ·{' '}
          현재 재생 중: <span className="text-gray-300">{side === 'before' ? '원본' : '마스터링 후'}</span>
        </p>
      </div>

      {/* 숨은 audio 태그 두 개 — A/B 토글로 활성/비활성 */}
      <audio
        ref={audioBeforeRef}
        src={beforeSrc}
        preload="metadata"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onEnded={() => setPlaying(false)}
      />
      <audio
        ref={audioAfterRef}
        src={afterSrc}
        preload="metadata"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onEnded={() => setPlaying(false)}
      />
    </div>
  )
}

function WaveformCard({
  label, imagePath, color, highlighted,
}: {
  label:        string
  imagePath:    string | null | undefined
  color:        string
  highlighted:  boolean
}) {
  const [error, setError] = useState(false)
  const src = imagePath && !error ? `file://${imagePath}` : null
  return (
    <div
      className={clsx(
        'rounded-xl border overflow-hidden transition-colors',
        highlighted ? 'border-violet-700/60 bg-surface-900/80' : 'border-gray-700 bg-surface-900/40',
      )}
    >
      <div className="px-3 py-2 flex items-center justify-between">
        <span className={clsx('text-xs font-medium', color)}>{label}</span>
        {highlighted && <span className="text-[10px] text-violet-300">▶ 재생 중</span>}
      </div>
      <div className="relative h-24 bg-slate-950/60">
        {src ? (
          <img
            src={src}
            alt={`${label} waveform`}
            className="w-full h-full object-contain"
            onError={() => setError(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-600">
            waveform 이미지 없음
          </div>
        )}
      </div>
    </div>
  )
}
