// ReferenceProfile v1 — characteristic-based reference description.
//
// LEGAL / DESIGN CONTRACT
// ─────────────────────────────────────────────────────────────────────────
// This schema is DELIBERATELY DESIGNED to prevent reconstruction of source
// audio.  Conformant implementations MUST observe these invariants:
//
//   • No time-series data.  Every field is an aggregate over the entire
//     duration (mean / percentile / scalar).  No spectrogram, no envelope
//     trace, no momentary LUFS history.
//   • No phase information.
//   • Spectrum is binned at ≤ 1/3-octave resolution (≈ 30 bins for the
//     audible range) — far coarser than perceptual identification needs.
//   • No audio samples stored.
//   • No content fingerprint.  The optional `provenance.sourceFileSha256`
//     is a cache key for re-extraction, NOT a fingerprint, NOT distributed
//     beyond the local cache, and the file content cannot be recovered
//     from the sha256.  Implementations MAY omit it entirely.
//   • No artist / title / album / lyrics fields.  The user may attach a
//     free-form `userLabel` at their own discretion (their property,
//     their responsibility).
//
// A ReferenceProfile is a FACT about a recording (loudness, balance,
// dynamics), not a derivative work or a fingerprint.  See
// docs/redesign/loui-mastering-v2/m1.75/06-REFERENCE-SAFE-LEGAL-GUIDELINE.md.

export const REFERENCE_PROFILE_SCHEMA_ID =
  'https://schemas.loui.studio/reference-profile/v1';
export type ReferenceProfileSchemaId = typeof REFERENCE_PROFILE_SCHEMA_ID;

/** Where this profile came from.  No identifying audio data permitted. */
export interface ReferenceProfileProvenance {
  sourceType: 'user-supplied' | 'fixture' | 'builtin' | 'streaming-snapshot';
  /** ISO timestamp of extraction. */
  createdAt: string;
  /** Duration of the analysed signal in seconds. */
  durationSec: number;
  /** Sample rate of the analysed signal. */
  sampleRate: number;
  /** Channel count of the analysed signal. */
  channels: number;
  /**
   * Optional sha256 of the SOURCE FILE — for cache invalidation only.
   *
   * NOT a fingerprint.  NOT for identification.  NOT to be distributed
   * outside the local cache.  Implementations MAY set this to null.
   */
  sourceFileSha256?: string | null;
  /**
   * Optional user-attached free-form label.  Sole user responsibility —
   * the system never auto-populates artist / title / album.
   */
  userLabel?: string;
  /** Tool that produced the profile (loui/python-audio version, etc.). */
  extractorVersion: string;
}

/** Loudness aggregate. */
export interface ReferenceProfileLoudness {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRange: number;
  /**
   * Distribution of short-term (3-sec window) LUFS values.
   * Percentiles only — NEVER the time-series itself.
   */
  shortTermPercentiles: { p10: number; p50: number; p90: number };
  momentaryPercentiles: { p10: number; p50: number; p90: number };
}

/** Dynamics aggregate. */
export interface ReferenceProfileDynamics {
  /** 20·log10(peak/rms), dB. */
  crestDb: number;
  /**
   * Estimated transient onset density over the full duration, normalised
   * to events per minute.  A scalar — no time-series.
   */
  transientDensityPerMin: number;
  /**
   * Compression score 0..1.  0 = wide dynamic range (>14 LU), 1 = brickwall
   * (LRA ≤ 1).  Derived from LRA + crest + short-term distribution.
   */
  compressionScore: number;
}

/**
 * Time-averaged 1/3-octave spectrum.
 *
 * Keys are the ANSI S1.11 centre frequencies (as strings).  Values are dB
 * relative to a normalised reference (the analyser's chosen window/norm)
 * — they describe SHAPE.  Absolute level is captured separately in
 * `loudness.integratedLufs`.
 */
export type ReferenceProfileSpectrum = Record<string, number>;

/** Tonal aggregate descriptors derived from the time-averaged spectrum. */
export interface ReferenceProfileTonal {
  /** 1/3-oct binned spectrum, time-averaged over the full duration. */
  thirdOctSpectrumDb: ReferenceProfileSpectrum;
  /** Best-fit slope of the spectrum, dB per octave (negative = darker). */
  spectralTiltDbPerOct: number;
  /** Sub-bass energy fraction: [20-100Hz] / total band energy. */
  subEnergyRatio: number;
  /** Low-mid balance: 100-500 Hz band energy in dB relative to total. */
  lowMidBalanceDb: number;
  /** Vocal-region energy: 1000-4000 Hz band energy in dB relative to total. */
  vocalRegionEnergyDb: number;
  /** Air-band energy: 10000 Hz+ band energy in dB relative to total. */
  airBandEnergyDb: number;
  /**
   * Harshness index: 2000-5000 Hz peak excess vs neighbour bands (0..∞).
   * Higher → more harsh.  ~1.0 = balanced, ≥ 3.0 = audibly harsh.
   */
  harshnessIndex: number;
}

/** Stereo / spatial aggregate. */
export interface ReferenceProfileStereo {
  /** Mean L/R correlation across the duration (-1..+1). */
  correlationMean: number;
  /** Mid/Side ratio in dB. */
  msRatioDb: number;
  /**
   * Stereo width index 0..2.  1.0 = baseline.  >1 wider, <1 narrower.
   * Computed from MS ratio and frequency-weighted correlation.
   */
  stereoWidthIndex: number;
}

export interface ReferenceProfileFeatures {
  loudness: ReferenceProfileLoudness;
  dynamics: ReferenceProfileDynamics;
  tonal: ReferenceProfileTonal;
  stereo: ReferenceProfileStereo;
}

export interface ReferenceProfile {
  $schema: ReferenceProfileSchemaId;
  /** Stable slug — caller's choice (never derived from audio content). */
  id: string;
  /** Schema version of this document (semver). */
  version: string;
  provenance: ReferenceProfileProvenance;
  features: ReferenceProfileFeatures;
  /**
   * SHA-256 of the feature object (NOT the source audio).  Used for cache
   * invalidation when feature definitions change.  Safe to share.
   */
  featureFingerprint: string;
}
