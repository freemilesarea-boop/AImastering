export type {
  AudioFileInfo,
  AudioAnalysisResult,
  MasteringOptions,
  MasteringResult,
  QCResult,
  RPCRequest,
  RPCResponse,
  RPCProgress,
  MasteringStyle,
} from '@aimaster/shared-types';

export interface FFmpegStatus {
  available: boolean;
  version?: string;
  path?: string;
  ffprobeAvailable: boolean;
}

export interface PythonBridgeOptions {
  pythonPath: string;
  scriptPath: string;
  timeoutMs?: number;
}
