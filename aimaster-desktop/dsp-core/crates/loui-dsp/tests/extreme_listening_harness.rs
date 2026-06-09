//! Extreme-value DSP verification harness.
//!
//! A headless, objective stand-in for "listening tests": it runs the REAL
//! `MasteringChain` with the exact extreme parameter values a tester would
//! dial in, then MEASURES the output (band energy, RMS, peak, stereo
//! mid/side ratio, gain reduction) and asserts the response goes the
//! direction a listener would hear.  No audio device required; the numbers
//! prove the modules actually change the signal.

use loui_dsp::mastering::{
    MasteringChain, MasteringChainConfig, EqConfig, DynamicsConfig, ImagerConfig, LimiterConfig,
};

const SR: f64 = 48_000.0;
const N: usize = 48_000; // 1 s
const BLOCK: usize = 128;

/// Goertzel single-bin power at frequency `f` (relative energy units).
fn band_power(samples: &[f32], f: f64) -> f64 {
    let k = (samples.len() as f64 * f / SR).round();
    let w = 2.0 * std::f64::consts::PI * k / samples.len() as f64;
    let coeff = 2.0 * w.cos();
    let (mut s_prev, mut s_prev2) = (0.0f64, 0.0f64);
    for &x in samples {
        let s = x as f64 + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }
    s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
}

fn rms(samples: &[f32]) -> f64 {
    let sum: f64 = samples.iter().map(|&x| (x as f64) * (x as f64)).sum();
    (sum / samples.len() as f64).sqrt()
}

fn peak(samples: &[f32]) -> f64 {
    samples.iter().fold(0.0f64, |m, &x| m.max((x as f64).abs()))
}

fn db(ratio: f64) -> f64 {
    20.0 * ratio.max(1e-12).log10()
}

fn sine(freq: f64, amp: f64, n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / SR).sin()) as f32)
        .collect()
}

/// Mix of low/mid/high tones for broadband EQ probing (incl. a tone above
/// the 12 kHz air-shelf corner so the shelf's rising shape is observable).
fn broadband(amp: f64, n: usize) -> Vec<f32> {
    let lo = sine(60.0, amp, n);
    let mid = sine(1_000.0, amp, n);
    let hi = sine(12_000.0, amp, n);
    let air = sine(18_000.0, amp, n);
    (0..n).map(|i| lo[i] + mid[i] + hi[i] + air[i]).collect()
}

/// Run the chain over a full signal, block by block (mirrors the worklet's
/// 128-sample quanta), returning processed (L, R).
fn run(cfg: MasteringChainConfig, left_in: &[f32], right_in: &[f32]) -> (Vec<f32>, Vec<f32>, MasteringChain) {
    let mut chain = MasteringChain::new(SR, cfg);
    let mut l = left_in.to_vec();
    let mut r = right_in.to_vec();
    let mut i = 0;
    while i < l.len() {
        let end = (i + BLOCK).min(l.len());
        let (lc, rc) = (l[i..end].to_vec(), r[i..end].to_vec());
        let mut lb = lc.clone();
        let mut rb = rc.clone();
        chain.process_stereo_block(&mut lb, &mut rb);
        l[i..end].copy_from_slice(&lb);
        r[i..end].copy_from_slice(&rb);
        i = end;
    }
    (l, r, chain)
}

/// Base config with EVERYTHING transparent so a single module can be
/// isolated.  Dynamics ratio 1:1 + limiter bypass = pure unity unless the
/// module under test changes it.
fn transparent() -> MasteringChainConfig {
    MasteringChainConfig {
        input_gain_db: 0.0,
        eq: EqConfig { low_cut_hz: 10.0, low_shelf_db: 0.0, presence_db: 0.0, air_db: 0.0, adaptive: false, bypass: false },
        dynamics: DynamicsConfig { threshold_db: 0.0, ratio: 1.0, attack_ms: 10.0, release_ms: 120.0, mix_pct: 100.0, bypass: true },
        imager: ImagerConfig { width_pct: 100.0, low_mono_hz: 20.0, bypass: false },
        limiter: LimiterConfig { ceiling_dbtp: -1.0, lookahead_ms: 2.5, isp: true, bypass: true },
        output_gain_db: 0.0,
        bypass: false,
        ..MasteringChainConfig::default()
    }
}

#[test]
fn extreme_value_listening_report() {
    println!("\n=== EXTREME-VALUE DSP MEASUREMENT (headless listening proxy) ===");
    println!("signal: blocks of {BLOCK} @ {SR} Hz, 1 s\n");
    let mut failures = 0;
    let mut check = |name: &str, pass: bool, detail: String| {
        println!("[{}] {} — {}", if pass { "PASS" } else { "FAIL" }, name, detail);
        if !pass { failures += 1; }
    };

    // 1) EQ High Shelf (Air) +24 dB → highs lifted strongly.  12 kHz is the
    //    shelf CORNER (≈ half-gain, ~+12 dB for a +24 dB shelf); above it the
    //    response rises toward the full +24 dB, so 18 kHz must be boosted
    //    MORE than 12 kHz — proving a real rising air shelf, not a fixed gain.
    {
        let sig = broadband(0.1, N);
        let (b12, b18) = (band_power(&sig, 12_000.0), band_power(&sig, 18_000.0));
        let mut cfg = transparent();
        cfg.eq.air_db = 24.0;
        let (l, _r, _) = run(cfg, &sig, &sig);
        let d12 = db((band_power(&l, 12_000.0) / b12).sqrt());
        let d18 = db((band_power(&l, 18_000.0) / b18).sqrt());
        check(
            "EQ Air +24dB (high shelf)",
            d12 > 9.0 && d18 > d12,
            format!("Δ12kHz = {:+.1} dB (corner), Δ18kHz = {:+.1} dB (rising → asymptote)", d12, d18),
        );
    }

    // 2) EQ Low Shelf -24 dB → 60 Hz energy way down.
    {
        let sig = broadband(0.1, N);
        let before = band_power(&sig, 60.0);
        let mut cfg = transparent();
        cfg.eq.low_shelf_db = -24.0;
        let (l, _r, _) = run(cfg, &sig, &sig);
        let after = band_power(&l, 60.0);
        let d = db((after / before).sqrt());
        check("EQ Low Shelf -24dB (60 Hz)", d < -10.0, format!("Δ60Hz = {:+.1} dB (expect ≪0)", d));
    }

    // 3) Output Gain -24 dB → overall RMS down ~24 dB (limiter bypassed,
    //    quiet signal so nothing else engages).
    {
        let sig = sine(1_000.0, 0.1, N);
        let before = rms(&sig);
        let mut cfg = transparent();
        cfg.output_gain_db = -24.0;
        let (l, _r, _) = run(cfg, &sig, &sig);
        let after = rms(&l);
        let d = db(after / before);
        check("Output Gain -24dB", (d + 24.0).abs() < 1.0, format!("ΔRMS = {:+.1} dB (expect ≈ -24)", d));
    }

    // 4) Stereo Width 0% → side energy collapses (mono-ish).
    //    Decorrelated L/R so there IS side energy to remove.
    {
        let l_in = sine(1_000.0, 0.1, N);
        let r_in = sine(1_500.0, 0.1, N); // different tone → strong side
        let side_in = rms(&l_in.iter().zip(&r_in).map(|(a, b)| (a - b) * 0.5).collect::<Vec<f32>>());
        let mut cfg = transparent();
        cfg.imager.width_pct = 0.0;
        let (l, r, _) = run(cfg, &l_in, &r_in);
        let side_out = rms(&l.iter().zip(&r).map(|(a, b)| (a - b) * 0.5).collect::<Vec<f32>>());
        let d = db(side_out / side_in);
        check("Stereo Width 0% (side energy)", d < -20.0, format!("ΔSide = {:+.1} dB (expect ≪0, →mono)", d));
    }

    // 5) Stereo Width 200% → side energy increases.
    {
        let l_in = sine(1_000.0, 0.1, N);
        let r_in = sine(1_500.0, 0.1, N);
        let side_in = rms(&l_in.iter().zip(&r_in).map(|(a, b)| (a - b) * 0.5).collect::<Vec<f32>>());
        let mut cfg = transparent();
        cfg.imager.width_pct = 200.0;
        let (l, r, _) = run(cfg, &l_in, &r_in);
        let side_out = rms(&l.iter().zip(&r).map(|(a, b)| (a - b) * 0.5).collect::<Vec<f32>>());
        let d = db(side_out / side_in);
        check("Stereo Width 200% (side energy)", d > 3.0, format!("ΔSide = {:+.1} dB (expect >0, wider)", d));
    }

    // 6) Dynamics Threshold -40 dB / Ratio 20:1 on a loud signal → real
    //    gain reduction + reduced output level vs unity.
    {
        let sig = sine(1_000.0, 0.5, N); // ~ -6 dBFS, well above -40 dB
        let unity_rms = rms(&sig);
        let mut cfg = transparent();
        cfg.dynamics.bypass = false;
        cfg.dynamics.threshold_db = -40.0;
        cfg.dynamics.ratio = 20.0;
        cfg.dynamics.attack_ms = 1.0;
        let (l, _r, chain) = run(cfg, &sig, &sig);
        let after = rms(&l);
        let gr = chain.gain_reduction().dynamics_db;
        let leveled = db(after / unity_rms);
        check(
            "Dynamics -40dB/20:1",
            gr > 5.0 && leveled < -3.0,
            format!("GR = {:.1} dB, ΔRMS = {:+.1} dB (expect heavy compression)", gr, leveled),
        );
    }

    // 7) Limiter Ceiling -6 dB → output peak clamped at/under ceiling.
    {
        let sig = sine(1_000.0, 0.95, N); // hot, ~ -0.4 dBFS
        let mut cfg = transparent();
        cfg.limiter.bypass = false;
        cfg.limiter.ceiling_dbtp = -6.0;
        let (l, _r, _) = run(cfg, &sig, &sig);
        let pk = db(peak(&l));
        check("Limiter Ceiling -6dB", pk <= -5.0, format!("output peak = {:.1} dBFS (expect ≤ ~-6)", pk));
    }

    // 8) Bypass ON vs OFF → bypass must equal dry input; active must differ.
    {
        let sig = broadband(0.1, N);
        let mut active = transparent();
        active.eq.air_db = 12.0;
        active.output_gain_db = -6.0;
        let (la, _ra, _) = run(active, &sig, &sig);
        let mut byp = active;
        byp.bypass = true;
        let (lb, _rb, _) = run(byp, &sig, &sig);
        let bypass_err = db(rms(&lb.iter().zip(&sig).map(|(a, b)| a - b).collect::<Vec<f32>>()) / rms(&sig).max(1e-9));
        let active_diff = db(rms(&la.iter().zip(&sig).map(|(a, b)| a - b).collect::<Vec<f32>>()) / rms(&sig));
        check(
            "Bypass ON == dry input",
            bypass_err < -120.0,
            format!("bypass residual = {:.0} dB (expect ≪, bit-identical)", bypass_err),
        );
        check(
            "Bypass OFF != dry input",
            active_diff > -40.0,
            format!("active residual = {:+.1} dB (expect audible difference)", active_diff),
        );
    }

    println!("\n=== {} ===\n", if failures == 0 { "ALL MEASUREMENTS PASS".to_string() } else { format!("{failures} MEASUREMENT(S) FAILED") });
    assert_eq!(failures, 0, "{failures} extreme-value measurement(s) failed");
}
