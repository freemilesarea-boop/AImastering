import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

function logDir(): string {
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch {
    return '/tmp/aimaster-logs';
  }
}

function logFile(): string {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${date}.log`);
}

function write(level: string, msg: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    // non-critical
  }
}

export const log = {
  info:  (msg: string, extra?: unknown) => write('INFO',  msg, extra),
  warn:  (msg: string, extra?: unknown) => write('WARN',  msg, extra),
  error: (msg: string, extra?: unknown) => write('ERROR', msg, extra),
};
