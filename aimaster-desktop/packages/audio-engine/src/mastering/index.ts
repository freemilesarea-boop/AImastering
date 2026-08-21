import type { PythonBridge } from '../utils/pythonBridge.js';
import type {
  LoudnessStats,
  MasteringOptions,
  MasteringResult,
} from '../types/index.js';

export interface MasterFileExtras {
  /** Analyze 단계의 loudness 결과 — Python 이 별도 pass1 을 안 돌게 해 줌 */
  preLoudness?: LoudnessStats | undefined;
  /** RPC 타임아웃 override (ms).  미지정 시 bridge 의 method 별 기본값 사용. */
  timeoutMs?: number | undefined;
}

export async function masterFile(
  bridge: PythonBridge,
  inputPath: string,
  outputPath: string,
  options: MasteringOptions,
  extras: MasterFileExtras = {},
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
  if (options.dynamicEqIntensity != null) params['dynamic_eq_intensity'] = options.dynamicEqIntensity;
  // RC — 미지정 시 Python 이 'stable' 로 처리하므로 기존 동작은 그대로.
  if (options.engineMode)               params['engine_mode']       = options.engineMode;

  if (extras.preLoudness) {
    params['pre_loudness'] = {
      integratedLufs: extras.preLoudness.integratedLufs,
      truePeakDbtp:   extras.preLoudness.truePeakDbtp,
      lra:            extras.preLoudness.lra,
    };
  }

  return bridge.call<MasteringResult>('master', params, extras.timeoutMs);
}
