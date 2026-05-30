// Runtime validator for ReferenceProfile v1.  No external deps.

import {
  REFERENCE_PROFILE_SCHEMA_ID,
  type ReferenceProfile,
} from './profile.js';

export interface ProfileValidationError {
  path: string;
  message: string;
}

export interface ProfileValidationResult {
  ok: boolean;
  errors: ProfileValidationError[];
  profile?: ReferenceProfile;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const SLUG_RE = /^[A-Za-z0-9_-]{2,128}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function err(errs: ProfileValidationError[], path: string, msg: string): void {
  errs.push({ path, message: msg });
}

function validatePercentiles(
  errs: ProfileValidationError[],
  v: unknown,
  path: string,
): void {
  if (!isObj(v)) {
    err(errs, path, 'must be object with p10/p50/p90');
    return;
  }
  for (const k of ['p10', 'p50', 'p90'] as const) {
    if (!isNum(v[k])) err(errs, `${path}/${k}`, 'must be number');
  }
}

/**
 * SAFETY GUARD — reject profiles that smell like fingerprints / contain
 * forbidden identifying fields.  Implementations MUST keep these out of
 * shared profiles; this checker enforces the schema's "no-identification"
 * promise at deserialisation time.
 */
function validateNoForbiddenFields(
  errs: ProfileValidationError[],
  raw: Record<string, unknown>,
): void {
  const root = raw;
  const provenance = (isObj(root['provenance']) ? root['provenance'] : {}) as Record<string, unknown>;
  for (const forbidden of ['artist', 'title', 'album', 'lyrics', 'isrc', 'mbid']) {
    if (forbidden in provenance) {
      err(
        errs,
        `/provenance/${forbidden}`,
        `forbidden identifying field (must not appear in ReferenceProfile)`,
      );
    }
  }
  // Detect things that look like fingerprint arrays (large byte sequences).
  const f = root['features'];
  if (isObj(f)) {
    for (const k of Object.keys(f)) {
      const v = (f as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.length > 200) {
        err(
          errs,
          `/features/${k}`,
          `array length ${v.length} > 200 — this schema forbids long arrays (no time-series, no fingerprint)`,
        );
      }
    }
  }
}

export function validateReferenceProfile(input: unknown): ProfileValidationResult {
  const errs: ProfileValidationError[] = [];
  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '', message: 'profile must be an object' }] };
  }

  if (input['$schema'] !== REFERENCE_PROFILE_SCHEMA_ID) {
    err(errs, '/$schema', `must equal ${REFERENCE_PROFILE_SCHEMA_ID}`);
  }
  if (!isStr(input['id']) || !SLUG_RE.test(input['id'])) {
    err(errs, '/id', 'must be a slug');
  }
  if (!isStr(input['version']) || !SEMVER_RE.test(input['version'])) {
    err(errs, '/version', 'must be semver');
  }

  validateNoForbiddenFields(errs, input);

  const prov = input['provenance'];
  if (!isObj(prov)) {
    err(errs, '/provenance', 'object required');
  } else {
    if (!['user-supplied', 'fixture', 'builtin', 'streaming-snapshot'].includes(
      prov['sourceType'] as string,
    )) {
      err(errs, '/provenance/sourceType', `unknown sourceType: ${prov['sourceType']}`);
    }
    if (!isStr(prov['createdAt'])) err(errs, '/provenance/createdAt', 'must be ISO string');
    if (!isNum(prov['durationSec']) || (prov['durationSec'] as number) <= 0) {
      err(errs, '/provenance/durationSec', 'must be positive number');
    }
    if (!isNum(prov['sampleRate'])) err(errs, '/provenance/sampleRate', 'must be number');
    if (!isNum(prov['channels'])) err(errs, '/provenance/channels', 'must be number');
    if (!isStr(prov['extractorVersion'])) err(errs, '/provenance/extractorVersion', 'must be string');
    const sha = prov['sourceFileSha256'];
    if (sha !== null && sha !== undefined) {
      if (!isStr(sha) || (sha as string).length !== 64) {
        err(errs, '/provenance/sourceFileSha256', 'must be null or 64-char hex sha256');
      }
    }
  }

  const f = input['features'];
  if (!isObj(f)) {
    err(errs, '/features', 'object required');
  } else {
    // Loudness
    const ld = f['loudness'];
    if (!isObj(ld)) {
      err(errs, '/features/loudness', 'object required');
    } else {
      for (const k of ['integratedLufs', 'truePeakDbtp', 'loudnessRange'] as const) {
        if (!isNum(ld[k])) err(errs, `/features/loudness/${k}`, 'must be number');
      }
      validatePercentiles(errs, ld['shortTermPercentiles'], '/features/loudness/shortTermPercentiles');
      validatePercentiles(errs, ld['momentaryPercentiles'], '/features/loudness/momentaryPercentiles');
    }

    // Dynamics
    const dy = f['dynamics'];
    if (!isObj(dy)) {
      err(errs, '/features/dynamics', 'object required');
    } else {
      for (const k of ['crestDb', 'transientDensityPerMin'] as const) {
        if (!isNum(dy[k])) err(errs, `/features/dynamics/${k}`, 'must be number');
      }
      const cs = dy['compressionScore'];
      if (!isNum(cs) || cs < 0 || cs > 1) {
        err(errs, '/features/dynamics/compressionScore', 'must be number in [0, 1]');
      }
    }

    // Tonal
    const tn = f['tonal'];
    if (!isObj(tn)) {
      err(errs, '/features/tonal', 'object required');
    } else {
      if (!isObj(tn['thirdOctSpectrumDb'])) {
        err(errs, '/features/tonal/thirdOctSpectrumDb', 'object required (bin -> dB)');
      } else {
        const bins = Object.keys(tn['thirdOctSpectrumDb'] as Record<string, unknown>);
        if (bins.length > 64) {
          err(
            errs,
            '/features/tonal/thirdOctSpectrumDb',
            `bin count ${bins.length} > 64 — 1/3-oct resolution maximum (no fingerprinting)`,
          );
        }
      }
      for (const k of ['spectralTiltDbPerOct', 'subEnergyRatio', 'lowMidBalanceDb', 'vocalRegionEnergyDb', 'airBandEnergyDb', 'harshnessIndex'] as const) {
        if (!isNum(tn[k])) err(errs, `/features/tonal/${k}`, 'must be number');
      }
      const sub = tn['subEnergyRatio'];
      if (isNum(sub) && (sub < 0 || sub > 1)) {
        err(errs, '/features/tonal/subEnergyRatio', 'must be in [0, 1]');
      }
    }

    // Stereo
    const st = f['stereo'];
    if (!isObj(st)) {
      err(errs, '/features/stereo', 'object required');
    } else {
      for (const k of ['correlationMean', 'msRatioDb', 'stereoWidthIndex'] as const) {
        if (!isNum(st[k])) err(errs, `/features/stereo/${k}`, 'must be number');
      }
      const c = st['correlationMean'];
      if (isNum(c) && (c < -1.001 || c > 1.001)) {
        err(errs, '/features/stereo/correlationMean', 'must be in [-1, +1]');
      }
    }
  }

  if (!isStr(input['featureFingerprint']) || (input['featureFingerprint'] as string).length !== 64) {
    err(errs, '/featureFingerprint', 'must be 64-char hex sha256');
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, errors: [], profile: input as unknown as ReferenceProfile };
}
