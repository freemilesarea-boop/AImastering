// ffmpeg-notice — say it when the encoder is missing, before it is needed.
//
// `system:ffmpeg-status` has been answered by the main process since the
// beginning and asked by nobody.  main/index.ts computes it, logs it, and
// records a failure when it is absent — all of which a user never sees.  What
// they see is an export that dies on a raw ffmpeg error, at the end of a
// mastering run, on a file they wanted.
//
// So the renderer asks once at startup, and the answer becomes a warning up
// front.  It is only a warning: WAV export is a plain copy and never touches
// ffmpeg, so a machine without it can still do the main thing.  What it loses
// is MP3/FLAC/AIFF encoding and the decode of anything that is not a WAV —
// which is worth knowing before importing an m4a, not after.

export interface FfmpegStatus {
  available: boolean;
  ffprobeAvailable?: boolean;
}

/** Null when nothing is wrong; a sentence when something is. */
export function ffmpegWarning(status: FfmpegStatus | null): string | null {
  if (status === null) return null;          // could not ask — say nothing
  if (!status.available) {
    return 'FFmpeg을 찾지 못했습니다 — MP3 · FLAC · AIFF 내보내기와 WAV 외 파일 불러오기가 동작하지 않습니다. WAV는 그대로 씁니다.';
  }
  if (status.ffprobeAvailable === false) {
    return 'ffprobe를 찾지 못했습니다 — 일부 파일의 길이와 형식을 읽지 못할 수 있습니다.';
  }
  return null;
}

/**
 * Ask the main process, and hand back what to tell the user.
 *
 * A channel that throws is an older main process or a browser, and neither is
 * a reason to warn about an encoder.
 */
export async function readFfmpegWarning(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): Promise<string | null> {
  try {
    const raw = await invoke('system:ffmpeg-status');
    if (raw === null || typeof raw !== 'object') return null;
    return ffmpegWarning(raw as FfmpegStatus);
  } catch {
    return null;
  }
}
