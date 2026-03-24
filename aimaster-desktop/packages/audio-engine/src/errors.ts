/**
 * Centralized application error type.
 *
 * Each AppError carries:
 *   code        — machine-readable identifier for the error case
 *   userMessage — Korean string safe to display in the UI
 *   devDetail   — English developer log (full context, paths, stderr, etc.)
 *   recoverable — whether the user can retry without changing anything
 *
 * Error code catalogue:
 *   FFMPEG_NOT_FOUND        (case 1)
 *   FFPROBE_NOT_FOUND       (case 2)
 *   FILE_CORRUPTED          (case 3)
 *   FORMAT_UNSUPPORTED      (case 4)
 *   PATH_ENCODING_ERROR     (case 5)  — spaces / Korean in path caused failure
 *   OUTPUT_DIR_NOT_WRITABLE (case 6)
 *   LOUDNORM_PARSE_FAILED   (case 7)
 *   PYTHON_PROCESS_FAILED   (case 8)
 *   LICENSE_STORE_CORRUPTED (case 9)
 *   TRIAL_COUNT_ANOMALY     (case 10)
 *   UNKNOWN                 (fallback)
 */

export type AppErrorCode =
  | 'FFMPEG_NOT_FOUND'
  | 'FFPROBE_NOT_FOUND'
  | 'FILE_CORRUPTED'
  | 'FORMAT_UNSUPPORTED'
  | 'PATH_ENCODING_ERROR'
  | 'OUTPUT_DIR_NOT_WRITABLE'
  | 'LOUDNORM_PARSE_FAILED'
  | 'PYTHON_PROCESS_FAILED'
  | 'LICENSE_STORE_CORRUPTED'
  | 'TRIAL_COUNT_ANOMALY'
  | 'UNKNOWN';

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    /** Korean string displayed to the user. */
    public readonly userMessage: string,
    /** English detail for the developer log. */
    public readonly devDetail: string,
    /**
     * true  → the user can retry (e.g., transient process crash, timeout)
     * false → retrying will not help (e.g., missing binary, corrupt file)
     */
    public readonly recoverable: boolean,
  ) {
    super(userMessage);
    this.name = 'AppError';
  }

  /** Serialize for IPC transmission (plain object, no prototype). */
  toJSON() {
    return {
      code:        this.code,
      userMessage: this.userMessage,
      devDetail:   this.devDetail,
      recoverable: this.recoverable,
    };
  }
}

// ── Factory helpers ────────────────────────────────────────────────────────────

export function ffmpegNotFound(detail: string): AppError {
  return new AppError(
    'FFMPEG_NOT_FOUND',
    'FFmpeg를 찾을 수 없습니다. FFmpeg를 설치한 후 앱을 재시작해주세요.',
    detail,
    false,
  );
}

export function ffprobeNotFound(detail: string): AppError {
  return new AppError(
    'FFPROBE_NOT_FOUND',
    'FFprobe를 찾을 수 없습니다. FFmpeg를 설치한 후 앱을 재시작해주세요.',
    detail,
    false,
  );
}

export function fileCorrupted(filePath: string, detail: string): AppError {
  return new AppError(
    'FILE_CORRUPTED',
    '오디오 파일을 읽을 수 없습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.',
    `Corrupted or unreadable file: ${filePath} — ${detail}`,
    false,
  );
}

export function formatUnsupported(filePath: string, codec: string): AppError {
  return new AppError(
    'FORMAT_UNSUPPORTED',
    `지원하지 않는 오디오 포맷입니다 (${codec}). WAV, FLAC, AIFF, MP3, M4A 파일을 사용해주세요.`,
    `Unsupported audio codec "${codec}" in file: ${filePath}`,
    false,
  );
}

export function pathEncodingError(filePath: string, detail: string): AppError {
  return new AppError(
    'PATH_ENCODING_ERROR',
    '파일 경로에 처리할 수 없는 문자가 포함되어 있습니다. 경로에 특수 문자가 없는 위치로 파일을 이동해주세요.',
    `Path encoding / access failure: ${filePath} — ${detail}`,
    false,
  );
}

export function outputDirNotWritable(dirPath: string): AppError {
  return new AppError(
    'OUTPUT_DIR_NOT_WRITABLE',
    '임시 출력 폴더에 파일을 쓸 수 없습니다. 디스크 공간이나 권한을 확인해주세요.',
    `Output directory not writable: ${dirPath}`,
    false,
  );
}

export function loudnormParseFailed(detail: string): AppError {
  return new AppError(
    'LOUDNORM_PARSE_FAILED',
    'Loudness 분석 결과를 파싱할 수 없습니다. 파일이 너무 짧거나 무음일 수 있습니다.',
    `loudnorm JSON parse failure — ${detail}`,
    false,
  );
}

export function pythonProcessFailed(detail: string, recoverable = true): AppError {
  return new AppError(
    'PYTHON_PROCESS_FAILED',
    '오디오 처리 엔진이 응답하지 않습니다. 다시 시도해주세요.',
    `Python audio bridge error — ${detail}`,
    recoverable,
  );
}

export function licenseStoreCorrupted(detail: string): AppError {
  return new AppError(
    'LICENSE_STORE_CORRUPTED',
    '라이선스 데이터가 손상되었습니다. 앱을 재시작하거나 라이선스를 다시 활성화해주세요.',
    `License store corruption detected — ${detail}`,
    false,
  );
}

export function trialCountAnomaly(used: number, max: number): AppError {
  return new AppError(
    'TRIAL_COUNT_ANOMALY',
    '무료 체험 횟수 정보가 올바르지 않습니다. 라이선스를 다시 확인해주세요.',
    `Trial count anomaly: used=${used} > max=${max}`,
    false,
  );
}

export function unknownError(detail: string): AppError {
  return new AppError(
    'UNKNOWN',
    '알 수 없는 오류가 발생했습니다. 다시 시도해주세요.',
    detail,
    true,
  );
}

// ── Type guard ────────────────────────────────────────────────────────────────

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Deserialize an AppError-shaped plain object (received over IPC).
 * Returns the same object cast as AppError if it has the required fields,
 * or wraps it in an UNKNOWN AppError otherwise.
 */
export function fromIPC(obj: unknown): AppError {
  if (
    obj != null &&
    typeof obj === 'object' &&
    'code' in obj && 'userMessage' in obj && 'devDetail' in obj && 'recoverable' in obj
  ) {
    const o = obj as { code: AppErrorCode; userMessage: string; devDetail: string; recoverable: boolean };
    return new AppError(o.code, o.userMessage, o.devDetail, o.recoverable);
  }
  return unknownError(String(obj));
}
