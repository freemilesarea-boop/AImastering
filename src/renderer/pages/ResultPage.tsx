/**
 * 마스터링 결과 페이지 v2
 * - 유료: Master WAV + Preview MP3 다운로드
 * - 무료: Preview MP3만 다운로드, WAV는 업그레이드 유도
 * - AI 자동 보정 결과 표시
 */
import React from 'react'
import clsx from 'clsx'
import { LoudnessGauge } from '../components/mastering/LoudnessGauge'
import { BeforeAfterCompare } from '../components/mastering/BeforeAfterCompare'
import { MetricComparison } from '../components/mastering/MetricComparison'
import { QualityCheckReport } from '../components/mastering/QualityCheckReport'
import { ProcessingChainBadge } from '../components/mastering/ProcessingChainBadge'
import { Button } from '../components/common/Button'
import { useAudioEngine } from '../hooks/useAudioEngine'
import { useAppStore } from '../store/appStore'
import { useLicense } from '../hooks/useLicense'
import { formatDuration, formatFileSize, formatProcessingTime } from '../utils/formatters'
import {
  MASTERING_MODES,
  MasteringMode,
  LIMITER_STRENGTH_LABELS,
} from '../types/audio'

// AI 자동 보정 항목 레이블
const AI_CORRECTION_LABELS: Record<string, string> = {
  harsh_highmid: '고역 자극 (3~5kHz) 보정 적용',
  boomy_low:     '저역 과잉 보정 적용',
}

export function ResultPage() {
  const { masteringResult, masteringOptions, showInFinder, runQC, reset } = useAudioEngine()
  const { navigateTo } = useAppStore()
  const { licenseInfo, setShowModal } = useLicense()

  if (!masteringResult) {
    navigateTo('home')
    return null
  }

  const { inputAnalysis: input, outputAnalysis: output } = masteringResult
  const isPaid = licenseInfo?.canSaveMasterWav ?? false
  const stylePreset = MASTERING_MODES.find(p => p.id === ((masteringResult.mode || masteringResult.style) as MasteringMode))

  // LUFS 개선량
  const lfusDiff = output.lufsIntegrated - input.lufsIntegrated
  const lfusDiffStr = `${lfusDiff >= 0 ? '+' : ''}${lfusDiff.toFixed(1)} LUFS`

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-5">

        {/* ── 헤더 ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-900/40 rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-100">마스터링 완료</h1>
              <p className="text-xs text-gray-500">
                {stylePreset?.emoji} {stylePreset?.name} 스타일 ·{' '}
                {formatProcessingTime(masteringResult.processingTimeMs)}
              </p>
            </div>
          </div>
        </div>

        {/* ── AI 자동 보정 결과 ── */}
        {masteringResult.aiCorrectionsApplied.length > 0 && (
          <div className="bg-violet-900/20 border border-violet-800/40 rounded-xl px-4 py-3">
            <div className="flex items-start gap-2.5">
              <span className="text-violet-400 text-sm flex-shrink-0">✦</span>
              <div>
                <p className="text-sm text-violet-300 font-medium">AI 자동 보정 적용됨</p>
                <ul className="mt-1 space-y-0.5">
                  {masteringResult.aiCorrectionsApplied.map(c => (
                    <li key={c} className="text-xs text-violet-400/70">
                      · {AI_CORRECTION_LABELS[c] || c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ── 마스터링 리포트 (v3) ── */}
        {masteringResult.report && (
          <MasteringReportPanel report={masteringResult.report} />
        )}

        {/* ── 적용된 처리 체인 (v3.1) ── */}
        <ProcessingChainBadge
          stages={
            masteringResult.processingChain ??
            masteringResult.report?.processingChain
          }
        />

        {/* ── 전/후 waveform + A/B 미리듣기 (v3.1) ── */}
        <BeforeAfterCompare
          beforeAudioPath={masteringResult.originalPath ?? null}
          afterAudioPath={masteringResult.previewPath ?? masteringResult.outputPath}
          beforeWaveformPath={masteringResult.beforeWaveformPath}
          afterWaveformPath={masteringResult.afterWaveformPath}
        />

        {/* ── 분석 값 비교 (v3.1) ── */}
        {(masteringResult.metricComparison ?? masteringResult.report?.metricComparison) && (
          <MetricComparison
            rows={
              masteringResult.metricComparison ??
              masteringResult.report?.metricComparison ??
              []
            }
          />
        )}

        {/* ── 품질 체크 리포트 (v3.1) ── */}
        <QualityCheckReport
          result={
            masteringResult.qualityCheck ??
            masteringResult.report?.qualityCheck ??
            null
          }
        />

        {/* ── LUFS 게이지 전/후 비교 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-600 uppercase tracking-wide font-medium mb-2 px-0.5">원본</p>
            <LoudnessGauge
              lufsIntegrated={input.lufsIntegrated}
              truePeak={input.truePeak}
              lra={input.lra}
              targetLUFS={masteringOptions.targetLUFS ?? -14}
              targetTP={masteringOptions.targetTruePeak ?? -1.0}
            />
          </div>
          <div>
            <p className="text-xs text-violet-400 uppercase tracking-wide font-medium mb-2 px-0.5">
              마스터링 후
            </p>
            <LoudnessGauge
              lufsIntegrated={output.lufsIntegrated}
              truePeak={output.truePeak}
              lra={output.lra}
              targetLUFS={masteringOptions.targetLUFS ?? -14}
              targetTP={masteringOptions.targetTruePeak ?? -1.0}
            />
          </div>
        </div>

        {/* ── 요약 수치 ── */}
        <div className="grid grid-cols-4 gap-2">
          {[
            {
              label: 'LUFS 변화',
              value: lfusDiffStr,
              sub: `${output.lufsIntegrated.toFixed(1)} LUFS`,
              ok: Math.abs(output.lufsIntegrated - (masteringOptions.targetLUFS ?? -14)) <= 0.5,
            },
            {
              label: 'True Peak',
              value: `${output.truePeak.toFixed(1)} dBTP`,
              sub: output.truePeak <= (masteringOptions.targetTruePeak ?? -1.0) ? '✓ 한계 내' : '⚠ 초과',
              ok: output.truePeak <= (masteringOptions.targetTruePeak ?? -1.0),
            },
            {
              label: 'LRA',
              value: `${output.lra.toFixed(1)} LU`,
              sub: output.lra >= 5 ? '다이나믹 양호' : '압축됨',
              ok: output.lra >= 5,
            },
            {
              label: '처리 시간',
              value: formatProcessingTime(masteringResult.processingTimeMs),
              sub: formatDuration(input.duration) + ' 파일',
              ok: true,
            },
          ].map(({ label, value, sub, ok }) => (
            <div key={label} className="bg-surface-800 rounded-xl p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">{label}</div>
              <div className={clsx('text-base font-bold font-mono', ok ? 'text-green-400' : 'text-yellow-400')}>
                {value}
              </div>
              <div className="text-xs text-gray-600 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* ── 파일 다운로드 ── */}
        <div className="space-y-2.5">
          <h3 className="text-sm font-medium text-gray-400">다운로드</h3>

          {/* Master WAV — 유료만 */}
          <div className={clsx(
            'flex items-center gap-3 p-3.5 rounded-xl border',
            isPaid
              ? 'bg-surface-800 border-gray-700'
              : 'bg-surface-800/40 border-gray-800 opacity-75'
          )}>
            <div className={clsx(
              'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
              isPaid ? 'bg-green-900/40' : 'bg-gray-800'
            )}>
              <svg className={clsx('w-4.5 h-4.5', isPaid ? 'text-green-400' : 'text-gray-600')}
                fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-200">Master WAV</span>
                <span className="text-xs bg-green-900/30 text-green-400 px-1.5 py-0.5 rounded">고품질</span>
                {!isPaid && (
                  <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">유료 전용</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {isPaid
                  ? masteringResult.outputPath.split('/').pop()
                  : '24-bit WAV — Pro 플랜에서 저장 가능'}
              </p>
            </div>
            {isPaid ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => showInFinder(masteringResult.outputPath)}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                저장 위치 열기
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setShowModal(true)}>
                업그레이드
              </Button>
            )}
          </div>

          {/* Preview MP3 — 무료 포함 항상 가능 */}
          {masteringResult.previewPath && (
            <div className="flex items-center gap-3 p-3.5 bg-surface-800 border border-gray-700 rounded-xl">
              <div className="w-9 h-9 bg-violet-900/40 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg className="w-4.5 h-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M15.536 8.464a5 5 0 010 7.072M12 6v12m0 0l-3-3m3 3l3-3M6.343 5.657a10 10 0 000 14.142" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-200">Preview MP3</span>
                  <span className="text-xs bg-violet-900/30 text-violet-400 px-1.5 py-0.5 rounded">320kbps</span>
                  <span className="text-xs bg-green-900/20 text-green-500 px-1.5 py-0.5 rounded">무료 포함</span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {masteringResult.previewPath.split('/').pop()}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => showInFinder(masteringResult.previewPath!)}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                저장 위치 열기
              </Button>
            </div>
          )}
        </div>

        {/* ── 액션 버튼 ── */}
        <div className="flex gap-2.5">
          <Button
            variant="secondary"
            size="md"
            className="flex-1"
            onClick={() => { runQC(isPaid ? masteringResult.outputPath : masteringResult.previewPath || undefined); navigateTo('qc') }}
          >
            QC 검사
          </Button>
          <Button
            variant="secondary"
            size="md"
            className="flex-1"
            onClick={() => { reset(); navigateTo('home') }}
          >
            새 파일 처리
          </Button>
        </div>

        {/* 무료 체험 업그레이드 배너 */}
        {!isPaid && (
          <div className="bg-gradient-to-r from-violet-900/30 to-indigo-900/30 border border-violet-800/30 rounded-2xl p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-violet-300">Master WAV를 저장하려면 Pro 플랜이 필요합니다</p>
              <p className="text-xs text-gray-500 mt-0.5">무제한 처리 · Warm/Bright/Punch 스타일 · 리포트 내보내기</p>
            </div>
            <Button size="sm" onClick={() => setShowModal(true)} className="flex-shrink-0">
              업그레이드
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// 마스터링 리포트 패널 (v3)
// ─────────────────────────────────────────────────────
import type { MasteringReport } from '../types/audio'

interface ReportRowProps {
  label: string
  value: string
  ok?:   boolean
  hint?: string
}

function ReportRow({ label, value, ok, hint }: ReportRowProps) {
  const colorClass =
    ok === undefined ? 'text-gray-200' :
    ok                ? 'text-green-400' : 'text-yellow-400'
  return (
    <div className="bg-surface-900/60 rounded-lg p-2.5">
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className={clsx('text-sm font-mono font-semibold', colorClass)}>{value}</div>
      {hint && <div className="text-[10px] text-gray-600 mt-0.5">{hint}</div>}
    </div>
  )
}

function MasteringReportPanel({ report }: { report: MasteringReport }) {
  const lufsOK = Math.abs(report.lufsDelta) <= 0.5
  const tpOK   = report.truePeakOverDb <= 0.05

  return (
    <div className={clsx(
      'rounded-2xl border p-4 space-y-3',
      report.targetReached
        ? 'bg-emerald-900/15 border-emerald-800/40'
        : 'bg-yellow-900/15 border-yellow-800/40'
    )}>
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={clsx(
            'w-7 h-7 rounded-lg flex items-center justify-center',
            report.targetReached ? 'bg-emerald-900/40' : 'bg-yellow-900/40'
          )}>
            {report.targetReached ? (
              <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" />
              </svg>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-100">마스터링 리포트</h3>
            <p className="text-xs text-gray-500">
              모드: <span className="text-gray-300 font-medium">{report.mode}</span> ·
              리미터: <span className="text-gray-300 font-medium">{LIMITER_STRENGTH_LABELS[report.limiterStrength]}</span>
              {report.dynamicEqMode && report.dynamicEqMode !== 'disabled' && (
                <> · Dynamic EQ: <span className="text-gray-300 font-medium">{report.dynamicEqMode}</span></>
              )}
            </p>
          </div>
        </div>
        <span className={clsx(
          'text-xs font-medium px-2 py-1 rounded-full',
          report.targetReached
            ? 'bg-emerald-900/40 text-emerald-300'
            : 'bg-yellow-900/40 text-yellow-300'
        )}>
          {report.targetReached ? '목표 달성' : '목표 미달'}
        </span>
      </div>

      {/* 핵심 수치 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <ReportRow
          label="Before LUFS"
          value={`${report.beforeLUFS.toFixed(1)} LUFS`}
        />
        <ReportRow
          label="After LUFS"
          value={`${report.afterLUFS.toFixed(1)} LUFS`}
          ok={lufsOK}
          hint={`목표 ${report.targetLUFS.toFixed(1)} (Δ ${report.lufsDelta >= 0 ? '+' : ''}${report.lufsDelta.toFixed(1)})`}
        />
        <ReportRow
          label="Before TP"
          value={`${report.beforeTruePeak.toFixed(1)} dBTP`}
        />
        <ReportRow
          label="After TP"
          value={`${report.afterTruePeak.toFixed(1)} dBTP`}
          ok={tpOK}
          hint={`한계 ${report.targetTruePeak.toFixed(1)}${report.truePeakOverDb > 0 ? ` (+${report.truePeakOverDb.toFixed(1)} 초과)` : ''}`}
        />
        <ReportRow
          label="Applied Gain"
          value={`${report.appliedGainDb >= 0 ? '+' : ''}${report.appliedGainDb.toFixed(1)} dB`}
          hint="원본→출력 라우드니스 변화"
        />
        <ReportRow
          label="Limiter Reduction"
          value={`~${report.limiterReductionDb.toFixed(1)} dB`}
          hint="리미터에 의한 압축 추정량"
        />
        <ReportRow
          label="Selected Mode"
          value={report.mode}
        />
        <ReportRow
          label="Target"
          value={`${report.targetLUFS.toFixed(1)} / ${report.targetTruePeak.toFixed(1)}`}
          hint="LUFS / dBTP"
        />
      </div>

      {/* 보정 적용 안내 */}
      {report.correctionApplied && (
        <div className="bg-violet-900/20 border border-violet-800/40 rounded-lg px-3 py-2 text-xs text-violet-300">
          ✦ 자동 보정 pass 적용됨 · 게인 조정 {report.correctionGainDb >= 0 ? '+' : ''}{report.correctionGainDb.toFixed(2)} dB
        </div>
      )}

      {/* 경고 목록 */}
      {report.warnings.length > 0 && (
        <div className="bg-yellow-900/15 border border-yellow-800/40 rounded-lg px-3 py-2 space-y-1">
          <p className="text-xs text-yellow-300 font-medium">⚠ 주의사항</p>
          <ul className="text-[11px] text-yellow-200/80 space-y-0.5 list-disc pl-4">
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
