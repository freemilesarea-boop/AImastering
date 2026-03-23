import type { PythonBridge } from '../utils/pythonBridge.js';
import type { QCResult } from '../types/index.js';

export async function runQC(
  bridge: PythonBridge,
  filePath: string,
  targetLufs = -14,
  targetTp = -1.0
): Promise<QCResult> {
  return bridge.call<QCResult>('qc_check', {
    file_path: filePath,
    target_lufs: targetLufs,
    target_tp: targetTp,
  });
}
