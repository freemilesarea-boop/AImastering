// Where a separation model would go, and what has to be true of it.
//
// ── Why this exists before any model does ────────────────────────────────────
//
// Seven of the twelve stems commercial separators produce — 기타 · 건반 · 신스 ·
// 스트링 · 브라스 · 목관 · 퍼커션 — cannot be made from the signal.  They are
// distinguished by TIMBRE, and every cue this app has is about position,
// duration or register.  A trained model is the only thing that hears timbre.
//
// So this is the socket.  It knows what a model must declare about itself, it
// looks in the places one could be installed, it says what it found and what
// was wrong with what it found — and `hasModel()` is false until something
// passes.  That is deliberately the same shape as `main/plugins/au-native.ts`,
// for the same reason: a capability that is absent has to be absent OUT LOUD,
// with the paths it looked in, or the difference between "not installed" and
// "installed and broken" is invisible to whoever has to fix it.
//
// ── What is NOT here ─────────────────────────────────────────────────────────
//
// The inference itself.  Writing several hundred lines of ONNX plumbing —
// input shaping, windowing, output demultiplexing — against no model to run it
// on would produce exactly what `au_host.mm` was before it was compiled: a
// design document with semicolons, whose first real execution would find the
// bugs.  The runtime is a dynamic import so that installing it is a user's
// choice rather than 137 MB in everyone's download, and the adapter that
// drives it lands when there is a model to drive it against.
//
// What IS here is testable today and is tested: the descriptor format, the
// validation, the reporting, and the refusal.

import { STEM_TREE, stemLabel, type StemKind } from './stem-tree.js';

/** The file a model ships alongside its weights. */
export interface ModelDescriptor {
  /** Stable identifier, e.g. "htdemucs-ft" — used in the report and the UI. */
  id: string;
  /** What a person calls it. */
  name: string;
  /** Which stems it produces.  Must be stems this app knows about. */
  stems: readonly StemKind[];
  /** Sample rate the weights were trained at.  Audio is resampled to it. */
  sampleRate: number;
  /** Channels it takes: 1 or 2. */
  channels: number;
  /** Weights file, relative to the descriptor. */
  weights: string;
  /** SHA-256 of the weights, lower-case hex.  Checked before anything loads. */
  sha256: string;
  /**
   * The licence the WEIGHTS are under — not the code's.
   *
   * This is required, and it is required as free text rather than a flag,
   * because it is the field that decides whether a build may ship the model at
   * all.  Demucs is MIT code with CC-BY-NC weights; a field that only said
   * "MIT" would be true about the wrong half.
   */
  license: string;
  /** True only if the weights may be redistributed inside a commercial app. */
  commercialUse: boolean;
}

export interface ModelProblem {
  /** Where this was found. */
  where: string;
  /** What is wrong with it, in a sentence someone could act on. */
  reason: string;
}

export interface ModelReport {
  /** The model that passed, if one did. */
  model: (ModelDescriptor & { path: string }) | null;
  /** Everywhere that was looked, and what was there. */
  tried: ModelProblem[];
  /** Stems the app can make right now — DSP always, plus the model's if loaded. */
  available: StemKind[];
}

const KNOWN = new Set<StemKind>(STEM_TREE.map((n) => n.kind));
const DSP_STEMS = STEM_TREE.filter((n) => n.source === 'dsp').map((n) => n.kind);

/**
 * Check a descriptor, or say exactly what is wrong with it.
 *
 * Every branch returns a sentence naming the field, because the person reading
 * it is looking at a JSON file and needs to know which line to change.
 */
export function validateDescriptor(value: unknown, where: string): ModelProblem | null {
  const fail = (reason: string): ModelProblem => ({ where, reason });
  if (typeof value !== 'object' || value === null) return fail('JSON 객체가 아닙니다');
  const d = value as Partial<ModelDescriptor>;

  if (typeof d.id !== 'string' || d.id.length === 0) return fail('id 가 없습니다');
  if (typeof d.name !== 'string' || d.name.length === 0) return fail('name 이 없습니다');
  if (typeof d.weights !== 'string' || d.weights.length === 0) return fail('weights 경로가 없습니다');
  if (d.weights.includes('..') || d.weights.startsWith('/')) {
    // A descriptor is data from wherever the user got the model.  It does not
    // get to name a path outside its own folder.
    return fail('weights 경로가 모델 폴더를 벗어납니다');
  }
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) {
    return fail('sha256 이 64자리 소문자 16진수가 아닙니다');
  }
  if (typeof d.license !== 'string' || d.license.length === 0) {
    return fail('license 가 없습니다 — 가중치의 라이선스는 코드의 라이선스와 다를 수 있어서 반드시 적어야 합니다');
  }
  if (typeof d.commercialUse !== 'boolean') return fail('commercialUse 가 true/false 가 아닙니다');
  if (typeof d.sampleRate !== 'number' || !(d.sampleRate >= 8000 && d.sampleRate <= 192000)) {
    return fail('sampleRate 가 8000..192000 밖입니다');
  }
  if (d.channels !== 1 && d.channels !== 2) return fail('channels 가 1 이나 2 가 아닙니다');
  if (!Array.isArray(d.stems) || d.stems.length === 0) return fail('stems 가 비어 있습니다');

  const unknown = d.stems.filter((k) => !KNOWN.has(k as StemKind));
  if (unknown.length > 0) {
    return fail(`이 앱이 모르는 스템입니다: ${unknown.join(', ')}`);
  }
  const duplicates = d.stems.filter((k, i) => d.stems!.indexOf(k) !== i);
  if (duplicates.length > 0) {
    return fail(`같은 스템이 두 번 있습니다: ${[...new Set(duplicates)].join(', ')}`);
  }
  return null;
}

/**
 * Decide what the app can do, given what was found where.
 *
 * `found` is one entry per place looked: the parsed descriptor, or the reason
 * that place did not yield one.  The first valid descriptor wins, and every
 * other entry is kept — including the ones after it — because "there were two
 * models installed and the other one is broken" is worth being able to see.
 */
export function buildReport(
  found: ReadonlyArray<{ where: string; descriptor?: unknown; error?: string }>,
): ModelReport {
  const tried: ModelProblem[] = [];
  let model: (ModelDescriptor & { path: string }) | null = null;

  for (const entry of found) {
    if (entry.error !== undefined) {
      tried.push({ where: entry.where, reason: entry.error });
      continue;
    }
    const problem = validateDescriptor(entry.descriptor, entry.where);
    if (problem) { tried.push(problem); continue; }
    const descriptor = entry.descriptor as ModelDescriptor;
    if (model === null) {
      model = { ...descriptor, path: entry.where };
    } else {
      tried.push({ where: entry.where, reason: `이미 ${model.name} 을 쓰고 있어 건너뜁니다` });
    }
  }

  const available = model
    ? [...new Set([...DSP_STEMS, ...model.stems])]
    : [...DSP_STEMS];
  return { model, tried, available };
}

/** One line for the UI, saying what the situation is. */
export function describeReport(report: ModelReport): string {
  if (report.model) {
    const licence = report.model.commercialUse ? '' : ' · 비상업 라이선스';
    return `${report.model.name} (${report.model.stems.length}개 스템${licence})`;
  }
  if (report.tried.length === 0) return '분리 모델이 설치되어 있지 않습니다';
  return `분리 모델을 찾지 못했습니다 — ${report.tried.length}곳을 확인했습니다`;
}

/** Which stems are out of reach right now, and the single reason why. */
export function unreachable(report: ModelReport): { stems: StemKind[]; why: string } {
  const have = new Set(report.available);
  const stems = STEM_TREE.filter((n) => !have.has(n.kind)).map((n) => n.kind);
  return {
    stems,
    why: stems.length === 0 ? ''
      : `${stems.map(stemLabel).join(' · ')} 은(는) 음색으로만 구분되는 스템입니다`
        + ' — 신호 처리로는 나눌 수 없고, 분리 모델이 있어야 합니다',
  };
}

/** Where a model can be installed, in the order they are tried. */
export const MODEL_FOLDER = 'stem-models';
export const DESCRIPTOR_NAME = 'model.json';
