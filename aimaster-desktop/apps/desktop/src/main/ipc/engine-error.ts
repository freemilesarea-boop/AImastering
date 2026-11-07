// What the user is told when the Python engine refuses a job.
//
// Lifted out of `audioHandlers.toAppError` so the decision can be driven by a
// test: that file imports `electron`, so every branch in it was reachable only
// from a running main process, and two of them were wrong.
//
// Measured against the real packaged engine, with its bundled ffmpeg removed —
// the shape a part-installed app, or one whose binary a virus scanner took,
// actually has:
//
//   the engine said  'opt/.../ffprobe'을 찾을 수 없습니다. FFmpeg가 올바르게
//                    설치되어 있는지 확인해주세요.
//                    설치 방법: brew install ffmpeg (macOS) / apt install …
//   the user saw     알 수 없는 오류가 발생했습니다. 다시 시도해주세요.
//
// Two separate reasons for that:
//
//   · `PythonBridge` rejected with `new Error(rpc.error.message)` and dropped
//     `rpc.error.code`, so the branch that keys on a numeric JSON-RPC code
//     could never fire.  The engine sends -32000; nothing downstream saw it.
//   · Nothing read the engine's own sentence.  It is written in Korean, for
//     the user, by the code that knows what went wrong — and it was replaced
//     with a placeholder that says nothing.

import {
  AppError,
  ffmpegNotFound,
  pathEncodingError,
  pythonProcessFailed,
  unknownError,
  classifyFFmpegError,
} from '@aimaster/audio-engine';

/** A JSON-RPC rejection from the engine, as the bridge now hands it over. */
export interface RpcErrorLike extends Error {
  /** The JSON-RPC error code, e.g. -32000 for an engine-side failure. */
  rpcCode?: number;
}

/**
 * The engine says this when it cannot run ffmpeg or ffprobe.  Measured from
 * the shipped binary rather than copied from the source: the message is built
 * in `app/utils/ffmpeg_wrapper.py` and ends with install instructions.
 */
const ENGINE_FFMPEG_MISSING = /찾을 수 없습니다[\s\S]*FFmpeg|FFmpeg[\s\S]*찾을 수 없습니다/;

/** True when the engine's message is already a sentence for the user. */
function isKorean(message: string): boolean {
  return /[가-힣]/.test(message);
}

/**
 * Turn anything thrown by an engine call into an AppError.
 *
 * `filePath` is used only for the messages that name a file.
 */
export function appErrorFor(err: unknown, filePath = ''): AppError {
  if (err instanceof AppError) return err;

  const msg = (err as Error | undefined)?.message ?? String(err);
  const rpcCode = (err as RpcErrorLike | undefined)?.rpcCode;

  // The engine could not start at all (spawn ENOENT) — not an answer from it.
  if (/ENOENT|spawn/i.test(msg) && rpcCode === undefined) {
    return pythonProcessFailed(`Engine binary not found or failed to start: ${msg}`, false);
  }

  // An answer FROM the engine.  Its message is Korean, written for the user,
  // and it is the most specific thing anyone has.
  if (rpcCode !== undefined) {
    if (ENGINE_FFMPEG_MISSING.test(msg)) {
      // The one engine failure with a dedicated code and a UI hint of its own
      // (`MasteringPage.errorHint` points at the download page for it).
      return ffmpegNotFound(`engine reported a missing binary (rpc ${rpcCode}): ${msg}`);
    }
    if (isKorean(msg)) {
      // Keep the engine's own words; -32000 is the engine's "I could not do
      // this", which is worth retrying only when it says so.
      return new AppError(
        'PYTHON_PROCESS_FAILED',
        msg.split('\n')[0] ?? msg,
        `engine rpc ${rpcCode}: ${msg}`,
        rpcCode === -32000,
      );
    }
    return pythonProcessFailed(`engine rpc ${rpcCode}: ${msg}`, rpcCode === -32000);
  }

  if (/EINVAL|ENAMETOOLONG/i.test(msg) && filePath) {
    return pathEncodingError(filePath, msg);
  }

  // ffmpeg's own failures, by stderr — see audio-engine's classifier.
  const classified = classifyFFmpegError(err, false, filePath);
  return classified.code === 'UNKNOWN' ? unknownError(msg) : classified;
}
