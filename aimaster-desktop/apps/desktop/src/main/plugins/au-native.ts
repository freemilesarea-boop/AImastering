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
// it loads is macOS-only and is not built or exercised here; see
// `native/au-host/README.md` for how to build and check it on a Mac.

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

/** Where the built addon lands.  One name, so a missing build is obvious. */
export const AU_MODULE = '@loui/au-host';

let cached: AuNativeHost | null | undefined;

/**
 * Load the native module, or report that there isn't one.
 *
 * Never throws and never retries: a missing addon is the NORMAL state on every
 * platform but macOS, and on macOS until someone builds it.  Retrying on every
 * bounce would turn a known absence into a per-job cost.
 */
export function loadAuHost(
  require_: ((id: string) => unknown) | null = null,
): AuNativeHost | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'darwin' && require_ === null) return cached;
  try {
    const req = require_ ?? eval('require') as (id: string) => unknown;
    const mod = req(AU_MODULE) as Partial<AuNativeHost> | undefined;
    if (mod && typeof mod.open === 'function' && typeof mod.process === 'function'
      && typeof mod.close === 'function') {
      cached = mod as AuNativeHost;
    }
  } catch {
    // Not built, wrong architecture, blocked by library validation.  All of
    // them mean the same thing here: no Audio Unit hosting in this build.
    cached = null;
  }
  return cached;
}

/** Tests inject a fake; this puts it back. */
export function setAuHost(host: AuNativeHost | null | undefined): void {
  cached = host;
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
