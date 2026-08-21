// Where a control surface mapping lives.
//
// A mapping belongs to the DESK, not to the song: the same fader is track 1's
// volume whichever session is open, and re-learning twenty controls per
// project is the reason people give up on control surfaces.  So this is kept
// beside the app's other machine-level settings rather than inside the
// session — and, like the user presets, it can leave the machine as a file,
// because localStorage does not survive a reinstall.
//
// Same shape as `user-presets.ts` on purpose: one injectable store, a version
// stamp, defensive reads, and a write that reports failure instead of
// pretending.

import type { ControlBinding } from '../model/control-surface.js';
import { conflictsIn, sourceKey } from '../model/control-surface.js';

const STORAGE_KEY = 'loui.daw.control-surface';
const SCHEMA_VERSION = 1;
const MAX_BINDINGS = 512;

export interface SurfaceStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

let override: SurfaceStore | null = null;

/** Point the store somewhere else.  Pass null to go back to `localStorage`. */
export function setSurfaceStore(store: SurfaceStore | null): void { override = store; }

function store(): SurfaceStore | null {
  if (override) return override;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

interface Envelope {
  version: number;
  /** Which MIDI input the surface is on, or null for every input. */
  deviceId: string | null;
  /** Off by default: a surface nobody set up must not move anything. */
  enabled: boolean;
  bindings: ControlBinding[];
}

const EMPTY: Envelope = {
  version: SCHEMA_VERSION, deviceId: null, enabled: false, bindings: [],
};

function isBinding(value: unknown): value is ControlBinding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<ControlBinding>;
  return typeof b.id === 'string'
    && !!b.source && typeof b.source === 'object'
    && !!b.action && typeof b.action === 'object'
    && typeof b.mode === 'string';
}

/** Fill in anything a older or hand-edited entry is missing. */
function normalise(binding: ControlBinding): ControlBinding {
  return {
    ...binding,
    invert: binding.invert === true,
    takeover: binding.takeover === 'jump' ? 'jump' : 'pickup',
    relative: binding.relative === 'twosComplement' ? 'twosComplement' : 'signedBit',
    relativeStep: Number.isFinite(binding.relativeStep) && binding.relativeStep > 0
      ? binding.relativeStep : 0.01,
    label: typeof binding.label === 'string' ? binding.label : '',
  };
}

export function readSurface(): Envelope {
  const s = store();
  if (!s) return { ...EMPTY };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.bindings)) {
      return { ...EMPTY };
    }
    return {
      version: SCHEMA_VERSION,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : null,
      enabled: parsed.enabled === true,
      bindings: parsed.bindings.filter(isBinding).map(normalise),
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(envelope: Envelope): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ ...envelope, version: SCHEMA_VERSION }));
    return true;
  } catch {
    return false;
  }
}

export function listBindings(): ControlBinding[] { return readSurface().bindings; }
export function surfaceEnabled(): boolean { return readSurface().enabled; }
export function surfaceDeviceId(): string | null { return readSurface().deviceId; }

export function setSurfaceEnabled(enabled: boolean): boolean {
  return write({ ...readSurface(), enabled });
}

export function setSurfaceDeviceId(deviceId: string | null): boolean {
  return write({ ...readSurface(), deviceId });
}

export type SurfaceWrite = { ok: true } | { ok: false; reason: string };

/**
 * Add a binding, replacing whatever was on the same physical control.
 *
 * Learning a control that is already mapped means "map it to this instead" —
 * that is what pressing learn and then wiggling a knob you already used
 * obviously means.  Ending up with two bindings on it would make one of them
 * look broken.
 */
export function putBinding(binding: ControlBinding): SurfaceWrite {
  const envelope = readSurface();
  const key = sourceKey(binding.source);
  const kept = envelope.bindings.filter(
    (b) => b.id !== binding.id && sourceKey(b.source) !== key);
  if (kept.length >= MAX_BINDINGS) {
    return { ok: false, reason: `매핑은 ${MAX_BINDINGS}개까지입니다` };
  }
  return write({ ...envelope, bindings: [...kept, normalise(binding)] })
    ? { ok: true } : { ok: false, reason: '매핑을 저장할 수 없습니다' };
}

/** Change one binding in place, without touching what it is bound to. */
export function updateBinding(
  id: string, patch: Partial<ControlBinding>,
): SurfaceWrite {
  const envelope = readSurface();
  const index = envelope.bindings.findIndex((b) => b.id === id);
  const existing = envelope.bindings[index];
  if (index < 0 || !existing) return { ok: false, reason: '매핑을 찾을 수 없습니다' };
  const next = [...envelope.bindings];
  next[index] = normalise({ ...existing, ...patch });
  return write({ ...envelope, bindings: next })
    ? { ok: true } : { ok: false, reason: '매핑을 저장할 수 없습니다' };
}

export function removeBinding(id: string): boolean {
  const envelope = readSurface();
  const bindings = envelope.bindings.filter((b) => b.id !== id);
  if (bindings.length === envelope.bindings.length) return false;
  return write({ ...envelope, bindings });
}

export function clearBindings(): void {
  write({ ...readSurface(), bindings: [] });
}

// ── Files ─────────────────────────────────────────────────────────────────────

export const EXPORT_KIND = 'loui.daw.control-surface';

export function exportSurface(): string {
  const envelope = readSurface();
  return JSON.stringify({
    kind: EXPORT_KIND,
    version: SCHEMA_VERSION,
    deviceId: envelope.deviceId,
    bindings: envelope.bindings,
  }, null, 2);
}

export interface ImportReport {
  added: number;
  replaced: number;
  skipped: number;
  reasons: string[];
}

/**
 * Read a mapping file back in.
 *
 * Unlike a preset, a binding that collides is REPLACED rather than renamed:
 * two things on one fader is never what was wanted, and the file being
 * imported is the more recent statement of intent.  How many were replaced is
 * reported, so nobody loses a mapping without being told.
 */
export function importSurface(json: string): ImportReport {
  const report: ImportReport = { added: 0, replaced: 0, skipped: 0, reasons: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    report.skipped += 1;
    report.reasons.push('파일이 올바른 JSON 이 아닙니다');
    return report;
  }
  const file = parsed as { kind?: string; bindings?: unknown } | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.bindings)) {
    report.skipped += 1;
    report.reasons.push('컨트롤 서피스 파일이 아닙니다');
    return report;
  }
  if (file.kind !== EXPORT_KIND) {
    report.skipped += 1;
    report.reasons.push('다른 프로그램의 파일입니다');
    return report;
  }

  const envelope = readSurface();
  const bindings = [...envelope.bindings];
  for (const raw of file.bindings) {
    if (!isBinding(raw)) {
      report.skipped += 1;
      report.reasons.push('형식이 맞지 않는 항목 하나를 건너뛰었습니다');
      continue;
    }
    if (bindings.length >= MAX_BINDINGS) {
      report.skipped += 1;
      report.reasons.push(`매핑 한도(${MAX_BINDINGS}개)를 넘었습니다`);
      continue;
    }
    const key = sourceKey(raw.source);
    const at = bindings.findIndex((b) => sourceKey(b.source) === key);
    if (at >= 0) { bindings[at] = normalise(raw); report.replaced += 1; }
    else { bindings.push(normalise(raw)); report.added += 1; }
  }

  if ((report.added > 0 || report.replaced > 0) && !write({ ...envelope, bindings })) {
    return { added: 0, replaced: 0, skipped: report.added + report.replaced + report.skipped,
      reasons: ['매핑을 저장할 수 없습니다'] };
  }
  return report;
}

/** `4개 추가 · 1개 교체` — what an import did. */
export function describeImport(report: ImportReport): string {
  const parts = [`${report.added}개 추가`];
  if (report.replaced > 0) parts.push(`${report.replaced}개 교체`);
  if (report.skipped > 0) parts.push(`${report.skipped}개 건너뜀`);
  return parts.join(' · ');
}

/** Controls with more than one binding — a mistake worth surfacing. */
export function storedConflicts(): ReturnType<typeof conflictsIn> {
  return conflictsIn(listBindings());
}
