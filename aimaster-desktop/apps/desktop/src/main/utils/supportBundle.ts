/**
 * supportBundle.ts — build a compact, user-shareable diagnostic snapshot.
 *
 * Used by:
 *   • IPC channel `support:bundle`        — returns the JSON payload
 *   • IPC channel `support:bundle-export` — writes the payload to a path
 *     the user picks via Save dialog
 *
 * Privacy contract:
 *   • The bundle includes app version, OS / Electron / Chrome / Node
 *     version strings, the runtime failure ring buffer, and the most
 *     recent pipeline warnings — but NEVER:
 *       – absolute filesystem paths (filenames are kept; directory tree
 *         above the user is replaced with `~` via failureLog.redactPath)
 *       – license keys / HMAC secrets
 *       – the PYTHONPATH / output / temp directories of the host
 *   • The payload is synchronous + bounded (≤ 64 KB typical) so the
 *     renderer's "Copy to clipboard" and "Save .json" actions never
 *     stall on a slow disk.
 *
 * Schema is tagged `support-bundle/1` so support tooling can parse old
 * bundles after future field additions.
 */

import { app } from 'electron';
import os from 'node:os';
import process from 'node:process';
import {
  failureCounts,
  snapshotFailures,
  type FailureEntry,
} from './failureLog.js';

export const SUPPORT_BUNDLE_SCHEMA = 'support-bundle/1' as const;

export interface SupportBundle {
  schemaVersion: typeof SUPPORT_BUNDLE_SCHEMA;
  generatedAt:   string;
  app: {
    name:    string;
    version: string;
    isPackaged: boolean;
  };
  runtime: {
    platform:        NodeJS.Platform;
    arch:            string;
    osRelease:       string;
    electronVersion: string;
    chromeVersion:   string;
    nodeVersion:     string;
    cpuModel:        string;
    cpuCount:        number;
    totalMemMB:      number;
    locale:          string;
  };
  failureCounts:   Record<string, number>;
  recentFailures:  FailureEntry[];
  /** Last N pipeline warnings the renderer pushed to us (FIFO). */
  recentPipelineWarnings: Array<{ code: string; level: string; userMessage: string; at: string }>;
}

// ── Pipeline warning ring ───────────────────────────────────────────────────
// Renderer reports warnings via the IPC channel; we store the most-recent
// MAX_PIPELINE_WARNINGS and include them in the bundle.

const MAX_PIPELINE_WARNINGS = 30;
const pipelineWarnings: Array<{ code: string; level: string; userMessage: string; at: string }> = [];

export function recordPipelineWarning(w: { code?: unknown; level?: unknown; userMessage?: unknown }): void {
  pipelineWarnings.push({
    code:        typeof w?.code        === 'string' ? w.code        : 'unknown',
    level:       typeof w?.level       === 'string' ? w.level       : 'info',
    userMessage: typeof w?.userMessage === 'string' ? w.userMessage : '',
    at:          new Date().toISOString(),
  });
  if (pipelineWarnings.length > MAX_PIPELINE_WARNINGS) {
    pipelineWarnings.splice(0, pipelineWarnings.length - MAX_PIPELINE_WARNINGS);
  }
}

export function resetPipelineWarningsForTests(): void {
  pipelineWarnings.length = 0;
}

// ── Builder ────────────────────────────────────────────────────────────────

function safeAppName(): string {
  try { return app.getName(); } catch { return 'aimaster-desktop'; }
}
function safeAppVersion(): string {
  try { return app.getVersion(); } catch { return '0.0.0'; }
}
function safeIsPackaged(): boolean {
  try { return app.isPackaged === true; } catch { return false; }
}
function safeLocale(): string {
  try { return app.getLocale?.() ?? 'unknown'; } catch { return 'unknown'; }
}

export function buildSupportBundle(): SupportBundle {
  const cpus = os.cpus();
  return {
    schemaVersion: SUPPORT_BUNDLE_SCHEMA,
    generatedAt:   new Date().toISOString(),
    app: {
      name:       safeAppName(),
      version:    safeAppVersion(),
      isPackaged: safeIsPackaged(),
    },
    runtime: {
      platform:        process.platform,
      arch:            process.arch,
      osRelease:       os.release(),
      electronVersion: process.versions.electron ?? '',
      chromeVersion:   process.versions.chrome   ?? '',
      nodeVersion:     process.versions.node     ?? '',
      cpuModel:        cpus[0]?.model ?? 'unknown',
      cpuCount:        cpus.length,
      totalMemMB:      Math.round(os.totalmem() / (1024 * 1024)),
      locale:          safeLocale(),
    },
    failureCounts:  failureCounts(),
    recentFailures: snapshotFailures(),
    recentPipelineWarnings: pipelineWarnings.slice(),
  };
}

/** Serialise to JSON suitable for clipboard / file write. */
export function supportBundleToJson(b: SupportBundle): string {
  return JSON.stringify(b, null, 2);
}
