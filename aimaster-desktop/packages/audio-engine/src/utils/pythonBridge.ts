import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import type { RPCRequest, RPCResponse, RPCProgress } from '../types/index.js';

const DEFAULT_TIMEOUT_MS = 120_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PythonBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private ready = false;

  constructor(private readonly opts: { pythonPath: string; scriptPath: string; timeoutMs?: number }) {
    super();
  }

  spawn(): void {
    this.proc = spawn(this.opts.pythonPath, [this.opts.scriptPath], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this._onData(chunk));

    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (line: string) => {
      if (line.includes('READY')) {
        this.ready = true;
        this.emit('ready');
      }
      // stderr lines are for logging only
      this.emit('log', line.trim());
    });

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this._rejectAll(new Error(`Python process exited with code ${code}`));
    });
  }

  private _onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as RPCResponse | RPCProgress;
        if ('type' in msg && msg.type === 'progress') {
          this.emit('progress', msg as RPCProgress);
        } else {
          const rpc = msg as RPCResponse;
          const pending = this.pending.get(rpc.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(rpc.id);
          if (rpc.error) {
            pending.reject(new Error(rpc.error.message));
          } else {
            pending.resolve(rpc.result);
          }
        }
      } catch {
        // non-JSON line — ignore
      }
    }
  }

  call<T = unknown>(method: RPCRequest['method'], params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.ready) {
        return reject(new Error('Python bridge is not ready'));
      }
      const id = uuidv4();
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout after ${timeoutMs}ms (method: ${method})`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      const req: RPCRequest = { id, method, params };
      this.proc.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  private _rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  kill(): void {
    this.proc?.kill();
  }
}
