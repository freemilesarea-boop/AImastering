// Session schema — the persisted state of a single Loui mastering session.
//
// A ".louisession" file is a JSON file conforming to `LouiSession`.  It
// captures everything the user has tuned in the product page so they can
// resume later or share a setup with a collaborator.
//
// What IS saved:
//   • Source file path (absolute — not the audio data)
//   • Reference file path (if loaded)
//   • All module parameter state (EQ, Dynamics, Imager, Limiter, Export)
//   • Active preset id
//   • Base mastering options (target LUFS, TP, SR, bitDepth, style)
//
// What is NOT saved:
//   • Rendered revision files (these are temp paths that become stale)
//   • The revision group (can't restore audio data from a path reference)
//   • Undo history (re-loads as a clean slate)

import type { AllModulesParameterState } from '../parameters/parameter-state.js';
import type { MasteringOptions } from '../../stores/audioStore.js';

export const SESSION_VERSION = 1 as const;

export interface LouiSession {
  version: typeof SESSION_VERSION;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Absolute path to the source audio file (may not exist on another machine). */
  sourceFilePath: string | null;
  /** Absolute path to the reference audio file (may not exist on another machine). */
  referenceFilePath: string | null;
  /** Full parameter state for all modules. */
  allModulesState: AllModulesParameterState;
  /** Active Loui preset id (if any). */
  presetId: string | undefined;
  /** Base mastering options (target LUFS / TP / SR / bitDepth / style). */
  baseOptions: MasteringOptions;
}

// ── Serialize ──────────────────────────────────────────────────────────────

export function serializeSession(session: LouiSession): string {
  return JSON.stringify(session, null, 2);
}

// ── Deserialize + validate ─────────────────────────────────────────────────

export interface SessionLoadResult {
  ok: true;
  session: LouiSession;
  /** Non-fatal warnings (e.g. unknown extra fields ignored). */
  warnings: string[];
}

export interface SessionLoadError {
  ok: false;
  error: string;
}

export function deserializeSession(raw: string): SessionLoadResult | SessionLoadError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '유효하지 않은 JSON 파일입니다.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '세션 파일 형식이 올바르지 않습니다.' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== SESSION_VERSION) {
    return { ok: false, error: `지원하지 않는 세션 버전 (${String(obj['version'])}). 현재 버전: ${SESSION_VERSION}` };
  }
  const warnings: string[] = [];
  // allModulesState must be an object.
  if (!obj['allModulesState'] || typeof obj['allModulesState'] !== 'object') {
    return { ok: false, error: '세션 파일에 파라미터 상태가 없습니다.' };
  }
  // baseOptions must be an object.
  if (!obj['baseOptions'] || typeof obj['baseOptions'] !== 'object') {
    return { ok: false, error: '세션 파일에 마스터링 옵션이 없습니다.' };
  }
  const session: LouiSession = {
    version: SESSION_VERSION,
    createdAt:         typeof obj['createdAt']         === 'string' ? obj['createdAt']         : new Date().toISOString(),
    sourceFilePath:    typeof obj['sourceFilePath']    === 'string' ? obj['sourceFilePath']    : null,
    referenceFilePath: typeof obj['referenceFilePath'] === 'string' ? obj['referenceFilePath'] : null,
    allModulesState:   obj['allModulesState'] as AllModulesParameterState,
    presetId:          typeof obj['presetId']          === 'string' ? obj['presetId']          : undefined,
    baseOptions:       obj['baseOptions'] as MasteringOptions,
  };
  return { ok: true, session, warnings };
}
