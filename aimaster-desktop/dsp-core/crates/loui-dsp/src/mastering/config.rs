//! Mastering chain configuration.
//!
//! Mirrors the product UI's renderable parameters.  Values are in UI
//! space where noted (e.g. `width_pct` is 0..200, not 0..2.0) so the
//! mapping from the parameter state is 1:1 — the chain does the
//! conversion internally.
//!
//! Field names map 1:1 to the documented UI parameters; per-field doc
//! comments are omitted where the name + the parameter audit suffice.
//! # Serialisation
//!
//! With the `serde` feature the config types deserialise from camelCase
//! JSON, with `#[serde(default)]` on every struct.  That is what lets the
//! WASM binding accept a partial config object: a host that only knows
//! about the modules it uses sends those, and everything else falls back to
//! its neutral default rather than failing to parse.
#![allow(missing_docs)]

#[cfg(feature = "serde")]
use serde::Deserialize;

use super::parametric_eq::{ParametricBand, MAX_PARAMETRIC_BANDS};

/// Deserialise a band list into a fixed-size array, padding the tail with
/// neutral defaults.
///
/// A host almost never wants to talk about every band — it wants to enable
/// band 0 and leave the rest alone.  Serde's array impl demands the exact
/// length, so this accepts any shorter list (and ignores a longer one's
/// surplus) rather than failing the whole config.
#[cfg(feature = "serde")]
fn de_padded_bands<'de, D, T, const N: usize>(d: D) -> Result<[T; N], D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default + Copy,
{
    let list: Vec<T> = Vec::deserialize(d)?;
    let mut out = [T::default(); N];
    for (slot, item) in out.iter_mut().zip(list.into_iter()) {
        *slot = item;
    }
    Ok(out)
}

// ── Restoration ──────────────────────────────────────────────────────────

/// Spectral broadband de-noise parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
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
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
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
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
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
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
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

// ── Dynamic EQ ───────────────────────────────────────────────────────────

/// Filter shape for one dynamic-EQ band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum DynEqBandShape {
    Bell,
    LowShelf,
    HighShelf,
}

/// Which direction a dynamic-EQ band moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum DynEqMode {
    /// Cut when the band exceeds the threshold.
    Down,
    /// Boost when the band falls below the threshold.
    Up,
}

/// One dynamic-EQ band.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct DynEqBandConfig {
    pub enabled: bool,
    pub shape: DynEqBandShape,
    pub mode: DynEqMode,
    pub frequency_hz: f64,
    pub q: f64,
    pub threshold_db: f64,
    pub ratio: f64,
    /// Maximum move (dB, ≥ 0).  0 = the band does nothing.
    pub range_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
}

impl Default for DynEqBandConfig {
    fn default() -> Self {
        Self {
            enabled: false, shape: DynEqBandShape::Bell, mode: DynEqMode::Down,
            frequency_hz: 1_000.0, q: 1.0, threshold_db: -24.0, ratio: 3.0,
            range_db: 6.0, attack_ms: 10.0, release_ms: 120.0,
        }
    }
}

/// Dynamic EQ parameters — six independent bands.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct DynamicEqConfig {
    #[cfg_attr(feature = "serde", serde(deserialize_with = "de_padded_bands"))]
    pub bands: [DynEqBandConfig; 6],
    pub bypass: bool,
}

impl Default for DynamicEqConfig {
    fn default() -> Self {
        Self { bands: [DynEqBandConfig::default(); 6], bypass: false }
    }
}

// ── Multiband dynamics ───────────────────────────────────────────────────

/// Direction a multiband band operates in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum MultibandMode {
    /// Reduce level above the threshold.
    Compress,
    /// Reduce level below the threshold (downward expansion).
    Expand,
}

/// One band of the multiband dynamics processor.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct MultibandBandConfig {
    pub mode: MultibandMode,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
    /// Maximum gain reduction (dB, ≥ 0).
    pub range_db: f64,
    /// Parallel mix 0..100 (% wet).
    pub mix_pct: f64,
    pub solo: bool,
    pub mute: bool,
    pub bypass: bool,
}

impl Default for MultibandBandConfig {
    fn default() -> Self {
        Self {
            mode: MultibandMode::Compress, threshold_db: 0.0, ratio: 1.0,
            attack_ms: 10.0, release_ms: 120.0, makeup_db: 0.0, range_db: 24.0,
            mix_pct: 100.0, solo: false, mute: false, bypass: false,
        }
    }
}

/// Multiband dynamics parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct MultibandConfig {
    /// Three crossover points (ascending) splitting the four bands.
    pub crossover_hz: [f64; 3],
    #[cfg_attr(feature = "serde", serde(deserialize_with = "de_padded_bands"))]
    pub bands: [MultibandBandConfig; 4],
    pub bypass: bool,
}

impl Default for MultibandConfig {
    fn default() -> Self {
        Self {
            crossover_hz: [120.0, 800.0, 5_000.0],
            bands: [MultibandBandConfig::default(); 4],
            bypass: false,
        }
    }
}

// ── Exciter ──────────────────────────────────────────────────────────────

/// Harmonic character the exciter generates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum ExciterMode {
    Warm,
    Retro,
    Tape,
    Tube,
    Triode,
}

/// Multiband exciter parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct ExciterConfig {
    pub mode: ExciterMode,
    pub crossover_hz: [f64; 3],
    /// Dry/wet blend per band, 0..100.
    pub band_amount_pct: [f64; 4],
    /// Pre-saturation drive (dB, ≥ 0).
    pub drive_db: f64,
    /// Post-module trim (dB).
    pub output_db: f64,
    pub bypass: bool,
}

impl Default for ExciterConfig {
    fn default() -> Self {
        Self {
            mode: ExciterMode::Tube,
            crossover_hz: [120.0, 800.0, 5_000.0],
            band_amount_pct: [0.0; 4],
            drive_db: 6.0,
            output_db: 0.0,
            bypass: false,
        }
    }
}

// ── Impact ───────────────────────────────────────────────────────────────

/// Multiband transient-shaper parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct ImpactConfig {
    pub crossover_hz: [f64; 3],
    /// Per band: > 0 accentuates attacks, < 0 softens them.  Range -100..100.
    pub impact_pct: [f64; 4],
    pub bypass: bool,
}

impl Default for ImpactConfig {
    fn default() -> Self {
        Self { crossover_hz: [120.0, 800.0, 5_000.0], impact_pct: [0.0; 4], bypass: false }
    }
}

// ── Low End Focus ────────────────────────────────────────────────────────

/// Which way Low End Focus shapes the low band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum LowEndFocusMode {
    /// Accentuate low transients — tighter, more separated.
    Punchy,
    /// Soften low transients — denser, more even.
    Smooth,
}

/// Low End Focus parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct LowEndFocusConfig {
    pub mode: LowEndFocusMode,
    /// Split between the shaped low band and the untouched rest.
    pub frequency_hz: f64,
    /// How hard the contrast is applied, 0..100.
    pub contrast_pct: f64,
    /// Trim on the low band, in dB.
    pub gain_db: f64,
    pub bypass: bool,
}

impl Default for LowEndFocusConfig {
    fn default() -> Self {
        Self {
            mode: LowEndFocusMode::Punchy, frequency_hz: 150.0,
            contrast_pct: 0.0, gain_db: 0.0, bypass: false,
        }
    }
}

// ── Spectral stage (Match EQ / Shaper / Stabilizer / Tonal Balance) ──────

/// Bands in the shared logarithmic curve grid.  Mirrors
/// [`super::spectral::CURVE_BANDS`]; kept here so the config type is
/// self-contained.
pub const SPECTRAL_CURVE_BANDS: usize = 32;

/// Parameters for the shared spectral stage.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct SpectralConfig {
    // Match EQ.
    pub match_enabled: bool,
    /// How much of the source→target difference to apply, 0..100.
    pub match_amount_pct: f64,
    /// Per-band ceiling on the Match EQ move, in dB.
    pub match_max_move_db: f64,
    /// Reference curve, dB per curve band (absolute level is ignored).
    pub target_curve_db: [f64; SPECTRAL_CURVE_BANDS],

    // Spectral Shaper.
    pub shaper_enabled: bool,
    /// How much of the excess to remove, 0..100.
    pub shaper_amount_pct: f64,
    /// How far above its neighbourhood a bin must sit before it is shaped.
    pub shaper_threshold_db: f64,
    /// Low edge of the shaped region, Hz.
    pub shaper_low_hz: f64,
    /// High edge of the shaped region, Hz.
    pub shaper_high_hz: f64,
    /// Half-width, in FFT bins, of the neighbourhood the excess is measured
    /// against.
    pub shaper_blur_bins: u32,

    // Stabilizer.
    pub stabilizer_enabled: bool,
    /// How much of the source→tilt difference to apply, 0..100.
    pub stabilizer_amount_pct: f64,
    /// Target spectral tilt, in dB per octave (negative = darker).
    pub stabilizer_tilt_db_per_oct: f64,
    /// Per-band ceiling on the Stabilizer move, in dB.
    pub stabilizer_max_move_db: f64,

    /// Smoothing applied to the combined correction curve, in bands.
    pub curve_smoothing_bands: u32,
    /// Measure the tonal curve but do not process — drives Tonal Balance
    /// metering when no spectral processing is wanted.
    pub analysis_only: bool,
    pub bypass: bool,
}

impl Default for SpectralConfig {
    fn default() -> Self {
        Self {
            match_enabled: false,
            match_amount_pct: 50.0,
            match_max_move_db: 9.0,
            target_curve_db: [0.0; SPECTRAL_CURVE_BANDS],
            shaper_enabled: false,
            shaper_amount_pct: 50.0,
            shaper_threshold_db: 8.0,
            shaper_low_hz: 1_000.0,
            shaper_high_hz: 16_000.0,
            shaper_blur_bins: 12,
            stabilizer_enabled: false,
            stabilizer_amount_pct: 40.0,
            stabilizer_tilt_db_per_oct: -1.5,
            stabilizer_max_move_db: 6.0,
            curve_smoothing_bands: 2,
            analysis_only: false,
            bypass: false,
        }
    }
}

// ── Vintage suite ────────────────────────────────────────────────────────

/// Passive program EQ parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct VintageEqConfig {
    /// Low shelf frequency (the boost and cut are both referenced to it).
    pub low_frequency_hz: f64,
    /// Low boost (dB, ≥ 0).
    pub low_boost_db: f64,
    /// Low cut (dB, ≥ 0).  Boost and cut together do not cancel.
    pub low_cut_db: f64,
    /// High bell frequency.
    pub high_frequency_hz: f64,
    /// High boost (dB, ≥ 0).
    pub high_boost_db: f64,
    /// High cut (dB, ≥ 0).
    pub high_cut_db: f64,
    /// Bandwidth of the high boost, 0 (narrow) .. 1 (wide).
    pub high_bandwidth: f64,
    pub bypass: bool,
}

impl Default for VintageEqConfig {
    fn default() -> Self {
        Self {
            low_frequency_hz: 60.0, low_boost_db: 0.0, low_cut_db: 0.0,
            high_frequency_hz: 10_000.0, high_boost_db: 0.0, high_cut_db: 0.0,
            high_bandwidth: 0.5, bypass: false,
        }
    }
}

/// Vari-mu compressor parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct VintageCompressorConfig {
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub makeup_db: f64,
    /// How much saturation rides with the gain reduction, 0..100.
    pub character_pct: f64,
    /// Parallel mix 0..100 (% wet).
    pub mix_pct: f64,
    pub bypass: bool,
}

impl Default for VintageCompressorConfig {
    fn default() -> Self {
        Self {
            threshold_db: -18.0, ratio: 1.0, attack_ms: 10.0, makeup_db: 0.0,
            character_pct: 40.0, mix_pct: 100.0, bypass: false,
        }
    }
}

/// Tape transport speed — sets the head bump and HF loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum TapeSpeed {
    /// 7.5 ips — low, strong head bump, early HF roll-off.
    #[cfg_attr(feature = "serde", serde(rename = "7.5ips"))]
    Ips7_5,
    /// 15 ips — the usual mastering speed.
    #[cfg_attr(feature = "serde", serde(rename = "15ips"))]
    Ips15,
    /// 30 ips — tightest low end, most extended top.
    #[cfg_attr(feature = "serde", serde(rename = "30ips"))]
    Ips30,
}

/// Tape emulation parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct VintageTapeConfig {
    pub speed: TapeSpeed,
    /// Record level into the tape (dB, ≥ 0).  Level-matched on output.
    pub drive_db: f64,
    /// Bias, -1 (under) .. +1 (over) — shifts the head bump.
    pub bias: f64,
    /// Wow and flutter depth, 0..100.
    pub wow_flutter_pct: f64,
    /// Dry/wet mix 0..100.
    pub mix_pct: f64,
    pub bypass: bool,
}

impl Default for VintageTapeConfig {
    fn default() -> Self {
        Self {
            speed: TapeSpeed::Ips15, drive_db: 0.0, bias: 0.0,
            wow_flutter_pct: 0.0, mix_pct: 0.0, bypass: false,
        }
    }
}

// ── Dither ───────────────────────────────────────────────────────────────

/// Dither algorithm applied on bit-depth reduction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum DitherMode {
    /// Quantise only — no noise added.  Audibly grainy at 16-bit; useful
    /// for hearing what dither is actually buying you.
    None,
    /// Triangular-PDF noise at ±1 LSB.  The safe default.
    Tpdf,
    /// TPDF plus 2nd-order error feedback, moving noise out of the midrange.
    Shaped,
}

/// Dither + quantiser parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct DitherConfig {
    /// Target bit depth.  32 means float output — the module becomes a
    /// pass-through, because there is no quantisation step to dither.
    pub bit_depth: u32,
    pub mode: DitherMode,
    /// Stop adding noise during digitally silent passages.
    pub auto_blank: bool,
    pub bypass: bool,
}

impl Default for DitherConfig {
    fn default() -> Self {
        // 32-bit float = inactive.  Dither must never appear uninvited: it
        // is the last irreversible step before the file is written.
        Self { bit_depth: 32, mode: DitherMode::Tpdf, auto_blank: true, bypass: false }
    }
}

// ── Monitoring ───────────────────────────────────────────────────────────

/// What the monitor stage sends to the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum MonitorMode {
    /// The chain output — the normal case.
    Processed,
    /// The dry input, delay- and loudness-aligned to the wet.
    Bypass,
    /// Wet minus dry: only what the chain changed.
    Delta,
}

/// Which path the loudness match brings the other one to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum MatchTarget {
    /// Pull the processed path down to the dry level.
    Dry,
    /// Lift the dry path up to the processed level.
    Wet,
}

/// Monitoring parameters.
///
/// A LISTENING tool — loudness matching deliberately changes the output
/// level, and Bypass/Delta are not the master.  The export path never
/// configures this stage.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct MonitorConfig {
    pub mode: MonitorMode,
    /// Level-match the two paths before you hear them.  Without it an A/B
    /// compares makeup gain, not processing.
    pub loudness_match: bool,
    pub match_target: MatchTarget,
    /// Make-up applied to the delta so a small difference is audible.
    pub delta_gain_db: f64,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            mode: MonitorMode::Processed,
            loudness_match: false,
            match_target: MatchTarget::Dry,
            delta_gain_db: 0.0,
        }
    }
}

/// Free parametric EQ — a user-authored band list.
///
/// The band array is fixed-size so the whole config stays `Copy` and the
/// audio thread never sees an allocation; a shorter list from the host is
/// padded with disabled bands by [`de_padded_bands`].
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct ParametricEqConfig {
    /// Bands, in series.  Disabled bands cost nothing.
    #[cfg_attr(feature = "serde", serde(deserialize_with = "de_padded_bands"))]
    pub bands: [ParametricBand; MAX_PARAMETRIC_BANDS],
    /// Module bypass.
    pub bypass: bool,
}

impl Default for ParametricEqConfig {
    fn default() -> Self {
        Self { bands: [ParametricBand::default(); MAX_PARAMETRIC_BANDS], bypass: false }
    }
}

/// Spectral Top Rebuild parameters.
///
/// Defaults are silent: `amount_pct` is 0, so a chain carrying the module
/// without being asked for it is still bit-transparent.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct TopRebuildConfig {
    /// How much of the damaged band is replaced, 0..100 %.  0 = off.
    pub amount_pct: f64,
    /// Where the damage starts, in Hz — everything above is rebuilt.
    pub crossover_hz: f64,
    /// Centre of the healthy band the harmonics are generated from, in Hz.
    pub source_hz: f64,
    /// Odd-harmonic share, 0..100 %.  Higher reaches further up (3× vs 2×).
    pub character_pct: f64,
    /// How tightly the replacement tracks the original band's level, in ms.
    pub follow_ms: f64,
    pub bypass: bool,
}

impl Default for TopRebuildConfig {
    fn default() -> Self {
        Self {
            amount_pct: 0.0,
            crossover_hz: 9_000.0,
            source_hz: 3_000.0,
            character_pct: 60.0,
            follow_ms: 12.0,
            bypass: false,
        }
    }
}

/// Stereo delay parameters.
///
/// Defaults are silent: `mix_pct` is 0, so a chain that carries a delay it
/// was never asked for is still bit-transparent.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct DelayConfig {
    /// Wet blend, 0..100 %.  0 = off.
    pub mix_pct: f64,
    /// Left-channel delay, in ms.
    pub time_ms: f64,
    /// Right channel's offset from the left, −50..50 %.
    pub stereo_offset_pct: f64,
    /// Feedback, 0..100 %.  Clamped below unity by the module.
    pub feedback_pct: f64,
    /// Low-pass in the feedback loop, in Hz — each repeat is darker.
    pub damping_hz: f64,
    /// High-pass in the feedback loop, in Hz — keeps repeats out of the bass.
    pub low_cut_hz: f64,
    /// Route each side's repeats into the other channel.
    pub ping_pong: bool,
    pub bypass: bool,
}

impl Default for DelayConfig {
    fn default() -> Self {
        Self {
            mix_pct: 0.0,
            time_ms: 220.0,
            stereo_offset_pct: 12.0,
            feedback_pct: 25.0,
            damping_hz: 6_000.0,
            low_cut_hz: 300.0,
            ping_pong: false,
            bypass: false,
        }
    }
}

/// Algorithmic reverb parameters.
///
/// Defaults are silent for the same reason as the delay's.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct ReverbConfig {
    /// Wet blend, 0..100 %.  On a master this belongs near 2–8.
    pub mix_pct: f64,
    /// Room size, 0..100 % — drives the decay length.
    pub size_pct: f64,
    /// High-frequency damping, 0..100 % — how fast the top of the tail goes.
    pub damping_pct: f64,
    /// Stereo width of the tail, 0..100 %.  100 = as wide as the algorithm.
    pub width_pct: f64,
    /// Gap before the tail starts, in ms — keeps the transient dry.
    pub pre_delay_ms: f64,
    /// High-pass on the wet path, in Hz — keeps the tail out of the bass.
    pub low_cut_hz: f64,
    pub bypass: bool,
}

impl Default for ReverbConfig {
    fn default() -> Self {
        Self {
            mix_pct: 0.0,
            size_pct: 55.0,
            damping_pct: 50.0,
            width_pct: 100.0,
            pre_delay_ms: 20.0,
            low_cut_hz: 250.0,
            bypass: false,
        }
    }
}

/// EQ (gentle tone shaping) parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
/// Frequency + Q are per-band, not constants, so a graph editor can drag a
/// band anywhere instead of only up and down.  The defaults are the classic
/// fixed layout (120 Hz / 3 kHz / 12 kHz), which is what a config that omits
/// them still gets — an older wire message keeps its old meaning.
pub struct EqConfig {
    /// High-pass cutoff (Hz).  20 ≈ off.
    pub low_cut_hz: f64,
    /// High-pass Q.  0.707 is Butterworth; above ~1 puts a bump at the corner.
    pub low_cut_q: f64,
    /// Low-shelf corner (Hz).
    pub low_shelf_hz: f64,
    /// Low-shelf gain (dB).
    pub low_shelf_db: f64,
    /// Low-shelf slope.
    pub low_shelf_q: f64,
    /// Presence bell centre (Hz).
    pub presence_hz: f64,
    /// Presence bell gain (dB).
    pub presence_db: f64,
    /// Presence bell Q.
    pub presence_q: f64,
    /// Air high-shelf corner (Hz).
    pub air_hz: f64,
    /// Air high-shelf gain (dB).
    pub air_db: f64,
    /// Air high-shelf slope.
    pub air_q: f64,
    /// Gentle harshness control (the "adaptive" flag) — a small 3-5 kHz dip.
    pub adaptive: bool,
    /// Module bypass.
    pub bypass: bool,
}

impl Default for EqConfig {
    fn default() -> Self {
        Self {
            low_cut_hz: 20.0,   low_cut_q: 0.707,
            low_shelf_hz: 120.0, low_shelf_db: 0.0, low_shelf_q: 0.707,
            presence_hz: 3000.0, presence_db: 0.0,  presence_q: 1.1,
            air_hz: 12_000.0,    air_db: 0.0,       air_q: 0.707,
            adaptive: false, bypass: false,
        }
    }
}

/// Single-band glue compressor parameters.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
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
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct ImagerConfig {
    /// Width as a percentage: 0 = mono, 100 = unchanged, 200 = extra wide.
    pub width_pct: f64,
    /// Sum to mono below this frequency (Hz).
    pub low_mono_hz: f64,
    /// Per-band width (%), low → high.  All 100 = the band splitter is
    /// skipped entirely and the module stays bit-transparent at width 100.
    pub band_width_pct: [f64; 4],
    /// Crossover points for the per-band widths.
    pub crossover_hz: [f64; 3],
    pub bypass: bool,
}

impl Default for ImagerConfig {
    fn default() -> Self {
        Self {
            width_pct: 100.0, low_mono_hz: 20.0,
            band_width_pct: [100.0; 4], crossover_hz: [120.0, 800.0, 5_000.0],
            bypass: false,
        }
    }
}

/// Lookahead true-peak-safe limiter parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase"))]
pub enum LimiterCharacter {
    /// Neutral release, no soft clip — the safety limiter.
    Clean,
    /// Slowest release, gentlest — least audible on dense material.
    Transparent,
    /// Fast release with a touch of soft clip — keeps attacks forward.
    Punchy,
    /// Slow release, no clip — glues and rides level.
    Smooth,
    /// Fastest release with real soft clip — maximum loudness.
    Aggressive,
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct LimiterConfig {
    /// Ceiling in dBTP (sample-peak approximation in preview).
    pub ceiling_dbtp: f64,
    /// Lookahead in milliseconds.
    pub lookahead_ms: f64,
    /// True-peak (inter-sample) guard — adds a small extra headroom.
    pub isp: bool,
    /// Gain driven into the limiter, in dB — the maximizer's "how loud".
    pub drive_db: f64,
    /// Release behaviour and soft-clip amount.
    pub character: LimiterCharacter,
    pub bypass: bool,
}

impl Default for LimiterConfig {
    fn default() -> Self {
        Self {
            ceiling_dbtp: -1.0, lookahead_ms: 2.5, isp: true,
            drive_db: 0.0, character: LimiterCharacter::Clean, bypass: false,
        }
    }
}

/// Loudness target — automatic gain toward an integrated-loudness figure.
///
/// Disabled by default so a config that does not mention it is unchanged.
/// The chain enables it when the UI asks for a target.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct LoudnessConfig {
    /// Whether the loop runs at all.
    pub enabled: bool,
    /// Integrated loudness to aim for, in LUFS.
    pub target_lufs: f64,
    /// Most the loop may add, in dB.
    pub max_boost_db: f64,
    /// Most the loop may take away, in dB.
    pub max_cut_db: f64,
    /// How fast the gain moves, in milliseconds.  Seconds, not
    /// milliseconds: anything quick enough to hear reacting is a
    /// compressor, and would flatten the song's own dynamics.
    pub speed_ms: f64,
    pub bypass: bool,
}

impl Default for LoudnessConfig {
    fn default() -> Self {
        Self {
            enabled: false, target_lufs: -14.0,
            max_boost_db: 18.0, max_cut_db: 18.0,
            speed_ms: 3_000.0, bypass: false,
        }
    }
}

/// Full mastering-chain configuration.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(Deserialize), serde(rename_all = "camelCase", default))]
pub struct MasteringChainConfig {
    /// Input gain (dB) applied before the chain.
    pub input_gain_db: f64,
    // Restoration.
    pub declick: DeclickConfig,
    pub dehum: DehumConfig,
    pub denoise: DenoiseConfig,
    pub deess: DeessConfig,
    /// Rebuilds a codec-damaged top end.  Restoration, so it runs before
    /// any tonal decision is made on what it produces.
    pub top_rebuild: TopRebuildConfig,
    // Corrective / spectral.
    pub parametric_eq: ParametricEqConfig,
    pub spectral: SpectralConfig,
    // Tone.
    pub vintage_eq: VintageEqConfig,
    pub eq: EqConfig,
    pub dynamic_eq: DynamicEqConfig,
    // Dynamics.
    pub multiband: MultibandConfig,
    pub dynamics: DynamicsConfig,
    pub vintage_comp: VintageCompressorConfig,
    pub impact: ImpactConfig,
    pub low_end_focus: LowEndFocusConfig,
    // Character.
    pub exciter: ExciterConfig,
    pub tape: VintageTapeConfig,
    // Space.  After character, before the imager: the imager should widen
    // the finished picture, tails included, not a dry mix that later grows
    // a tail of its own width.
    pub delay: DelayConfig,
    pub reverb: ReverbConfig,
    // Stereo + output.
    pub imager: ImagerConfig,
    pub limiter: LimiterConfig,
    /// Loudness target — automatic gain toward an integrated-LUFS figure.
    pub loudness: LoudnessConfig,
    /// Dither + quantisation — the last stage, after the output gain.
    pub dither: DitherConfig,
    /// Monitoring (A/B + delta).  Listening only — never set on an export.
    pub monitor: MonitorConfig,
    /// Output gain (dB) applied after the chain.
    pub output_gain_db: f64,
    /// Master bypass — entire chain becomes a pass-through.
    pub bypass: bool,
}

impl Default for MasteringChainConfig {
    fn default() -> Self {
        Self {
            input_gain_db: 0.0,
            declick: DeclickConfig::default(),
            dehum: DehumConfig::default(),
            denoise: DenoiseConfig::default(),
            deess: DeessConfig::default(),
            top_rebuild: TopRebuildConfig::default(),
            parametric_eq: ParametricEqConfig::default(),
            spectral: SpectralConfig::default(),
            vintage_eq: VintageEqConfig::default(),
            eq: EqConfig::default(),
            dynamic_eq: DynamicEqConfig::default(),
            multiband: MultibandConfig::default(),
            dynamics: DynamicsConfig::default(),
            vintage_comp: VintageCompressorConfig::default(),
            impact: ImpactConfig::default(),
            low_end_focus: LowEndFocusConfig::default(),
            exciter: ExciterConfig::default(),
            tape: VintageTapeConfig::default(),
            delay: DelayConfig::default(),
            reverb: ReverbConfig::default(),
            imager: ImagerConfig::default(),
            limiter: LimiterConfig::default(),
            loudness: LoudnessConfig::default(),
            dither: DitherConfig::default(),
            monitor: MonitorConfig::default(),
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
