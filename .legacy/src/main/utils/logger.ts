/**
 * 앱 전역 로거
 * 개발 환경: 콘솔 + 파일, 프로덕션: 파일만
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

class Logger {
  private logFile: string
  private isDev: boolean

  constructor() {
    this.isDev = process.env.NODE_ENV === 'development'
    const logDir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    this.logFile = path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`)
  }

  private write(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString()
    const argsStr = args.length > 0 ? ' ' + JSON.stringify(args) : ''
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${argsStr}\n`

    // 콘솔 출력 (개발 환경)
    if (this.isDev) {
      const colorMap: Record<LogLevel, string> = {
        debug: '\x1b[37m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m'
      }
      console.log(`${colorMap[level]}${line}\x1b[0m`)
    }

    // 파일 출력
    try {
      fs.appendFileSync(this.logFile, line)
    } catch {
      // 로그 파일 쓰기 실패는 무시 (앱 크래시 방지)
    }
  }

  debug(msg: string, ...args: unknown[]) { this.write('debug', msg, ...args) }
  info(msg:  string, ...args: unknown[]) { this.write('info',  msg, ...args) }
  warn(msg:  string, ...args: unknown[]) { this.write('warn',  msg, ...args) }
  error(msg: string, ...args: unknown[]) { this.write('error', msg, ...args) }
}

// 싱글톤 인스턴스
export const logger = new Logger()
