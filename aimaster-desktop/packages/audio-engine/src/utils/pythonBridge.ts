import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import type { RPCRequest, RPCResponse, RPCProgress } from '../types/index.js';

/**
 * 기본 RPC 타임아웃.
 *
 * v3 master 체인은 EQ → comp → effects → loudnorm 2-pass → limiter →
 * post-verification → (필요 시) 자동 보정 패스 → 다시 측정 → preview MP3
 * 까지 7~9 단계의 ffmpeg 호출을 수행하므로, 긴 파일·느린 시스템에서는
 * 2 분으로는 부족하다.  10 분으로 두고 호출자가 method 별로 override 한다.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Method 별 권장 타임아웃 (ms).
 * call() 에서 override 하지 않으면 이 표를 참고.
 */
const METHOD_TIMEOUTS: Record<string, number> = {
  analyze:   180_000,   // 3 분 (긴 WAV 의 loudnorm pass1 + 스펙트럴)
  master:    900_000,   // 15 분 (전체 v3 체인)
  qc_check:  300_000,   // 5 분
};

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
  overrideTimeoutMs?: number | undefined;
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
      env: {
        ...process.env,
        PYTHONUNBUFFERED:  '1',
        PYTHONUTF8:        '1',      // Python 3.7+ UTF-8 mode (fixes Windows cp949 issue)
        PYTHONIOENCODING:  'utf-8',  // force stdin/stdout/stderr to UTF-8
      },
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
          this._sendCall(
            queued.method, queued.params,
            queued.resolve, queued.reject,
            queued.overrideTimeoutMs,
          );
        }
        this.readyQueue = [];
      }
      // stderr lines are for logging only
      this.emit('log', line.trim());
    });

    this.proc.on('error', (err) => {
      // spawn() itself failed (e.g. ENOENT — binary not found)
      this.emit('log', `spawn error: ${err.message}`);
      this._rejectAll(err);
      this._rejectQueue(err);
    });

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      const err = new Error(`Python process exited with code ${code}`);
      this._rejectAll(err);
      this._rejectQueue(err);
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

  call<T = unknown>(
    method: RPCRequest['method'],
    params: Record<string, unknown>,
    overrideTimeoutMs?: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) {
        return reject(new Error('Python bridge has not been spawned'));
      }
      if (!this.ready) {
        // Queue until READY received
        this.readyQueue.push({
          method, params, overrideTimeoutMs,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        return;
      }
      this._sendCall(method, params, resolve as (v: unknown) => void, reject, overrideTimeoutMs);
    });
  }

  private _sendCall(
    method: RPCRequest['method'],
    params: Record<string, unknown>,
    resolve: (v: unknown) => void,
    reject: (e: Error) => void,
    overrideTimeoutMs?: number,
  ): void {
    const id = uuidv4();
    const timeoutMs = overrideTimeoutMs
      ?? this.opts.timeoutMs
      ?? METHOD_TIMEOUTS[method]
      ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      // Python 은 여전히 같은 작업을 처리 중이므로, 다음 호출이 같은 프로세스 뒤에
      // 큐잉되지 않도록 bridge 자체를 종료한다.  audioHandlers 가 이를 감지하면
      // 다음 호출에서 새 프로세스를 spawn 한다.
      this.emit('log', `RPC timeout (${method} after ${timeoutMs}ms) — killing bridge`);
      try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
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

  private _rejectQueue(err: Error): void {
    for (const queued of this.readyQueue) {
      queued.reject(err);
    }
    this.readyQueue = [];
  }

  kill(): void {
    this.proc?.kill();
  }
}
