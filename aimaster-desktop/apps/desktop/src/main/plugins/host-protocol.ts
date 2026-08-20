// The contract between the app and the process that runs other people's code.
//
// Deliberately small and file-based: a job names an input file and an output
// file, and everything else is a few numbers.  Nothing large crosses the
// process boundary, and — more importantly — the job is a plain value, so the
// host can be run, tested and reasoned about without Electron, without a
// renderer, and without a plugin actually existing.
//
// Shared by both sides so there is one definition of what a job is.

export type ExternalFormat = 'vst3' | 'au' | 'vst2' | 'clap' | 'reference';

/** One device in a chain, as the host needs to see it. */
export interface HostStage {
  /** The scan id, for reporting which stage failed. */
  pluginId: string;
  format: ExternalFormat;
  /** Bundle path, for the adapter to open. */
  path: string;
  /** Class id / component identity inside the bundle. */
  uid: string;
  name: string;
  params: Record<string, number>;
  bypass: boolean;
}

export interface HostJob {
  id: string;
  /** Interleaved float32, `frames * channels` samples. */
  inputPath: string;
  outputPath: string;
  frames: number;
  channels: number;
  sampleRate: number;
  /** Applied in order, exactly as the insert slots are ordered. */
  chain: HostStage[];
}

export interface HostStageReport {
  pluginId: string;
  name: string;
  applied: boolean;
  /** Why it was not applied, when it was not. */
  reason?: string;
}

export type HostResult =
  | { ok: true; frames: number; stages: HostStageReport[] }
  | { ok: false; error: string; stages: HostStageReport[] };

/** How long one job may take before the host is assumed wedged. */
export const HOST_TIMEOUT_MS = 120_000;

/**
 * Which formats this build can actually process.
 *
 * `reference` is a device this app defines itself, used to prove the whole
 * pipeline — write, hand off, isolate, process, read back — without a native
 * adapter existing.  It is not a stand-in for a real plugin: a real format
 * with no adapter is REFUSED, loudly, rather than passed through with a
 * plausible-looking transform.  A plugin that silently does nothing is the one
 * outcome worse than a plugin that does not load.
 */
export const IMPLEMENTED_FORMATS: readonly ExternalFormat[] = ['reference'];

export function isImplemented(format: ExternalFormat): boolean {
  return IMPLEMENTED_FORMATS.includes(format);
}
