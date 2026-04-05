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

/** Queued call waiting for the bridge to become ready. */
interface QueuedCall {
  method: RPCRequest['method'];
  params: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class PythonBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private ready = false;
  /** Calls that arrived before the bridge printed READY. */
  private readyQueue: QueuedCall[] = [];

  constructor(private readonly opts: { pythonPath: string; scriptPath: string; timeoutMs?: number }) {
    super();
  }

  spawn(): void {
    // When scriptPath is empty (e.g. PyInstaller standalone engine),
    // run the binary directly with no positional args.
    const args = this.opts.scriptPath ? [this.opts.scriptPath] : [];
    this.proc = spawn(this.opts.pythonPath, args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this._onData(chunk));

    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (line: string) => {
      if (line.includes('READY') && !this.ready) {
        this.ready = true;
        this.emit('ready');
        // Flush queued calls now that the bridge is ready
        for (const queued of this.readyQueue) {
          this._sendCall(queued.method, queued.params, queued.resolve, queued.reject);
        }
        this.readyQueue = [];
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
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) {
        return reject(new Error('Python bridge has not been spawned'));
      }
      if (!this.ready) {
        // Queue until READY received
        this.readyQueue.push({
          method, params,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        return;
      }
      this._sendCall(method, params, resolve as (v: unknown) => void, reject);
    });
  }

  private _sendCall(
    method: RPCRequest['method'],
    params: Record<string, unknown>,
    resolve: (v: unknown) => void,
    reject: (e: Error) => void,
  ): void {
    const id = uuidv4();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`RPC timeout after ${timeoutMs}ms (method: ${method})`));
    }, timeoutMs);

    this.pending.set(id, { resolve, reject, timer });

    const req: RPCRequest = { id, method, params };
    this.proc!.stdin!.write(JSON.stringify(req) + '\n');
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
