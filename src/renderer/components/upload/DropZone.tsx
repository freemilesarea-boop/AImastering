/**
 * 파일 드래그 앤 드롭 컴포넌트
 */
import React, { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import clsx from 'clsx'
import { useAudioEngine } from '../../hooks/useAudioEngine'
import { useAppStore } from '../../store/appStore'

const ACCEPTED_TYPES = {
  'audio/wav':  ['.wav'],
  'audio/flac': ['.flac'],
  'audio/aiff': ['.aiff', '.aif'],
  'audio/mpeg': ['.mp3'],
  'audio/mp4':  ['.m4a'],
}

export function DropZone() {
  const { selectAndAnalyze, isAnalyzing } = useAudioEngine()
  const { showNotification } = useAppStore()

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return

    const file = acceptedFiles[0]
    // Electron에서는 File 객체의 path 속성으로 실제 파일 경로 접근
    const filePath = (file as File & { path: string }).path
    if (!filePath) {
      showNotification('error', '파일 경로를 읽을 수 없습니다.')
      return
    }

    await selectAndAnalyze(filePath)
  }, [selectAndAnalyze, showNotification])

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxFiles: 1,
    disabled: isAnalyzing,
  })

  return (
    <div
      {...getRootProps()}
      className={clsx(
        'relative group flex flex-col items-center justify-center',
        'w-full h-72 rounded-2xl border-2 border-dashed cursor-pointer',
        'transition-all duration-200',
        isDragReject
          ? 'border-red-500 bg-red-900/10'
          : isDragActive
            ? 'border-violet-400 bg-violet-900/20 scale-[1.02]'
            : 'border-gray-700 hover:border-violet-600 hover:bg-violet-900/10',
        isAnalyzing && 'cursor-not-allowed opacity-60'
      )}
    >
      <input {...getInputProps()} />

      {/* 배경 그라디언트 (호버 시) */}
      <div className={clsx(
        'absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-200',
        'bg-gradient-to-br from-violet-900/10 to-transparent pointer-events-none'
      )} />

      {isAnalyzing ? (
        /* 분석 중 상태 */
        <div className="flex flex-col items-center gap-3 z-10">
          <div className="w-12 h-12 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-300 text-sm">파일 분석 중...</p>
        </div>
      ) : isDragReject ? (
        /* 거부 상태 */
        <div className="flex flex-col items-center gap-3 z-10">
          <svg className="w-14 h-14 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-red-400 font-medium">지원하지 않는 파일 형식</p>
          <p className="text-gray-500 text-xs">WAV, FLAC, AIFF, MP3, M4A 파일만 지원합니다</p>
        </div>
      ) : (
        /* 기본 상태 */
        <div className="flex flex-col items-center gap-4 z-10">
          {/* 음파 아이콘 */}
          <div className={clsx(
            'w-16 h-16 rounded-2xl flex items-center justify-center',
            isDragActive
              ? 'bg-violet-600/40 text-violet-300'
              : 'bg-violet-900/30 text-violet-400 group-hover:bg-violet-600/30 group-hover:text-violet-300',
            'transition-all duration-200'
          )}>
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>

          <div className="text-center">
            {isDragActive ? (
              <p className="text-violet-300 font-medium">여기에 놓으세요!</p>
            ) : (
              <>
                <p className="text-gray-200 font-medium mb-1">
                  오디오 파일을 여기에 드래그하거나
                </p>
                <p className="text-violet-400 hover:text-violet-300 transition-colors font-medium">
                  클릭하여 파일 선택
                </p>
              </>
            )}
          </div>

          <p className="text-gray-600 text-xs">
            WAV · FLAC · AIFF · MP3 · M4A 지원
          </p>
        </div>
      )}
    </div>
  )
}
