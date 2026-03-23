/**
 * Python 프로세스 브릿지
 * Node.js ↔ Python 간 stdin/stdout JSON-RPC 통신
 *
 * 프로토콜:
 *   요청: {"id": "uuid", "method": "analyze", "params": {...}}
 *   응답: {"id": "uuid", "result": {...}} 또는 {"id": "uuid", "error": "msg"}
 *   진행률: {"type": "progress", "jobId": "uuid", "percent": 50, "stage": "..."}
 */
import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { getPythonPath, getPythonScriptPath } from './pathUtils'
import { logger } from './logger'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout
}

interface JsonRpcResponse {
  id: string
  result?: unknown
  error?: string
}

interface ProgressMessage {
  type: 'progress'
  jobId: string
  percent: number
  stage: string
}

type IncomingMessage = JsonRpcResponse | ProgressMessage

export class PythonBridge extends EventEmitter {
  private process: ChildProcess | null = null
  private pending: Map<string, PendingRequest> = new Map()
  private buffer = ''
  private isReady = false
  private requestTimeout = 120_000 // 2분

  /**
   * Python 프로세스 시작
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const pythonPath = getPythonPath()
      const scriptPath = getPythonScriptPath()

      logger.info(`Python bridge starting: ${pythonPath} ${scriptPath}`)

      this.process = spawn(pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })

      // 시작 타임아웃
      const startTimeout = setTimeout(() => {
        reject(new Error('Python process start timeout'))
      }, 10_000)

      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString()
        this.processBuffer()
      })

      this.process.stderr?.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim()
        if (msg.includes('READY')) {
          clearTimeout(startTimeout)
          this.isReady = true
          logger.info('Python bridge ready')
          resolve()
        } else {
          logger.warn('Python stderr:', msg)
        }
      })

      this.process.on('error', (err) => {
        logger.error('Python process error:', err.message)
        clearTimeout(startTimeout)
        reject(err)
        this.rejectAllPending(err)
      })

      this.process.on('exit', (code, signal) => {
        logger.warn(`Python process exited: code=${code} signal=${signal}`)
        this.isReady = false
        this.rejectAllPending(new Error(`Python exited with code ${code}`))
      })
    })
  }

  /**
   * stdout 버퍼에서 완전한 JSON 라인 추출 및 처리
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? '' // 마지막 미완성 라인은 버퍼에 보관

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg: IncomingMessage = JSON.parse(trimmed)
        this.handleMessage(msg)
      } catch {
        logger.warn('Invalid JSON from Python:', trimmed.slice(0, 100))
      }
    }
  }

  /**
   * Python에서 받은 메시지 라우팅
   */
  private handleMessage(msg: IncomingMessage): void {
    if ('type' in msg && msg.type === 'progress') {
      // 진행률 이벤트: 외부로 emit
      this.emit('progress', msg)
      return
    }

    const response = msg as JsonRpcResponse
    const pending = this.pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(response.id)

    if (response.error) {
      pending.reject(new Error(response.error))
    } else {
      pending.resolve(response.result)
    }
  }

  /**
   * Python에 메서드 호출 요청
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isReady || !this.process) {
      throw new Error('Python bridge not ready')
    }

    const id = uuidv4()
    const request = { id, method, params }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Python call timeout: ${method}`))
      }, this.requestTimeout)

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeout,
      })

      const line = JSON.stringify(request) + '\n'
      this.process!.stdin?.write(line, (err) => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timeout)
          reject(new Error(`Failed to write to Python: ${err.message}`))
        }
      })
    })
  }

  /**
   * 대기 중인 모든 요청 거절 (프로세스 종료 시)
   */
  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(err)
      this.pending.delete(id)
    }
  }

  /**
   * Python 프로세스 종료
   */
  async stop(): Promise<void> {
    if (!this.process) return
    this.rejectAllPending(new Error('Bridge stopped'))
    this.process.kill('SIGTERM')
    this.process = null
    this.isReady = false
    logger.info('Python bridge stopped')
  }

  get ready(): boolean { return this.isReady }
}

// 싱글톤 인스턴스
export const pythonBridge = new PythonBridge()
