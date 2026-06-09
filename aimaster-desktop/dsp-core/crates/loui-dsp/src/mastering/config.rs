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

/// Stereo imager parameters (single-band width + low-mono, plus an optional
/// 4-band M/S width mode).
#[derive(Debug, Clone, Copy)]
pub struct ImagerConfig {
    /// Width as a percentage: 0 = mono, 100 = unchanged, 200 = extra wide.
    /// Used when `multiband_enabled` is false.
    pub width_pct: f64,
    /// Sum to mono below this frequency (Hz).
    pub low_mono_hz: f64,
    pub bypass: bool,
    /// When true, apply per-band Side width instead of the single `width_pct`.
    pub multiband_enabled: bool,
    /// Per-band Side width %, [low, low-mid, high-mid, high].  100 = unchanged.
    pub band_widths_pct: [f64; 4],
    /// Crossover frequencies for the 4-band M/S split (Hz).
    pub xover_lo_hz: f64,
    pub xover_mid_hz: f64,
    pub xover_hi_hz: f64,
}

impl Default for ImagerConfig {
    fn default() -> Self {
        Self {
            width_pct: 100.0,
            low_mono_hz: 20.0,
            bypass: false,
            multiband_enabled: false,
            band_widths_pct: [100.0; 4],
            xover_lo_hz: 120.0,
            xover_mid_hz: 1000.0,
            xover_hi_hz: 6000.0,
        }
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

/// One band of the 4-band multiband compressor.
#[derive(Debug, Clone, Copy)]
pub struct MultibandBandConfig {
    pub threshold_db: f64,
    /// Compression ratio.  1.0 = no compression (clean passthrough).
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    /// Per-band makeup gain (dB) applied after compression.
    pub makeup_db: f64,
}

impl Default for MultibandBandConfig {
    fn default() -> Self {
        // ratio 1.0 + 0 dB makeup → the band is a bit-exact passthrough.
        Self { threshold_db: -24.0, ratio: 1.0, attack_ms: 20.0, release_ms: 150.0, makeup_db: 0.0 }
    }
}

/// 4-band multiband compressor parameters.
///
/// Three crossover frequencies split the signal into low / low-mid /
/// high-mid / high.  Defaults to `bypass: true` with unity bands, so the
/// stage is a no-op until the UI/preset explicitly enables it.
#[derive(Debug, Clone, Copy)]
pub struct MultibandConfig {
    /// Low | low-mid crossover (Hz).
    pub xover_lo_hz: f64,
    /// Low-mid | high-mid crossover (Hz).
    pub xover_mid_hz: f64,
    /// High-mid | high crossover (Hz).
    pub xover_hi_hz: f64,
    /// Per-band settings: [low, low-mid, high-mid, high].
    pub bands: [MultibandBandConfig; 4],
    pub bypass: bool,
}

impl Default for MultibandConfig {
    fn default() -> Self {
        Self {
            xover_lo_hz: 120.0,
            xover_mid_hz: 1000.0,
            xover_hi_hz: 6000.0,
            bands: [MultibandBandConfig::default(); 4],
            bypass: true,
        }
    }
}

/// Saturation / exciter character (waveshaper family).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaturationCharacter {
    /// Gentle soft saturation (few harmonics).
    Warm,
    /// Smooth odd harmonics (tanh).
    Tape,
    /// Asymmetric — even + odd harmonics (DC-blocked).
    Tube,
    /// Harder odd soft-clip.
    Modern,
}

impl Default for SaturationCharacter {
    fn default() -> Self {
        SaturationCharacter::Tape
    }
}

/// Saturation / exciter parameters.  `drive`/`mix_pct` are percentages.
/// Default = bypassed, drive 0 → no-op until enabled.
#[derive(Debug, Clone, Copy)]
pub struct SaturationConfig {
    pub bypass: bool,
    pub character: SaturationCharacter,
    /// Drive 0..100 (% → pre-gain into the shaper).  0 = clean passthrough.
    pub drive: f64,
    /// Dry/wet mix 0..100 (% wet).
    pub mix_pct: f64,
    /// When true, scale drive per band via `band_drives_pct`.
    pub multiband_enabled: bool,
    /// Per-band drive scaling %, [low, low-mid, high-mid, high].
    pub band_drives_pct: [f64; 4],
    pub xover_lo_hz: f64,
    pub xover_mid_hz: f64,
    pub xover_hi_hz: f64,
}

impl Default for SaturationConfig {
    fn default() -> Self {
        Self {
            bypass: true,
            character: SaturationCharacter::default(),
            drive: 0.0,
            mix_pct: 100.0,
            multiband_enabled: false,
            band_drives_pct: [100.0; 4],
            xover_lo_hz: 120.0,
            xover_mid_hz: 1000.0,
            xover_hi_hz: 6000.0,
        }
    }
}

/// Full mastering-chain configuration.
#[derive(Debug, Clone, Copy)]
pub struct MasteringChainConfig {
    /// Input gain (dB) applied before the chain.
    pub input_gain_db: f64,
    pub eq: EqConfig,
    pub dynamics: DynamicsConfig,
    /// 4-band multiband compressor (after the glue compressor; off by default).
    pub multiband: MultibandConfig,
    /// Saturation / exciter (after the multiband comp; off by default).
    pub saturation: SaturationConfig,
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
            multiband: MultibandConfig::default(),
            saturation: SaturationConfig::default(),
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
