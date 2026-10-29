// engine-notice — say it when the engine can only run ffmpeg.
//
// `ffmpeg-notice.ts` exists because a missing encoder used to surface as a raw
// error at the end of a mastering run.  This is the same shape for a worse
// failure: when the engine's numpy or soundfile cannot be imported,
// `app/utils/audio_io.py` falls back and the engine KEEPS ANSWERING — every
// band at -120 dB, duration 0, `available: false` — and the app shows that as
// "레퍼런스 파일을 분석할 수 없습니다", a damaged-file message about a file
// that is fine.  Two PyInstaller specs shipped exactly that, both reached
// READY, and the loudness figures kept coming because those come from ffmpeg.
//
// The engine has answered `env_info` all along.  Nothing in the app asked.

export interface EngineWaveformStatus {
  available: boolean;
  numpy: string | null;
  soundfile: string | null;
  reason: string | null;
}

export interface EngineStatus {
  waveform?: EngineWaveformStatus;
}

/** Null when nothing is wrong, or when we could not ask; a sentence when it is. */
export function engineWarning(status: EngineStatus | null): string | null {
  if (status === null) return null;              // could not ask — say nothing
  const waveform = status.waveform;
  if (waveform === undefined) return null;       // an engine too old to answer
  if (waveform.available === true) return null;
  return '엔진이 파형을 읽을 수 없습니다 — 밴드 레벨 · 스테레오 폭 · 길이가 측정되지 않고, '
    + '정상 파일도 "분석할 수 없습니다"로 표시됩니다. 라우드니스 측정과 내보내기는 그대로 동작합니다.';
}

/**
 * Ask the main process, and hand back what to tell the user.
 *
 * A channel that throws is an older main process or a browser, and neither is
 * a reason to warn about the engine.
 */
export async function readEngineWarning(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): Promise<string | null> {
  try {
    const raw = await invoke('system:engine-status');
    if (raw === null || typeof raw !== 'object') return null;
    return engineWarning(raw as EngineStatus);
  } catch {
    return null;
  }
}
