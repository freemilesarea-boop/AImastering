import type { PythonBridge } from '../utils/pythonBridge.js';
import type { AudioAnalysisResult } from '../types/index.js';
import type { EngineEnvInfo } from '@aimaster/shared-types';

export async function analyzeFile(
  bridge: PythonBridge,
  filePath: string
): Promise<AudioAnalysisResult> {
  return bridge.call<AudioAnalysisResult>('analyze', { file_path: filePath });
}

/**
 * Ask the engine what it is — including whether it can read a waveform.
 *
 * `env_info` is one of the nine methods the engine answers and one of the six
 * nothing in the app called, which is why a half-built engine could report
 * READY and answer every request while every band read -120 dB.
 */
export async function engineEnvInfo(bridge: PythonBridge): Promise<EngineEnvInfo> {
  return bridge.call<EngineEnvInfo>('env_info', {});
}
