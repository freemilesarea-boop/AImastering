// Runtime validator for EnginePreset.  Hand-rolled (no zod dep) to keep the
// shared-types package zero-dependency.  Returns either a validated preset
// (narrowed by type assertion) or a list of errors with JSON pointer paths.

import {
  ENGINE_PRESET_SCHEMA_ID,
  type EnginePreset,
  type EnginePresetSchemaId,
} from './preset.js';
import {
  ENGINE_MODULE_ORDER,
  type EngineModule,
  type EngineModuleType,
} from './modules.js';

export interface ValidationError {
  /** RFC 6901-style JSON pointer to the offending field. */
  path: string;
  /** Human-readable English message. */
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Present iff `ok === true`. */
  preset?: EnginePreset;
}

type Issue = ValidationError;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

const MODULE_TYPES = new Set<EngineModuleType>(ENGINE_MODULE_ORDER);

// Semver-ish: MAJOR.MINOR.PATCH with optional -pre.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const ULID_OR_SLUG_RE = /^[A-Za-z0-9_-]{2,64}$/;

function pushIfMissing(
  errs: Issue[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  expected: string,
): boolean {
  if (obj[key] === undefined || obj[key] === null) {
    errs.push({ path: `${path}/${key}`, message: `missing required ${expected}` });
    return true;
  }
  return false;
}

function validateNumberRange(
  errs: Issue[],
  v: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): boolean {
  if (!isNumber(v)) {
    errs.push({ path, message: `expected finite number, got ${typeof v}` });
    return false;
  }
  if (opts.min !== undefined && v < opts.min) {
    errs.push({ path, message: `value ${v} below min ${opts.min}` });
    return false;
  }
  if (opts.max !== undefined && v > opts.max) {
    errs.push({ path, message: `value ${v} above max ${opts.max}` });
    return false;
  }
  return true;
}

function validateModule(errs: Issue[], node: unknown, path: string): void {
  if (!isObject(node)) {
    errs.push({ path, message: 'expected module object' });
    return;
  }
  const type = node['type'];
  if (!isString(type) || !MODULE_TYPES.has(type as EngineModuleType)) {
    errs.push({ path: `${path}/type`, message: `unknown module type: ${JSON.stringify(type)}` });
    return;
  }
  const id = node['id'];
  if (!isString(id) || !ULID_OR_SLUG_RE.test(id)) {
    errs.push({ path: `${path}/id`, message: `id must match ${ULID_OR_SLUG_RE}` });
  }

  switch (type as EngineModuleType) {
    case 'source':
    case 'sink':
      return;

    case 'adaptive-eq': {
      const bands = node['bands'];
      if (!Array.isArray(bands) || bands.length === 0) {
        errs.push({ path: `${path}/bands`, message: 'adaptive-eq must have ≥1 band' });
        return;
      }
      bands.forEach((b: unknown, i: number) => {
        const bp = `${path}/bands/${i}`;
        if (!isObject(b)) {
          errs.push({ path: bp, message: 'band must be an object' });
          return;
        }
        if (!isString(b['id'])) errs.push({ path: `${bp}/id`, message: 'band id must be string' });
        const ft = b['filterType'];
        if (!isString(ft) || !['low_shelf','high_shelf','peak','high_pass','low_pass'].includes(ft)) {
          errs.push({ path: `${bp}/filterType`, message: `unknown filterType: ${JSON.stringify(ft)}` });
        }
        validateNumberRange(errs, b['freqHz'], `${bp}/freqHz`, { min: 1, max: 96000 });
        validateNumberRange(errs, b['gainDb'], `${bp}/gainDb`, { min: -48, max: 24 });
      });
      return;
    }

    case 'dynamic-eq': {
      validateNumberRange(errs, node['intensity'], `${path}/intensity`, { min: 0, max: 2 });
      const bands = node['bands'];
      if (!Array.isArray(bands)) {
        errs.push({ path: `${path}/bands`, message: 'bands must be array' });
        return;
      }
      bands.forEach((b: unknown, i: number) => {
        const bp = `${path}/bands/${i}`;
        if (!isObject(b)) return;
        validateNumberRange(errs, b['freqHz'], `${bp}/freqHz`, { min: 20, max: 20000 });
        validateNumberRange(errs, b['q'], `${bp}/q`, { min: 0.1, max: 10 });
        validateNumberRange(errs, b['thresholdDb'], `${bp}/thresholdDb`, { min: -60, max: 0 });
        validateNumberRange(errs, b['reductionDb'], `${bp}/reductionDb`, { min: 0, max: 12 });
        if (b['mode'] !== 'cut' && b['mode'] !== 'boost') {
          errs.push({ path: `${bp}/mode`, message: `mode must be 'cut' or 'boost'` });
        }
      });
      return;
    }

    case 'multiband-eq': {
      const bands = node['bands'];
      if (!Array.isArray(bands)) {
        errs.push({ path: `${path}/bands`, message: 'bands must be array' });
        return;
      }
      bands.forEach((b: unknown, i: number) => {
        const bp = `${path}/bands/${i}`;
        if (!isObject(b)) return;
        if (!['low','mid','vocal','high'].includes(b['id'] as string)) {
          errs.push({ path: `${bp}/id`, message: `multiband band id must be low|mid|vocal|high` });
        }
        validateNumberRange(errs, b['centreHz'], `${bp}/centreHz`, { min: 20, max: 20000 });
        validateNumberRange(errs, b['q'], `${bp}/q`, { min: 0.1, max: 10 });
        validateNumberRange(errs, b['gainDb'], `${bp}/gainDb`, { min: -12, max: 12 });
      });
      return;
    }

    case 'bus-comp':
      validateNumberRange(errs, node['thresholdDb'], `${path}/thresholdDb`, { min: -60, max: 0 });
      validateNumberRange(errs, node['ratio'], `${path}/ratio`, { min: 1, max: 20 });
      validateNumberRange(errs, node['attackMs'], `${path}/attackMs`, { min: 0.1, max: 1000 });
      validateNumberRange(errs, node['releaseMs'], `${path}/releaseMs`, { min: 1, max: 5000 });
      validateNumberRange(errs, node['makeupDb'], `${path}/makeupDb`, { min: 0, max: 24 });
      validateNumberRange(errs, node['kneeDb'], `${path}/kneeDb`, { min: 0, max: 24 });
      return;

    case 'saturator':
      validateNumberRange(errs, node['amount'], `${path}/amount`, { min: 0, max: 1 });
      return;

    case 'stereo-imager':
      validateNumberRange(errs, node['width'], `${path}/width`, { min: 0, max: 4 });
      return;

    case 'deesser':
      validateNumberRange(errs, node['freqHz'], `${path}/freqHz`, { min: 1000, max: 20000 });
      validateNumberRange(errs, node['q'], `${path}/q`, { min: 0.1, max: 10 });
      validateNumberRange(errs, node['reductionDb'], `${path}/reductionDb`, { min: 0, max: 12 });
      return;

    case 'loudness-norm':
      validateNumberRange(errs, node['targetLufs'], `${path}/targetLufs`, { min: -36, max: -3 });
      validateNumberRange(errs, node['targetTpDb'], `${path}/targetTpDb`, { min: -9, max: 0 });
      if (node['targetLra'] !== undefined) {
        validateNumberRange(errs, node['targetLra'], `${path}/targetLra`, { min: 1, max: 30 });
      }
      return;

    case 'limiter':
      validateNumberRange(errs, node['ceilingDb'], `${path}/ceilingDb`, { min: -6, max: 0 });
      return;

    case 'isp-safety':
      validateNumberRange(errs, node['ceilingDbtp'], `${path}/ceilingDbtp`, { min: -6, max: 0 });
      return;

    case 'dither':
      if (![16, 24, 32].includes(node['bitDepth'] as number)) {
        errs.push({ path: `${path}/bitDepth`, message: 'bitDepth must be 16, 24 or 32' });
      }
      return;

    case 'gain-staging':
    case 'transient-protection':
    case 'vocal-enhancer':
    case 'soft-clip':
      // All fields optional with adapter-defined defaults.
      return;

    default: {
      // Exhaustive check (TS will error if a new module type is added without
      // covering it here).
      const _exhaustive: never = type as never;
      errs.push({ path: `${path}/type`, message: `unhandled module type ${_exhaustive}` });
    }
  }
}

export function validateEnginePreset(input: unknown): ValidationResult {
  const errs: Issue[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'preset must be an object' }] };
  }

  if (input['$schema'] !== ENGINE_PRESET_SCHEMA_ID) {
    errs.push({
      path: '/$schema',
      message: `$schema must equal ${ENGINE_PRESET_SCHEMA_ID}`,
    });
  }

  if (!isString(input['id']) || !ULID_OR_SLUG_RE.test(input['id'])) {
    errs.push({ path: '/id', message: `id must match ${ULID_OR_SLUG_RE}` });
  }
  if (!isString(input['name']) || (input['name'] as string).length === 0) {
    errs.push({ path: '/name', message: 'name must be non-empty string' });
  }
  if (!isString(input['version']) || !SEMVER_RE.test(input['version'])) {
    errs.push({ path: '/version', message: 'version must be semver (X.Y.Z)' });
  }

  const compat = input['compatibility'];
  if (!isObject(compat)) {
    errs.push({ path: '/compatibility', message: 'compatibility object required' });
  } else if (!isString(compat['engineApiMin']) || !SEMVER_RE.test(compat['engineApiMin'])) {
    errs.push({ path: '/compatibility/engineApiMin', message: 'must be semver' });
  }

  const meta = input['meta'];
  if (meta !== undefined && !isObject(meta)) {
    errs.push({ path: '/meta', message: 'meta must be an object if present' });
  }

  const policies = input['policies'];
  if (!isObject(policies)) {
    errs.push({ path: '/policies', message: 'policies object required (may be empty)' });
  } else {
    const vp = policies['vocalProtection'];
    if (vp !== undefined && !['off', 'safe', 'strict'].includes(vp as string)) {
      errs.push({ path: '/policies/vocalProtection', message: 'must be off|safe|strict' });
    }
    const sm = policies['safeMode'];
    if (sm !== undefined && !['none', 'safe', 'vocal_safe', 'low_limit'].includes(sm as string)) {
      errs.push({ path: '/policies/safeMode', message: 'must be none|safe|vocal_safe|low_limit' });
    }
    if (policies['aiCorrections'] !== undefined && !isBoolean(policies['aiCorrections'])) {
      errs.push({ path: '/policies/aiCorrections', message: 'must be boolean' });
    }
  }

  const out = input['output'];
  if (!isObject(out)) {
    errs.push({ path: '/output', message: 'output object required' });
  } else {
    if (![44100, 48000, 88200, 96000].includes(out['sampleRate'] as number)) {
      errs.push({ path: '/output/sampleRate', message: 'sampleRate must be 44100|48000|88200|96000' });
    }
    if (![16, 24, 32].includes(out['bitDepth'] as number)) {
      errs.push({ path: '/output/bitDepth', message: 'bitDepth must be 16|24|32' });
    }
    if (!['wav', 'flac', 'mp3', 'aac'].includes(out['format'] as string)) {
      errs.push({ path: '/output/format', message: 'format must be wav|flac|mp3|aac' });
    }
  }

  const chain = input['chain'];
  if (!isObject(chain) || !Array.isArray(chain['nodes'])) {
    errs.push({ path: '/chain/nodes', message: 'chain.nodes must be array' });
  } else {
    const nodes = chain['nodes'] as unknown[];
    if (nodes.length < 2) {
      errs.push({ path: '/chain/nodes', message: 'chain must have at least source and sink' });
    }
    nodes.forEach((n, i) => validateModule(errs, n, `/chain/nodes/${i}`));

    // First must be source, last must be sink.
    if (nodes.length > 0 && isObject(nodes[0]!) && (nodes[0] as Record<string, unknown>)['type'] !== 'source') {
      errs.push({ path: '/chain/nodes/0/type', message: 'first node must be source' });
    }
    const last = nodes[nodes.length - 1];
    if (nodes.length > 0 && isObject(last!) && (last as Record<string, unknown>)['type'] !== 'sink') {
      errs.push({ path: `/chain/nodes/${nodes.length - 1}/type`, message: 'last node must be sink' });
    }

    // IDs must be unique.
    const seen = new Set<string>();
    nodes.forEach((n, i) => {
      if (isObject(n) && isString(n['id'])) {
        if (seen.has(n['id'])) {
          errs.push({ path: `/chain/nodes/${i}/id`, message: `duplicate id: ${n['id']}` });
        }
        seen.add(n['id']);
      }
    });
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, errors: [], preset: input as unknown as EnginePreset };
}
