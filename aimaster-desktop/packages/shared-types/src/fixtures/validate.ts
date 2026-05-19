// Runtime validator for FixtureMetadata v1.  Hand-rolled, no deps.

import { FIXTURE_SCHEMA_ID, type FixtureMetadata } from './fixture.js';

export interface FixtureValidationError {
  path: string;
  message: string;
}

export interface FixtureValidationResult {
  ok: boolean;
  errors: FixtureValidationError[];
  fixture?: FixtureMetadata;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const CATEGORIES = new Set<string>([
  'kpop', 'lofi', 'edm', 'hiphop', 'ballad', 'acoustic',
  'female-vocal', 'male-vocal', 'ai-harsh-mix',
  'reference-tone', 'broadcast-speech',
]);

const SLUG_RE = /^[A-Za-z0-9_-]{2,64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function err(errors: FixtureValidationError[], path: string, message: string): void {
  errors.push({ path, message });
}

export function validateFixture(input: unknown): FixtureValidationResult {
  const errors: FixtureValidationError[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'fixture must be an object' }] };
  }
  if (input['$schema'] !== FIXTURE_SCHEMA_ID) {
    err(errors, '/$schema', `must equal ${FIXTURE_SCHEMA_ID}`);
  }
  if (!isString(input['id']) || !SLUG_RE.test(input['id'])) {
    err(errors, '/id', 'must be a slug');
  }
  if (!CATEGORIES.has(input['category'] as string)) {
    err(errors, '/category', `unknown category: ${input['category']}`);
  }
  if (!isString(input['name']) || !input['name']) {
    err(errors, '/name', 'name required');
  }
  if (!isString(input['version']) || !SEMVER_RE.test(input['version'])) {
    err(errors, '/version', 'must be semver');
  }

  const src = input['source'];
  if (!isObject(src)) {
    err(errors, '/source', 'source object required');
  } else {
    const t = src['type'];
    if (t === 'synthetic-recipe') {
      if (!isString(src['recipe'])) err(errors, '/source/recipe', 'must be string');
      if (!isObject(src['params'])) err(errors, '/source/params', 'must be object');
    } else if (t === 'external-cc0') {
      if (!isString(src['url'])) err(errors, '/source/url', 'must be string');
      if (!isString(src['sha256']) || (src['sha256'] as string).length !== 64) {
        err(errors, '/source/sha256', 'must be 64-char hex sha256');
      }
      if (!['CC0', 'CC-BY', 'CC-BY-SA', 'public-domain'].includes(src['license'] as string)) {
        err(errors, '/source/license', 'license must be CC0|CC-BY|CC-BY-SA|public-domain');
      }
    } else if (t === 'user-supplied') {
      if (!isString(src['relativePath'])) err(errors, '/source/relativePath', 'must be string');
    } else {
      err(errors, '/source/type', `unknown source type: ${t}`);
    }
  }

  const ch = input['characteristics'];
  if (!isObject(ch)) {
    err(errors, '/characteristics', 'characteristics object required');
  } else {
    if (!isNumber(ch['durationSec']) || (ch['durationSec'] as number) <= 0) {
      err(errors, '/characteristics/durationSec', 'must be positive number');
    }
    if (![44100, 48000, 88200, 96000].includes(ch['sampleRate'] as number)) {
      err(errors, '/characteristics/sampleRate', 'must be 44100|48000|88200|96000');
    }
    if (![16, 24, 32].includes(ch['bitDepth'] as number)) {
      err(errors, '/characteristics/bitDepth', 'must be 16|24|32');
    }
    if (![1, 2].includes(ch['channels'] as number)) {
      err(errors, '/characteristics/channels', 'must be 1 or 2');
    }
  }

  const ref = input['referenceMaster'];
  if (!isObject(ref)) {
    err(errors, '/referenceMaster', 'object required');
  } else {
    if (!isBool(ref['available'])) {
      err(errors, '/referenceMaster/available', 'must be boolean');
    }
    if (ref['available'] === true && !isString(ref['wavRelativePath'])) {
      err(errors, '/referenceMaster/wavRelativePath', 'required when available=true');
    }
    const tm = ref['targetMetrics'];
    if (!isObject(tm)) {
      err(errors, '/referenceMaster/targetMetrics', 'object required');
    } else {
      if (!isNumber(tm['lufsI'])) err(errors, '/referenceMaster/targetMetrics/lufsI', 'must be number');
      if (!isNumber(tm['tpMaxDb'])) err(errors, '/referenceMaster/targetMetrics/tpMaxDb', 'must be number');
      if (!isNumber(tm['lraMinLu'])) err(errors, '/referenceMaster/targetMetrics/lraMinLu', 'must be number');
      if (!isNumber(tm['lraMaxLu'])) err(errors, '/referenceMaster/targetMetrics/lraMaxLu', 'must be number');
      if (isNumber(tm['lraMinLu']) && isNumber(tm['lraMaxLu']) && (tm['lraMinLu'] as number) > (tm['lraMaxLu'] as number)) {
        err(errors, '/referenceMaster/targetMetrics/lraMaxLu', 'lraMaxLu must be ≥ lraMinLu');
      }
    }
  }

  if (!isString(input['recommendedPresetId']) || !SLUG_RE.test(input['recommendedPresetId'])) {
    err(errors, '/recommendedPresetId', 'must be a slug');
  }

  const pol = input['policy'];
  if (!isObject(pol)) {
    err(errors, '/policy', 'policy object required');
  } else {
    if (!isNumber(pol['lufsToleranceLu']) || (pol['lufsToleranceLu'] as number) < 0) {
      err(errors, '/policy/lufsToleranceLu', 'must be non-negative number');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], fixture: input as unknown as FixtureMetadata };
}
