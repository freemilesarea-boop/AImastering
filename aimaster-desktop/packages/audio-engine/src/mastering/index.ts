import type { PythonBridge } from '../utils/pythonBridge.js';
import type { MasteringOptions, MasteringResult } from '../types/index.js';

export async function masterFile(
  bridge: PythonBridge,
  inputPath: string,
  outputPath: string,
  options: MasteringOptions
): Promise<MasteringResult> {
  return bridge.call<MasteringResult>('master', {
    input_path: inputPath,
    output_path: outputPath,
    style: options.style,
    target_lufs: options.targetLufs,
    target_tp: options.targetTp,
    sample_rate: options.sampleRate,
    bit_depth: options.bitDepth,
    apply_ai_corrections: options.applyAiCorrections,
  });
}
