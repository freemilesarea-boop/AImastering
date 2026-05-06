/**
 * 숫자/단위 포매터 유틸리티
 */

/** LUFS 값 포매터 (소수점 1자리) */
export function formatLUFS(value: number | null | undefined): string {
  if (value == null || !isFinite(value)) return '–'
  return `${value.toFixed(1)} LUFS`
}

/** True Peak 포매터 */
export function formatTruePeak(value: number | null | undefined): string {
  if (value == null || !isFinite(value)) return '–'
  return `${value.toFixed(1)} dBTP`
}

/** 초 → mm:ss */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** 바이트 → 사람이 읽기 쉬운 단위 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 샘플레이트 포매터 */
export function formatSampleRate(hz: number): string {
  return `${(hz / 1000).toFixed(1)} kHz`
}

/** 처리 시간 포매터 */
export function formatProcessingTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}초`
}

/** LUFS 값에 따른 색상 클래스 반환 */
export function getLUFSColor(lufs: number, target: number): string {
  const diff = Math.abs(lufs - target)
  if (diff <= 0.5) return 'text-green-400'
  if (diff <= 2.0) return 'text-yellow-400'
  return 'text-red-400'
}

/** True Peak에 따른 색상 클래스 반환 */
export function getTPColor(tp: number, limit: number): string {
  if (tp <= limit) return 'text-green-400'
  if (tp <= limit + 1) return 'text-yellow-400'
  return 'text-red-400'
}
