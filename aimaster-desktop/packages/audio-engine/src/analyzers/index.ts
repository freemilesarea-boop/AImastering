import type { PythonBridge } from '../utils/pythonBridge.js';
import type { AudioAnalysisResult } from '../types/index.js';

export async function analyzeFile(
  bridge: PythonBridge,
  filePath: string
): Promise<AudioAnalysisResult> {
  return bridge.call<AudioAnalysisResult>('analyze', { file_path: filePath });
}
