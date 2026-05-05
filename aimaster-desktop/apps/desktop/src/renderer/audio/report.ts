// Result explanation system — turn the structured output of every
// processing stage into a human-readable bullet list.
//
// generateMasteringReport() is a PURE function: it takes a structured
// snapshot of what each stage did and produces an array of bullets.  No
// I/O, no DSP — just translation.  The DSP results all carry their own
// diagnostics (gainStaging.appliedGainDb, vocalEnhance.appliedEq,
// transientProtect.maxReductionDb, limiter.measuredLufs, etc.), so
// every bullet here can be cross-checked against the actual numbers
// returned by the modules that produced them.
//
// The format is intentionally concise + action-focused — "what did the
// system DO" rather than "what did the system MEASURE".

import type { GainStagingResult }       from './gainStaging.js';
import type { EnhanceVocalResult }      from './vocalEnhancer.js';
import type { TransientProtectResult }  from './transientProtection.js';
import type { ProcessLimiterResult }    from './limiterChain.js';
import type { LoudnessMetrics }         from './loudnessCore.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Bullet category — drives icon / colour in the UI layer. */
export type ReportCategory =
  | 'gain' | 'eq' | 'dynamics' | 'transient'
  | 'vocal' | 'loudness' | 'truepeak' | 'info' | 'warning';

export interface ReportBullet {
  text:        string;
  category:    ReportCategory;
  /** "major" bullets are always shown; "minor" can be collapsed in the UI. */
  importance:  'major' | 'minor';
}

export interface MasteringReport {
  /** One-line summary (e.g. "Mastered to -10 LUFS, 8 actions taken"). */
  summary:    string;
  bullets:    ReportBullet[];
  /** Convenience counts for the UI. */
  totalActions: number;
}

/** Optional ad-hoc EQ entry the caller can inject (e.g. low-cut module). */
export interface AdhocEqAdjustment {
  /** Free-form description, e.g. "Reduced low-end mud below 80Hz".
   *  Used verbatim if provided.  Otherwise we'll auto-format from the
   *  freqHz / gainDb / q fields. */
  description?: string;
  freqHz?:      number;
  gainDb?:      number;
  q?:           number;
}

/** What the caller passes in.  Every field is optional — the report
 *  function emits bullets only for stages that actually ran. */
export interface MasteringPipelineSnapshot {
  inputMetrics?:      LoudnessMetrics;
  outputMetrics?:     LoudnessMetrics;
  gainStaging?:       GainStagingResult;
  vocalEnhance?:      EnhanceVocalResult;
  transientProtect?:  TransientProtectResult;
  limiter?:           ProcessLimiterResult;
  /** Anything else applied outside the standard modules. */
  adhocEq?:           AdhocEqAdjustment[];
  /** Free-form notes appended verbatim. */
  customNotes?:       string[];
}

// ── Formatting helpers ───────────────────────────────────────────────────────
const fmt1 = (v: number): string =>
  isFinite(v) ? (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)) : '—';
const fmtAbs1 = (v: number): string => Math.abs(v).toFixed(1);

function fmtFreq(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return Number.isInteger(k) ? `${k}kHz` : `${k.toFixed(1)}kHz`;
  }
  return `${Math.round(hz)}Hz`;
}

// Auto-describe a generic peaking-EQ change when the caller didn't give
// us a free-form description.  e.g. {freq: 80, gain: -3} → "Reduced 80Hz by -3.0dB".
function describeEq(eq: AdhocEqAdjustment): string {
  if (eq.description) return eq.description;
  const f = typeof eq.freqHz === 'number' ? fmtFreq(eq.freqHz) : 'mid';
  const g = typeof eq.gainDb === 'number' ? eq.gainDb : 0;
  if (g === 0) return `EQ adjustment at ${f}`;
  if (g > 0)   return `Boosted ${f} by ${fmt1(g)}dB`;
  return        `Reduced ${f} by ${fmt1(g)}dB`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Translate a pipeline snapshot into a structured human-readable report.
 * Pure function — safe to call from React render or any worker thread.
 */
export function generateMasteringReport(
  snap: MasteringPipelineSnapshot = {},
): MasteringReport {
  const bullets: ReportBullet[] = [];

  // ── Gain staging ─────────────────────────────────────────────────────────
  if (snap.gainStaging) {
    const gs = snap.gainStaging;
    if (gs.decision === 'attenuate') {
      bullets.push({
        text:
          `Reduced input level by ${fmtAbs1(gs.appliedGainDb)}dB to maintain headroom`
          + ` (limited by ${gs.limitedBy})`,
        category:   'gain',
        importance: 'major',
      });
    } else if (gs.decision === 'boost') {
      bullets.push({
        text:
          `Boosted input level by ${fmt1(gs.appliedGainDb)}dB`
          + ` to bring it into mastering range`,
        category:   'gain',
        importance: 'major',
      });
    }
    // decision === 'pass' → no bullet (no notable action).
  }

  // ── Vocal enhancement ────────────────────────────────────────────────────
  if (snap.vocalEnhance && !snap.vocalEnhance.bypassed) {
    for (const eq of snap.vocalEnhance.appliedEq) {
      const direction = eq.gainDb >= 0 ? 'Boosted vocal presence' : 'Reduced vocal harshness';
      const sign = eq.gainDb >= 0 ? `+${eq.gainDb.toFixed(1)}` : eq.gainDb.toFixed(1);
      bullets.push({
        text:       `${direction} by ${sign}dB at ${fmtFreq(eq.freqHz)}`,
        category:   'vocal',
        importance: 'major',
      });
    }
    if (snap.vocalEnhance.appliedEq.length === 0
        && snap.vocalEnhance.analysis.diagnosis === 'balanced') {
      // Detected vocal but nothing to fix — note as minor.
      bullets.push({
        text:
          `Vocal detected and analyzed (score `
          + `${snap.vocalEnhance.analysis.vocalScore.toFixed(2)}); no correction needed`,
        category:   'vocal',
        importance: 'minor',
      });
    }
  }

  // ── Ad-hoc EQ adjustments (caller-supplied) ──────────────────────────────
  if (snap.adhocEq) {
    for (const eq of snap.adhocEq) {
      bullets.push({
        text:       describeEq(eq),
        category:   'eq',
        importance: 'major',
      });
    }
  }

  // ── Transient protection ─────────────────────────────────────────────────
  if (snap.transientProtect) {
    const tp = snap.transientProtect;
    if (tp.transientCount > 0 && tp.maxReductionDb >= 0.3) {
      bullets.push({
        text:
          `Tamed ${tp.transientCount} transient peak${tp.transientCount === 1 ? '' : 's'}`
          + ` by up to ${fmtAbs1(tp.maxReductionDb)}dB to preserve punch`,
        category:   'transient',
        importance: 'major',
      });
    }
  }

  // ── Limiter / loudness target ────────────────────────────────────────────
  if (snap.limiter) {
    const lim = snap.limiter;
    bullets.push({
      text:       `Adjusted loudness to ${lim.measuredLufs.toFixed(1)} LUFS`,
      category:   'loudness',
      importance: 'major',
    });
    if (lim.maxGrDb >= 0.5) {
      bullets.push({
        text:
          `Applied ${fmtAbs1(lim.maxGrDb)}dB peak limiting`
          + ` over ${lim.passes} pass${lim.passes === 1 ? '' : 'es'}`,
        category:   'dynamics',
        importance: 'major',
      });
    }
    if (lim.truePeakGuarded) {
      bullets.push({
        text:       `True-peak guard engaged — capped peaks at ${lim.truePeakDbtp.toFixed(1)} dBTP`,
        category:   'truepeak',
        importance: 'major',
      });
    } else {
      bullets.push({
        text:       `True peak ${lim.truePeakDbtp.toFixed(1)} dBTP (within target)`,
        category:   'truepeak',
        importance: 'minor',
      });
    }
    if (!lim.converged && lim.passes > 1) {
      bullets.push({
        text:
          `Loudness target not fully reached after ${lim.passes} passes`
          + ` — consider relaxing the target or reducing input dynamics`,
        category:   'warning',
        importance: 'major',
      });
    }
  }

  // ── Loudness Range / dynamics summary ───────────────────────────────────
  if (snap.outputMetrics && isFinite(snap.outputMetrics.loudnessRange)) {
    const lra = snap.outputMetrics.loudnessRange;
    if (lra > 0) {
      bullets.push({
        text:       `Final loudness range (LRA): ${lra.toFixed(1)} LU`,
        category:   'info',
        importance: 'minor',
      });
    }
  }

  // ── Input → output loudness delta ────────────────────────────────────────
  if (snap.inputMetrics && snap.outputMetrics
      && isFinite(snap.inputMetrics.integratedLufs)
      && isFinite(snap.outputMetrics.integratedLufs)) {
    const delta = snap.outputMetrics.integratedLufs - snap.inputMetrics.integratedLufs;
    if (Math.abs(delta) >= 0.5) {
      const verb = delta > 0 ? 'Increased' : 'Decreased';
      bullets.push({
        text:       `${verb} integrated loudness by ${fmtAbs1(delta)} LU overall`,
        category:   'loudness',
        importance: 'minor',
      });
    }
  }

  // ── Custom notes (verbatim) ──────────────────────────────────────────────
  if (snap.customNotes) {
    for (const note of snap.customNotes) {
      bullets.push({ text: note, category: 'info', importance: 'minor' });
    }
  }

  // ── Summary line ────────────────────────────────────────────────────────
  const majorCount = bullets.filter((b) => b.importance === 'major').length;
  let summary: string;
  if (snap.limiter && isFinite(snap.limiter.measuredLufs)) {
    summary =
      `Mastered to ${snap.limiter.measuredLufs.toFixed(1)} LUFS`
      + ` (${majorCount} action${majorCount === 1 ? '' : 's'} taken)`;
  } else if (majorCount > 0) {
    summary = `Processing complete — ${majorCount} action${majorCount === 1 ? '' : 's'} taken`;
  } else {
    summary = 'Processing complete — no audible changes';
  }

  return { summary, bullets, totalActions: majorCount };
}
