//! Hand-rolled benchmark harness (zero deps).
//!
//! Run with:
//!   cargo bench --bench analyzer_bench
//!
//! Prints throughput numbers + per-call latency.  Output format is
//! human-friendly + machine-parseable (one metric per line).

use std::time::{Duration, Instant};

use loui_dsp::analyzer::{AnalyzerGraph, AnalyzerOptions};
use loui_dsp::fft::Fft;

fn main() {
    println!("loui-dsp benchmark suite (M2-lite)\n");
    bench_fft_4096();
    bench_fft_8192();
    bench_analyzer_60s_stereo_44100();
    bench_analyzer_60s_stereo_48000();
    bench_analyzer_realtime_blocks();
}

fn bench_fft_4096() {
    let n = 4096;
    let fft = Fft::new(n);
    let input: Vec<f32> = (0..n).map(|i| (i as f32 / 13.0).sin()).collect();
    let mut re = vec![0.0; n];
    let mut im = vec![0.0; n];
    let mut mag = vec![0.0; n / 2 + 1];

    // Warmup.
    for _ in 0..10 {
        fft.magnitude(&input, &mut mag, &mut re, &mut im);
    }

    let iters = 2000;
    let t0 = Instant::now();
    for _ in 0..iters {
        fft.magnitude(&input, &mut mag, &mut re, &mut im);
    }
    let elapsed = t0.elapsed();
    report("fft_4096", iters, elapsed, format!("{} pts", n));
}

fn bench_fft_8192() {
    let n = 8192;
    let fft = Fft::new(n);
    let input: Vec<f32> = (0..n).map(|i| (i as f32 / 13.0).sin()).collect();
    let mut re = vec![0.0; n];
    let mut im = vec![0.0; n];
    let mut mag = vec![0.0; n / 2 + 1];
    for _ in 0..5 {
        fft.magnitude(&input, &mut mag, &mut re, &mut im);
    }
    let iters = 1000;
    let t0 = Instant::now();
    for _ in 0..iters {
        fft.magnitude(&input, &mut mag, &mut re, &mut im);
    }
    let elapsed = t0.elapsed();
    report("fft_8192", iters, elapsed, format!("{} pts", n));
}

fn bench_analyzer_60s_stereo_44100() {
    bench_analyzer_full_file(44_100, 60.0);
}

fn bench_analyzer_60s_stereo_48000() {
    bench_analyzer_full_file(48_000, 60.0);
}

fn bench_analyzer_full_file(sr: u32, duration_sec: f64) {
    let frames = (sr as f64 * duration_sec) as usize;
    let left:  Vec<f32> = synth_signal(frames, sr, 1000.0, -16.0);
    let right: Vec<f32> = synth_signal(frames, sr, 1100.0, -16.0);
    let opts = AnalyzerOptions {
        sample_rate: sr as f64,
        channels: 2,
        peak_rms_window_sec: 1.0,
        stereo_window_sec: 1.0,
    };
    // Time full-file analysis.
    let iters = 5;
    // Warmup.
    {
        let mut a = AnalyzerGraph::new(opts);
        a.process_planar(&[&left, &right]);
        a.flush();
        let _ = a.snapshot();
    }
    let t0 = Instant::now();
    for _ in 0..iters {
        let mut a = AnalyzerGraph::new(opts);
        a.process_planar(&[&left, &right]);
        a.flush();
        let _ = a.snapshot();
    }
    let elapsed = t0.elapsed();
    let per_call = elapsed / iters;
    let ratio = duration_sec / per_call.as_secs_f64();
    report(
        &format!("analyzer_60s_stereo_{}", sr),
        iters as usize,
        elapsed,
        format!("{ratio:.1}× realtime (60 s in {:.3} s)", per_call.as_secs_f64()),
    );
}

fn bench_analyzer_realtime_blocks() {
    // Realtime-style: 256-sample blocks fed in a tight loop.
    let sr = 48_000u32;
    let opts = AnalyzerOptions {
        sample_rate: sr as f64,
        channels: 2,
        peak_rms_window_sec: 1.0,
        stereo_window_sec: 1.0,
    };
    let mut a = AnalyzerGraph::new(opts);
    let block = 256;
    let left:  Vec<f32> = synth_signal(block, sr, 1000.0, -12.0);
    let right: Vec<f32> = synth_signal(block, sr, 1100.0, -12.0);
    let iters: usize = (sr as usize / block) * 60;   // 60 s worth of blocks
    // Warmup.
    for _ in 0..100 {
        a.process_planar(&[&left, &right]);
    }
    let t0 = Instant::now();
    for _ in 0..iters {
        a.process_planar(&[&left, &right]);
        let _ = a.tick_snapshot();
    }
    let elapsed = t0.elapsed();
    let per_block = elapsed / iters as u32;
    let block_period_us = block as f64 * 1e6 / sr as f64;
    let load_pct = (per_block.as_nanos() as f64 / 1e3) / block_period_us * 100.0;
    report(
        "analyzer_realtime_256_block",
        iters,
        elapsed,
        format!(
            "per-block {:.2} µs (block-period {:.2} µs, CPU load {:.2}%)",
            per_block.as_nanos() as f64 / 1e3,
            block_period_us,
            load_pct,
        ),
    );
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn synth_signal(frames: usize, sr: u32, freq_hz: f64, level_dbfs: f64) -> Vec<f32> {
    let amp = 10f64.powf(level_dbfs / 20.0) * (2.0f64).sqrt();
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let s = amp * (2.0 * std::f64::consts::PI * freq_hz * i as f64 / sr as f64).sin();
        out.push(s as f32);
    }
    out
}

fn report(name: &str, iters: usize, elapsed: Duration, note: impl AsRef<str>) {
    println!("[bench] {name:<40}  iters={iters:>6}  total={:>10}  per_iter={:>10}  {}",
        format_duration(elapsed),
        format_duration(elapsed / iters as u32),
        note.as_ref(),
    );
}

fn format_duration(d: Duration) -> String {
    let ns = d.as_nanos();
    if ns < 1_000 {
        format!("{} ns", ns)
    } else if ns < 1_000_000 {
        format!("{:.2} µs", ns as f64 / 1e3)
    } else if ns < 1_000_000_000 {
        format!("{:.2} ms", ns as f64 / 1e6)
    } else {
        format!("{:.3} s", ns as f64 / 1e9)
    }
}
