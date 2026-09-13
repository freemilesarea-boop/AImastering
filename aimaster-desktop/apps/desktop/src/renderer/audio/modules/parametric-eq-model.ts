// parametric-eq-model — free parametric EQ (Phase 1: visualization model).
//
// A simple list-of-bands data structure for a user-defined parametric EQ.
// Each band has type / frequency / gainDb / Q.  Curve evaluation reuses
// the RBJ-cookbook biquad coefficients from eq-curve-model.ts, so the
// visual curve here will match the audible chain once Phase 2 wires the
// bands into the native DSP via WebAudio BiquadFilter nodes.
//
// Phase 1 status: this state is renderer-only.  It produces a curve on
// the spectrum canvas but does NOT yet affect the audible audio — that
// arrives in Phase 2 (DSP integration).  The UI labels this honestly.

export type ParametricBandType = 'highpass' | 'lowshelf' | 'bell' | 'highshelf' | 'lowpass';

export interface ParametricEqBand {
  /** Stable id for React keys + selection. */
  id: string;
  type: ParametricBandType;
  /** Centre / corner frequency in Hz (20–20000). */
  frequencyHz: number;
  /** Gain in dB (-24 to +24).  Ignored for highpass / lowpass. */
  gainDb: number;
  /** Bandwidth: bell uses peaking Q; shelves use slope (0.3–2). */
  q: number;
  /** When false, the band is muted (skipped in curve + DSP). */
  enabled: boolean;
}

