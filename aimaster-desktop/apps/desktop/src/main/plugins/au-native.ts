// The wall between this app and an Audio Unit.
//
// An AU is third-party machine code.  The host process already isolates it —
// a crash or a hang comes back as an error on one bounce — but isolation only
// covers the ways a plugin fails LOUDLY.  This file covers the other kind:
// the plugin that returns, successfully, with garbage in the buffer.
//
// That is not a hypothetical.  A plugin fed a block at a rate it does not
// support can return NaN.  One with an internal feedback path can return
// values that grow without bound.  One that decides it wants a different
// channel count can hand back a buffer of the wrong length.  Every one of
// those is a `noErr` from `AudioUnitRender`, and every one of them written
// into a bounce is a file the user discovers is ruined a day later.
//
// So nothing the native side returns is trusted.  It is measured, and a stage
// that fails the measurement is REFUSED — its samples are left exactly as they
// came in and the reason is reported — rather than written through.  This is
// the same rule the language-model front end follows for the same reason:
// the boundary changed, the trust did not.
//
// ── What is verified and what is not ─────────────────────────────────────────
//
// Everything in THIS file is tested, against a fake native host that returns
// the wrong length, NaNs, infinities, silence, and throws.  The native module
// it loads is macOS-only, but it is no longer unexercised: `pnpm test:au-native`
// compiles the real `au_host.mm` against a fake CoreAudio and runs this file's
// `runAuStage` straight through it.  Only Apple's own framework is left
// untested here, and the macOS CI job covers that.  See
// `native/au-host/README.md`.

import type { HostStage } from './host-protocol.js';

/** The surface a native AU host must expose.  Deliberately tiny. */
export interface AuNativeHost {
  /**
   * Open a component and return an opaque handle.
   *
   * `uid` is `type-subtype-manufacturer`, the triple `AudioComponentFindNext`
   * matches on — the same string the scanner read out of `Info.plist`, so the
   * app never has to open a binary to know what is inside it.
   */
  open(uid: string, sampleRate: number, channels: number): number;
  /** Parameter ids the component declares, so names can be resolved. */
  parameters(handle: number): Array<{ id: number; name: string; min: number; max: number }>;
  setParameter(handle: number, id: number, value: number): void;
  /** Process interleaved float32 IN PLACE.  Returns frames written. */
  process(handle: number, samples: Float32Array, frames: number): number;
  close(handle: number): void;
}

/** The package name, for anyone who links the module into `node_modules`. */
export const AU_MODULE = '@loui/au-host';

/**
 * Every place the built addon can legitimately be.
 *
 * This list exists because the bare specifier alone was a dead end: nothing
 * links `@loui/au-host` into `node_modules`, `native/au-host` is outside the
 * pnpm workspace globs, and it is not a dependency of anything.  So
 * `require('@loui/au-host')` could never resolve — on a Mac, after a
 * successful `node-gyp rebuild`, `hasAuHost()` was still false and the plugin
 * manager still showed the `native-module` blocker.  A build whose output
 * nothing can load is not a build.
 *
 * `.node` files must live OUTSIDE `app.asar`: `dlopen` needs a real path on
 * disk, so the packaged copy goes in `extraResources` (see
 * electron-builder.yml) rather than in `files`.
 */
export function auCandidates(
  resourcesPath: string | undefined
    = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  baseDir: string = __dirname,
): string[] {
  const out = [AU_MODULE];
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    out.push(`${resourcesPath}/au-host/au_host.node`);
  }
  // A Mac dev checkout where `pnpm build:au` has been run and nothing else —
  // which is exactly what native/au-host/README.md tells people to do.  Two
  // depths, because `__dirname` is `src/main/plugins` when this file is run
  // from source and `dist-electron/main` once esbuild has bundled it, and a
  // path that is only right in one of them is right for nobody.
  const built = 'native/au-host/build/Release/au_host.node';
  out.push(`${baseDir}/../../../${built}`);   // src/main/plugins → apps/desktop
  out.push(`${baseDir}/../../${built}`);      // dist-electron/main → apps/desktop
  return out;
}

export interface AuLoadReport {
  host: AuNativeHost | null;
  /** Where it was loaded from, when it was. */
  loadedFrom: string | null;
  /** Every place that was tried and what went wrong there. */
  tried: Array<{ where: string; error: string }>;
}

let cached: AuNativeHost | null | undefined;
let report: AuLoadReport = { host: null, loadedFrom: null, tried: [] };

/** Enough of the module to be worth calling.  A partial export is not. */
function usable(mod: unknown): mod is AuNativeHost {
  const m = mod as Partial<AuNativeHost> | undefined | null;
  return !!m && typeof m.open === 'function' && typeof m.parameters === 'function'
    && typeof m.setParameter === 'function' && typeof m.process === 'function'
    && typeof m.close === 'function';
}

/**
 * Load the native module, or report that there isn't one — and from where.
 *
 * Never throws and never retries: a missing addon is the NORMAL state on every
 * platform but macOS, and on macOS until someone builds it.  Retrying on every
 * bounce would turn a known absence into a per-job cost.  The list of places
 * that were tried is kept, because "no AU hosting" with no further detail is
 * the failure that took a working build a long time to notice.
 */
export function loadAuHost(
  require_: ((id: string) => unknown) | null = null,
  candidates: readonly string[] | null = null,
): AuNativeHost | null {
  if (cached !== undefined) return cached;
  cached = null;
  report = { host: null, loadedFrom: null, tried: [] };
  if (process.platform !== 'darwin' && require_ === null) {
    report.tried.push({ where: '(플랫폼)', error: `${process.platform} 에서는 AU 가 없습니다` });
    return cached;
  }
  const req = require_ ?? eval('require') as (id: string) => unknown;
  for (const where of candidates ?? auCandidates()) {
    try {
      const mod = req(where);
      if (usable(mod)) {
        cached = mod;
        report = { host: mod, loadedFrom: where, tried: report.tried };
        return cached;
      }
      report.tried.push({ where, error: '모듈이 필요한 함수를 내보내지 않습니다' });
    } catch (err) {
      // Not built, wrong architecture, blocked by library validation.  All of
      // them mean the same thing to the caller — but not to whoever has to fix
      // it, so the message is kept.
      report.tried.push({ where, error: String(err).slice(0, 200) });
    }
  }
  return cached;
}

/** Where it looked, and what it found.  Loads on first ask. */
export function auLoadReport(): AuLoadReport {
  loadAuHost();
  return report;
}

/** Tests inject a fake; this puts it back. */
export function setAuHost(host: AuNativeHost | null | undefined): void {
  cached = host;
  report = host
    ? { host, loadedFrom: '(주입됨)', tried: [] }
    : { host: null, loadedFrom: null, tried: [] };
}

export function hasAuHost(): boolean {
  return loadAuHost() !== null;
}

// ── Checking what came back ───────────────────────────────────────────────────

export interface BlockCheck {
  ok: boolean;
  reason?: string;
}

/**
 * The ceiling above which a sample is not audio.
 *
 * Not 1.0 — plugins legitimately overshoot, and a bounce is float, so a peak
 * of 3 is loud but real.  This is the line past which the only explanations
 * left are a runaway feedback path or a garbage read, and both of those must
 * not reach the file.
 */
export const SANE_PEAK = 64;

/**
 * Did the plugin return audio?
 *
 * Scans for the three failures that arrive as success: a short buffer, a
 * non-finite sample, and a magnitude that is not a mix decision.  The scan is
 * O(n) over a bounce-sized buffer, which is the same order as the copy that
 * produced it — cheap next to the plugin call it is checking.
 */
export function checkBlock(
  samples: Float32Array, expectedTotal: number, framesWritten: number, frames: number,
): BlockCheck {
  if (framesWritten !== frames) {
    return { ok: false, reason: `프레임 수가 다릅니다 (${framesWritten} ≠ ${frames})` };
  }
  if (samples.length < expectedTotal) {
    return { ok: false, reason: `버퍼가 짧습니다 (${samples.length} < ${expectedTotal})` };
  }
  let peak = 0;
  for (let i = 0; i < expectedTotal; i++) {
    const v = samples[i]!;
    if (!Number.isFinite(v)) return { ok: false, reason: `${i} 번째 샘플이 숫자가 아닙니다` };
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
  }
  if (peak > SANE_PEAK) {
    return { ok: false, reason: `출력이 폭주했습니다 (피크 ${peak.toFixed(1)})` };
  }
  return { ok: true };
}

// ── Parameters ────────────────────────────────────────────────────────────────

/**
 * Match the parameter names a session stores to the ids an AU declares.
 *
 * The session stores `Record<string, number>` keyed by NAME, because that is
 * what survives a plugin update: an Audio Unit's parameter ids are a private
 * numbering the vendor may renumber between versions, while "Threshold" stays
 * "Threshold".  Matching is case- and space-insensitive for the same reason —
 * "Dry/Wet", "dry wet" and "DryWet" are one control.
 *
 * A name with no match is REPORTED rather than dropped.  A session that quietly
 * stopped applying half a preset after an update is the failure this prevents.
 */
export interface ParamPlan {
  set: Array<{ id: number; name: string; value: number }>;
  unmatched: string[];
}

const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function planParameters(
  declared: ReadonlyArray<{ id: number; name: string; min: number; max: number }>,
  wanted: Readonly<Record<string, number>>,
): ParamPlan {
  const byName = new Map(declared.map((p) => [normalise(p.name), p]));
  const set: ParamPlan['set'] = [];
  const unmatched: string[] = [];

  for (const [name, value] of Object.entries(wanted)) {
    const spec = byName.get(normalise(name));
    if (!spec) { unmatched.push(name); continue; }
    if (!Number.isFinite(value)) { unmatched.push(name); continue; }
    // Clamped to what the plugin says it accepts.  Out-of-range values are
    // undefined behaviour in an AU, and undefined behaviour in third-party
    // native code is the thing this whole file exists to avoid.
    set.push({ id: spec.id, name: spec.name, value: Math.min(spec.max, Math.max(spec.min, value)) });
  }
  return { set, unmatched };
}

// ── One stage ─────────────────────────────────────────────────────────────────

export interface StageOutcome {
  applied: boolean;
  reason?: string;
}

/**
 * Run one Audio Unit over the buffer, or explain why it did not.
 *
 * The buffer is only overwritten when the plugin's output passes `checkBlock`,
 * so a stage that fails leaves the audio exactly as it arrived.  That is the
 * property that makes a chain of five plugins safe when the third one is bad:
 * you lose that plugin, not the bounce.
 */
export function runAuStage(
  host: AuNativeHost,
  samples: Float32Array,
  frames: number,
  channels: number,
  sampleRate: number,
  stage: HostStage,
): StageOutcome {
  if (!stage.uid) return { applied: false, reason: '컴포넌트 식별자가 없습니다' };

  let handle: number | null = null;
  // Work on a copy so a plugin that writes garbage cannot damage the input it
  // was given.  A bounce-sized copy is cheap next to opening an AU.
  const scratch = samples.slice(0, frames * channels);

  try {
    handle = host.open(stage.uid, sampleRate, channels);
    if (!Number.isFinite(handle) || handle <= 0) {
      return { applied: false, reason: '컴포넌트를 열지 못했습니다' };
    }

    let unmatched: string[] = [];
    if (Object.keys(stage.params).length > 0) {
      const plan = planParameters(host.parameters(handle), stage.params);
      unmatched = plan.unmatched;
      for (const entry of plan.set) host.setParameter(handle, entry.id, entry.value);
    }

    const written = host.process(handle, scratch, frames);
    const check = checkBlock(scratch, frames * channels, written, frames);
    if (!check.ok) return { applied: false, reason: check.reason ?? '출력이 올바르지 않습니다' };

    samples.set(scratch, 0);
    return unmatched.length > 0
      ? { applied: true, reason: `모르는 파라미터: ${unmatched.slice(0, 3).join(', ')}` }
      : { applied: true };
  } catch (err) {
    return { applied: false, reason: `플러그인이 실패했습니다: ${String(err)}` };
  } finally {
    if (handle !== null) { try { host.close(handle); } catch { /* already gone */ } }
  }
}
