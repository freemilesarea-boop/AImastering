// MockPreviewRenderTransport — for Storybook + tests.
//
// Simulates the main-process render with a configurable delay and
// success / failure outcome.  Records request history so stories can
// assert latest-wins / stale-rejection behaviour.

import type {
  PreviewRenderRequest,
  PreviewRenderResponse,
} from '@aimaster/shared-types';
import type { PreviewRenderTransport } from './preview-render-client.js';

export interface MockTransportOptions {
  /** Simulated render latency (ms).  Default 800. */
  delayMs?: number;
  /** Force every render to fail with this error. */
  failWith?: string;
  /** Fixed preview path returned on success.  Default a fake mp3 path. */
  previewPath?: string;
}

export class MockPreviewRenderTransport implements PreviewRenderTransport {
  readonly name = 'mock';
  private readonly opts: MockTransportOptions;
  private readonly history: PreviewRenderRequest[] = [];

  constructor(opts: MockTransportOptions = {}) {
    this.opts = opts;
  }

  render(request: PreviewRenderRequest): Promise<PreviewRenderResponse> {
    this.history.push(request);
    const delay = this.opts.delayMs ?? 800;
    return new Promise((resolve) => {
      setTimeout(() => {
        if (this.opts.failWith) {
          resolve({ requestId: request.requestId, ok: false, error: this.opts.failWith });
        } else {
          resolve({
            requestId: request.requestId,
            ok: true,
            previewPath: this.opts.previewPath ?? `/tmp/mock_preview_${request.requestId}.mp3`,
            metrics: {
              integratedLufs: typeof request.options.targetLufs === 'number' ? request.options.targetLufs : -14,
              truePeakDbtp: typeof request.options.targetTp === 'number' ? request.options.targetTp : -1,
            },
            durationMs: delay,
          });
        }
      }, delay);
    });
  }

  getHistory(): readonly PreviewRenderRequest[] {
    return this.history;
  }
}
