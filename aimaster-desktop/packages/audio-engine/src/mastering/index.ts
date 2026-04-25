import type { PythonBridge } from '../utils/pythonBridge.js';
import type { MasteringOptions, MasteringResult } from '../types/index.js';

export async function masterFile(
  bridge: PythonBridge,
  inputPath: string,
  outputPath: string,
  options: MasteringOptions
): Promise<MasteringResult> {
  const params: Record<string, unknown> = {
    input_path:           inputPath,
    output_path:          outputPath,
    style:                options.style,
    target_lufs:          options.targetLufs,
    target_tp:            options.targetTp,
    sample_rate:          options.sampleRate,
    bit_depth:            options.bitDepth,
    apply_ai_corrections: options.applyAiCorrections,
  };

  // v3 신규 옵션 — undefined 는 Python 측에서 모드 기본값으로 처리
  if (options.limiterStrength)         params['limiter_strength']  = options.limiterStrength;
  if (options.saturationAmount != null) params['saturation_amount'] = options.saturationAmount;
  if (options.stereoWidth != null)      params['stereo_width']      = options.stereoWidth;
  if (options.outputGainDb != null)     params['output_gain_db']    = options.outputGainDb;

  return bridge.call<MasteringResult>('master', params);
}
