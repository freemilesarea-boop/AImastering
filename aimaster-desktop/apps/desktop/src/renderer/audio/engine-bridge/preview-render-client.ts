// Preview render client — transport + debounce / latest-wins controller.
//
// The controller decouples "user asked to update the preview" from "an
// actual render happened":
//   • Debounce — coalesce rapid requests into one render.
//   • Latest-wins — only the newest request's response is honoured;
//     stale responses (from a superseded request) are ignored.
//   • Injectable transport — production uses IPC; stories use a mock.
//
// No DSP here — the controller just orchestrates render requests.

import type {
  MasteringOptions,
  PreviewRenderRequest,
  PreviewRenderResponse,
} from '@aimaster/shared-types';

// ── Transport ────────────────────────────────────────────────────────────

/** Sends a render request and resolves with the response.  Injectable. */
export interface PreviewRenderTransport {
  readonly name: string;
  render(request: PreviewRenderRequest): Promise<PreviewRenderResponse>;
}

/** Production transport — invokes the `audio:re-render-preview` IPC channel. */
export class IpcPreviewRenderTransport implements PreviewRenderTransport {
  readonly name = 'ipc';
  async render(request: PreviewRenderRequest): Promise<PreviewRenderResponse> {
    const api = (globalThis as { electronAPI?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).electronAPI;
    if (!api) {
      return { requestId: request.requestId, ok: false, error: 'electronAPI unavailable' };
    }
    try {
      const res = await api.invoke('audio:re-render-preview', request);
      return res as PreviewRenderResponse;
    } catch (err) {
      return {
        requestId: request.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Controller state ─────────────────────────────────────────────────────

export type PreviewRenderState =
  | { phase: 'idle' }
  | { phase: 'pending' }                                     // debounce window open
  | { phase: 'rendering'; requestId: number }
  | { phase: 'updated'; previewPath: string; at: number; durationMs: number }
  | { phase: 'error'; error: string; at: number };

export interface PreviewRenderControllerOptions {
  /** Debounce window (ms) before a queued render fires.  Default 600. */
  debounceMs?: number;
  /** Called whenever the controller's state changes. */
  onState?: (state: PreviewRenderState) => void;
  /** Called on a non-stale successful render. */
  onSuccess?: (previewPath: string, durationMs: number) => void;
  /** Called on a non-stale failure. */
  onError?: (error: string) => void;
}

// ── Controller ───────────────────────────────────────────────────────────

export class PreviewRenderController {
  private readonly transport: PreviewRenderTransport;
  private readonly debounceMs: number;
  private readonly opts: PreviewRenderControllerOptions;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  /** The id of the most recent request the controller cares about. */
  private latestRequestId = 0;
  private queued: { sourceAudioPath: string; options: MasteringOptions; changedKeys: string[] } | null = null;

  constructor(transport: PreviewRenderTransport, opts: PreviewRenderControllerOptions = {}) {
    this.transport = transport;
    this.debounceMs = opts.debounceMs ?? 600;
    this.opts = opts;
  }

  get transportName(): string {
    return this.transport.name;
  }

  /**
   * Queue a render.  Repeated calls within the debounce window collapse
   * into one render using the LAST queued payload.
   */
  request(payload: { sourceAudioPath: string; options: MasteringOptions; changedKeys: string[] }): void {
    this.queued = payload;
    this.setState({ phase: 'pending' });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
  }

  /** Fire immediately (e.g. an explicit "Update Preview" button click). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.queued) this.fire();
  }

  /** Cancel any pending / in-flight render (responses become stale). */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.queued = null;
    // Bump latestRequestId so any in-flight response is treated as stale.
    this.latestRequestId = this.nextRequestId;
    this.setState({ phase: 'idle' });
  }

  private fire(): void {
    if (!this.queued) return;
    const payload = this.queued;
    this.queued = null;
    const requestId = this.nextRequestId++;
    this.latestRequestId = requestId;
    this.setState({ phase: 'rendering', requestId });

    const request: PreviewRenderRequest = {
      requestId,
      sourceAudioPath: payload.sourceAudioPath,
      options: payload.options,
      changedKeys: payload.changedKeys,
    };

    void this.transport.render(request).then((response) => {
      // Latest-wins: drop responses from superseded requests.
      if (response.requestId !== this.latestRequestId) return;
      if (response.ok) {
        this.setState({
          phase: 'updated',
          previewPath: response.previewPath,
          at: Date.now(),
          durationMs: response.durationMs,
        });
        this.opts.onSuccess?.(response.previewPath, response.durationMs);
      } else {
        this.setState({ phase: 'error', error: response.error, at: Date.now() });
        this.opts.onError?.(response.error);
      }
    });
  }

  private setState(state: PreviewRenderState): void {
    this.opts.onState?.(state);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queued = null;
  }
}
