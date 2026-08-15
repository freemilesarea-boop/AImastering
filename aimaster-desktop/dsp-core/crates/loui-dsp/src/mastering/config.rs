//! Mastering chain configuration.
//!
//! Mirrors the product UI's renderable parameters.  Values are in UI
//! space where noted (e.g. `width_pct` is 0..200, not 0..2.0) so the
//! mapping from the parameter state is 1:1 — the chain does the
//! conversion internally.
//!
//! Field names map 1:1 to the documented UI parameters; per-field doc
//! comments are omitted where the name + the parameter audit suffice.
#![allow(missing_docs)]

// ── Restoration ──────────────────────────────────────────────────────────

/// Spectral broadband de-noise parameters.
#[derive(Debug, Clone, Copy)]
pub struct DenoiseConfig {
    /// Maximum attenuation applied to the noise floor (dB, ≥ 0).  0 = off.
    pub reduction_db: f64,
    /// Offset applied to the learned noise floor before masking (dB).
    /// Positive = treat more of the signal as noise (more aggressive).
    pub threshold_db: f64,
    /// Mask exponent.  1.0 = plain Wiener; higher cuts harder.
    pub sharpness: f64,
    /// Per-bin time smoothing 0..0.95 — higher suppresses musical noise.
    pub smoothing: f64,
    /// Half-width (in bins) of the spectral blur applied to the mask.
    pub freq_smoothing_bins: u32,
    /// Track the noise floor continuously instead of using a learned profile.
    pub auto_profile: bool,
    pub bypass: bool,
}

impl Default for DenoiseConfig {
    fn default() -> Self {
        Self {
            reduction_db: 0.0, threshold_db: 0.0, sharpness: 1.0, smoothing: 0.6,
            freq_smoothing_bins: 2, auto_profile: true, bypass: false,
        }
    }
}

/// Mains-hum removal parameters.
#[derive(Debug, Clone, Copy)]
pub struct DehumConfig {
    /// Mains fundamental (50 or 60 Hz, or a measured value).
    pub frequency_hz: f64,
    /// Harmonics to notch, including the fundamental (1..=12).
    pub harmonics: u32,
    /// Notch depth (dB, ≥ 0).  0 = off.
    pub depth_db: f64,
    /// Notch Q — higher is narrower, taking less music with the hum.
    pub q: f64,
    /// Scale each notch by how hum-like that partial actually is.
    pub adaptive: bool,
    pub bypass: bool,
}

impl Default for DehumConfig {
    fn default() -> Self {
        Self { frequency_hz: 60.0, harmonics: 6, depth_db: 0.0, q: 30.0, adaptive: true, bypass: false }
    }
}

/// Click / crackle removal parameters.
#[derive(Debug, Clone, Copy)]
pub struct DeclickConfig {
    /// How far above the local level a sample must sit to count as a click.
    pub sensitivity: f64,
    /// Longest defect the repairer interpolates across, in samples.
    pub max_run_samples: u32,
    pub bypass: bool,
}

impl Default for DeclickConfig {
    fn default() -> Self {
        Self { sensitivity: 6.0, max_run_samples: 16, bypass: true }
    }
}

/// De-esser parameters.
#[derive(Debug, Clone, Copy)]
pub struct DeessConfig {
    /// Split frequency between the untouched low band and the ducked band.
    pub frequency_hz: f64,
    /// Detector threshold (dBFS).
    pub threshold_db: f64,
    /// Compression ratio applied above the threshold.
    pub ratio: f64,
    /// Maximum attenuation (dB, ≥ 0).  0 = off.
    pub range_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    /// Duck the whole signal instead of only the high band.
    pub wideband: bool,
    pub bypass: bool,
}

impl Default for DeessConfig {
    fn default() -> Self {
        Self {
            frequency_hz: 6_500.0, threshold_db: -30.0, ratio: 4.0, range_db: 0.0,
            attack_ms: 1.0, release_ms: 60.0, wideband: false, bypass: false,
        }
    }
}

/// EQ (gentle tone shaping) parameters.
#[derive(Debug, Clone, Copy)]
pub struct EqConfig {
    /// High-pass cutoff (Hz).  20 ≈ off.
    pub low_cut_hz: f64,
    /// Low-shelf gain (dB) at 120 Hz.
    pub low_shelf_db: f64,
    /// Presence peak gain (dB) at 3 kHz.
    pub presence_db: f64,
    /// Air high-shelf gain (dB) at 12 kHz.
    pub air_db: f64,
    /// Gentle harshness control (the "adaptive" flag) — a small 3-5 kHz dip.
    pub adaptive: bool,
    /// Module bypass.
    pub bypass: bool,
}

impl Default for EqConfig {
    fn default() -> Self {
        Self { low_cut_hz: 20.0, low_shelf_db: 0.0, presence_db: 0.0, air_db: 0.0, adaptive: false, bypass: false }
    }
}

/// Single-band glue compressor parameters.
#[derive(Debug, Clone, Copy)]
pub struct DynamicsConfig {
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    /// Parallel mix 0..100 (% wet).
    pub mix_pct: f64,
    pub bypass: bool,
}

impl Default for DynamicsConfig {
    fn default() -> Self {
        Self { threshold_db: 0.0, ratio: 1.0, attack_ms: 10.0, release_ms: 120.0, mix_pct: 100.0, bypass: false }
    }
}

/// Stereo imager parameters.
#[derive(Debug, Clone, Copy)]
pub struct ImagerConfig {
    /// Width as a percentage: 0 = mono, 100 = unchanged, 200 = extra wide.
    pub width_pct: f64,
    /// Sum to mono below this frequency (Hz).
    pub low_mono_hz: f64,
    pub bypass: bool,
}

impl Default for ImagerConfig {
    fn default() -> Self {
        Self { width_pct: 100.0, low_mono_hz: 20.0, bypass: false }
    }
}

/// Lookahead true-peak-safe limiter parameters.
#[derive(Debug, Clone, Copy)]
pub struct LimiterConfig {
    /// Ceiling in dBTP (sample-peak approximation in preview).
    pub ceiling_dbtp: f64,
    /// Lookahead in milliseconds.
    pub lookahead_ms: f64,
    /// True-peak (inter-sample) guard — adds a small extra headroom.
    pub isp: bool,
    pub bypass: bool,
}

impl Default for LimiterConfig {
    fn default() -> Self {
        Self { ceiling_dbtp: -1.0, lookahead_ms: 2.5, isp: true, bypass: false }
    }
}

/// Full mastering-chain configuration.
#[derive(Debug, Clone, Copy)]
pub struct MasteringChainConfig {
    /// Input gain (dB) applied before the chain.
    pub input_gain_db: f64,
    pub eq: EqConfig,
    pub dynamics: DynamicsConfig,
    pub imager: ImagerConfig,
    pub limiter: LimiterConfig,
    /// Output gain (dB) applied after the chain.
    pub output_gain_db: f64,
    /// Master bypass — entire chain becomes a pass-through.
    pub bypass: bool,
}

impl Default for MasteringChainConfig {
    fn default() -> Self {
        Self {
            input_gain_db: 0.0,
            eq: EqConfig::default(),
            dynamics: DynamicsConfig::default(),
            imager: ImagerConfig::default(),
            limiter: LimiterConfig::default(),
            output_gain_db: 0.0,
            bypass: false,
        }
    }
}

/// Convert dB to a linear amplitude factor.
#[inline]
pub(crate) fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}
