// Where saved racks live.
//
// The same shape as `user-presets.ts`, deliberately: one injectable store, a
// version stamp, defensive reads, a write that reports failure, and a file the
// rack can leave the machine in.  A vocal chain someone spent a session
// arriving at is worth exactly as much as the compressor setting inside it,
// and localStorage does not survive a reinstall.

import { findPlugin } from './plugins.js';
import { sanitiseName, sanitiseNote, type RackPreset } from '../model/rack-preset.js';

const STORAGE_KEY = 'loui.daw.racks.user';
const SCHEMA_VERSION = 1;
const MAX_RACKS = 200;

export interface RackStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

let override: RackStore | null = null;

/** Point the store somewhere else.  Pass null to go back to `localStorage`. */
export function setRackStore(store: RackStore | null): void { override = store; }

function store(): RackStore | null {
  if (override) return override;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

interface Envelope { version: number; racks: RackPreset[] }

function isRack(value: unknown): value is RackPreset {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<RackPreset>;
  return typeof r.id === 'string' && typeof r.name === 'string'
    && Array.isArray(r.devices)
    && typeof r.createdAt === 'number' && typeof r.updatedAt === 'number';
}

/**
 * Fill in and clean up one stored rack.
 *
 * Devices are filtered here rather than at load time so a rack whose file has
 * been hand-edited into nonsense simply reads as the devices that survive,
 * instead of throwing somewhere deep in the loader.
 */
function normalise(rack: RackPreset): RackPreset {
  return {
    ...rack,
    name: sanitiseName(rack.name),
    note: sanitiseNote(typeof rack.note === 'string' ? rack.note : ''),
    devices: rack.devices
      .filter((d) => !!d && typeof d === 'object'
        && typeof d.pluginId === 'string' && Number.isInteger(d.slot))
      .map((d) => ({
        slot: d.slot,
        pluginId: d.pluginId,
        label: typeof d.label === 'string' ? d.label : '',
        bypass: d.bypass === true,
        params: d.params && typeof d.params === 'object' && !Array.isArray(d.params)
          ? d.params : {},
      })),
  };
}

function readEnvelope(): Envelope {
  const s = store();
  if (!s) return { version: SCHEMA_VERSION, racks: [] };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { version: SCHEMA_VERSION, racks: [] };
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.racks)) {
      return { version: SCHEMA_VERSION, racks: [] };
    }
    return { version: SCHEMA_VERSION, racks: parsed.racks.filter(isRack).map(normalise) };
  } catch {
    return { version: SCHEMA_VERSION, racks: [] };
  }
}

function write(envelope: Envelope): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, racks: envelope.racks }));
    return true;
  } catch {
    return false;
  }
}

let counter = 0;
export function resetRackIds(): void { counter = 0; }
function newId(): string {
  counter += 1;
  return `rack-${Date.now().toString(36)}-${counter.toString(36)}`;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** Every saved rack, most recently touched first. */
export function listRacks(): RackPreset[] {
  return readEnvelope().racks.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findRack(id: string): RackPreset | undefined {
  return readEnvelope().racks.find((r) => r.id === id);
}

// ── Writing ───────────────────────────────────────────────────────────────────

export type RackWrite = { ok: true; rack: RackPreset } | { ok: false; reason: string };

/**
 * Save a chain under a name.
 *
 * An empty chain is refused: a rack with nothing in it loads as "delete every
 * insert", which is a thing somebody might want but not a thing they meant by
 * pressing save on an empty channel.
 */
export function saveRack(name: string, rack: Omit<RackPreset, 'id' | 'name'>): RackWrite {
  const clean = sanitiseName(name);
  if (!clean) return { ok: false, reason: '이름을 입력하세요' };
  if (rack.devices.length === 0) return { ok: false, reason: '빈 랙은 저장할 수 없습니다' };

  const envelope = readEnvelope();
  if (envelope.racks.some((r) => r.name === clean)) {
    return { ok: false, reason: `이미 "${clean}" 이 있습니다 — 덮어쓰기를 쓰세요` };
  }
  if (envelope.racks.length >= MAX_RACKS) {
    return { ok: false, reason: `랙은 ${MAX_RACKS}개까지입니다` };
  }

  const saved = normalise({ ...rack, id: newId(), name: clean });
  return write({ ...envelope, racks: [...envelope.racks, saved] })
    ? { ok: true, rack: saved } : { ok: false, reason: '랙을 저장할 수 없습니다' };
}

/** Replace one rack's devices with the chain as it stands now. */
export function overwriteRack(id: string, devices: RackPreset['devices']): RackWrite {
  if (devices.length === 0) return { ok: false, reason: '빈 랙은 저장할 수 없습니다' };
  const envelope = readEnvelope();
  const index = envelope.racks.findIndex((r) => r.id === id);
  const existing = envelope.racks[index];
  if (index < 0 || !existing) return { ok: false, reason: '랙을 찾을 수 없습니다' };
  const next = normalise({ ...existing, devices, updatedAt: Date.now() });
  const racks = [...envelope.racks];
  racks[index] = next;
  return write({ ...envelope, racks })
    ? { ok: true, rack: next } : { ok: false, reason: '랙을 저장할 수 없습니다' };
}

export function renameRack(id: string, nextName: string, note?: string): RackWrite {
  const clean = sanitiseName(nextName);
  if (!clean) return { ok: false, reason: '이름을 입력하세요' };
  const envelope = readEnvelope();
  const index = envelope.racks.findIndex((r) => r.id === id);
  const existing = envelope.racks[index];
  if (index < 0 || !existing) return { ok: false, reason: '랙을 찾을 수 없습니다' };
  if (envelope.racks.some((r) => r.id !== id && r.name === clean)) {
    return { ok: false, reason: `이미 "${clean}" 이 있습니다` };
  }
  const next = normalise({
    ...existing, name: clean,
    note: note === undefined ? existing.note : note,
    updatedAt: Date.now(),
  });
  const racks = [...envelope.racks];
  racks[index] = next;
  return write({ ...envelope, racks })
    ? { ok: true, rack: next } : { ok: false, reason: '랙을 저장할 수 없습니다' };
}

export function deleteRack(id: string): boolean {
  const envelope = readEnvelope();
  const racks = envelope.racks.filter((r) => r.id !== id);
  if (racks.length === envelope.racks.length) return false;
  return write({ ...envelope, racks });
}

export function clearRacks(): void {
  write({ version: SCHEMA_VERSION, racks: [] });
}

// ── Files ─────────────────────────────────────────────────────────────────────

export const EXPORT_KIND = 'loui.daw.racks';

export function exportRacks(id?: string): string {
  const racks = id ? listRacks().filter((r) => r.id === id) : listRacks();
  return JSON.stringify({
    kind: EXPORT_KIND, version: SCHEMA_VERSION, exportedAt: Date.now(), racks,
  }, null, 2);
}

export interface ImportReport {
  added: number;
  renamed: number;
  skipped: number;
  /** Devices that this build does not have, across everything imported. */
  missingDevices: string[];
  reasons: string[];
}

/**
 * Read racks back in.
 *
 * A name clash is renamed rather than replaced — the opposite of the control
 * surface, and for the opposite reason: two racks with similar names are both
 * useful, while two bindings on one fader never are.  A rack containing a
 * device this build lacks is still imported: it will load what it can and say
 * what it could not, which is more useful than refusing the whole chain.
 */
export function importRacks(json: string): ImportReport {
  const report: ImportReport = {
    added: 0, renamed: 0, skipped: 0, missingDevices: [], reasons: [],
  };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    report.skipped += 1;
    report.reasons.push('파일이 올바른 JSON 이 아닙니다');
    return report;
  }
  const file = parsed as { kind?: string; racks?: unknown } | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.racks)) {
    report.skipped += 1;
    report.reasons.push('랙 파일이 아닙니다');
    return report;
  }
  if (file.kind !== EXPORT_KIND) {
    report.skipped += 1;
    report.reasons.push('다른 프로그램의 파일입니다');
    return report;
  }

  const envelope = readEnvelope();
  const racks = [...envelope.racks];
  const missing = new Set<string>();

  for (const raw of file.racks) {
    if (!isRack(raw)) {
      report.skipped += 1;
      report.reasons.push('형식이 맞지 않는 항목 하나를 건너뛰었습니다');
      continue;
    }
    if (racks.length >= MAX_RACKS) {
      report.skipped += 1;
      report.reasons.push(`랙 한도(${MAX_RACKS}개)를 넘었습니다`);
      continue;
    }
    const wanted = sanitiseName(raw.name);
    if (!wanted) {
      report.skipped += 1;
      report.reasons.push('이름이 없는 항목 하나를 건너뛰었습니다');
      continue;
    }
    const taken = new Set(racks.map((r) => r.name));
    const name = uniqueName(wanted, taken);
    if (name !== wanted) report.renamed += 1;

    const rack = normalise({ ...raw, id: newId(), name, updatedAt: Date.now() });
    for (const device of rack.devices) {
      if (!findPlugin(device.pluginId)) missing.add(device.label || device.pluginId);
    }
    racks.push(rack);
    report.added += 1;
  }

  report.missingDevices = [...missing].sort();
  if (report.added > 0 && !write({ ...envelope, racks })) {
    return {
      added: 0, renamed: 0, skipped: report.added + report.skipped,
      missingDevices: [], reasons: ['랙을 저장할 수 없습니다'],
    };
  }
  return report;
}

function uniqueName(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n++) {
    const candidate = sanitiseName(`${wanted} (${n})`);
    if (!taken.has(candidate)) return candidate;
  }
  return sanitiseName(`${wanted} ${Date.now().toString(36)}`);
}

/** `2개 추가 · 1개 이름 변경` — what an import did. */
export function describeImport(report: ImportReport): string {
  const parts = [`${report.added}개 추가`];
  if (report.renamed > 0) parts.push(`${report.renamed}개 이름 변경`);
  if (report.skipped > 0) parts.push(`${report.skipped}개 건너뜀`);
  if (report.missingDevices.length > 0) {
    parts.push(`이 빌드에 없는 장치: ${report.missingDevices.join(', ')}`);
  }
  return parts.join(' · ');
}
