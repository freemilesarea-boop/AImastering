//! `analyze_wav` — minimal CLI that runs the AnalyzerGraph against a WAV
//! and prints a JSON snapshot.
//!
//! Used by the cross-language parity harness to compare Rust dsp-core
//! output against the Python `extract_profile` measurements.
//!
//! Usage:
//!   cargo run --release --example analyze_wav -- <path/to/file.wav>
//!
//! Supports PCM 16-bit, 24-bit, 32-bit and IEEE-float WAVs, plus
//! WAVE_FORMAT_EXTENSIBLE.  No external dependencies.

use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use loui_dsp::{AnalyzerGraph, AnalyzerOptions, VERSION};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: analyze_wav <path/to/file.wav>");
        std::process::exit(2);
    }
    let path = Path::new(&args[1]);
    let result = analyze(path);
    let json = render_json(&result);
    print!("{}", json);
}

/// Snapshot result type for the CLI.
struct Result {
    path: String,
    duration_sec: f64,
    sample_rate: u32,
    channels: u16,
    integrated_lufs: f64,
    short_term_lufs: f64,
    momentary_lufs: f64,
    loudness_range: f64,
    true_peak_dbtp: f64,
    sample_peak_db: f64,
    rms_db: f64,
    correlation: f64,
    ms_ratio_db: f64,
    gated_blocks: u32,
    samples_processed: u64,
    crate_version: String,
}

fn analyze(path: &Path) -> Result {
    let (sr, channels, planar) = read_wav(path).expect("failed to read WAV");
    let frames = planar[0].len();
    let opts = AnalyzerOptions {
        sample_rate: sr as f64,
        channels: channels as usize,
        peak_rms_window_sec: 1.0,
        stereo_window_sec: 1.0,
    };
    let mut graph = AnalyzerGraph::new(opts);
    // Feed the whole file in one block — the analyzer doesn't care about
    // block boundaries (it accumulates per-frame).
    let chans: Vec<&[f32]> = planar.iter().map(|c| c.as_slice()).collect();
    graph.process_planar(&chans);
    graph.flush();
    let snap = graph.snapshot();
    Result {
        path: path.display().to_string(),
        duration_sec: frames as f64 / sr as f64,
        sample_rate: sr,
        channels,
        integrated_lufs: snap.integrated_lufs,
        short_term_lufs: snap.short_term_lufs,
        momentary_lufs:  snap.momentary_lufs,
        loudness_range:  snap.loudness_range,
        true_peak_dbtp:  snap.true_peak_dbtp,
        sample_peak_db:  snap.sample_peak_db,
        rms_db:          snap.rms_db,
        correlation:     snap.correlation,
        ms_ratio_db:     snap.ms_ratio_db,
        gated_blocks:    snap.gated_blocks,
        samples_processed: snap.samples_processed,
        crate_version:   VERSION.to_string(),
    }
}

// ── Minimal WAV reader ─────────────────────────────────────────────────────
//
// Supports the formats produced by the fixture generator (PCM 16/24/32 and
// WAVE_FORMAT_EXTENSIBLE).  Reads the entire file into memory; the example
// is not realtime-sensitive.

fn read_wav(path: &Path) -> std::io::Result<(u32, u16, Vec<Vec<f32>>)> {
    let mut file = fs::File::open(path)?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header)?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err(io_err("not a RIFF/WAVE file"));
    }

    let (fmt_offset, fmt_size) = find_chunk(&mut file, b"fmt ")?;
    file.seek(SeekFrom::Start(fmt_offset))?;
    let mut fmt_buf = vec![0u8; fmt_size as usize];
    file.read_exact(&mut fmt_buf)?;
    let mut format_code = u16::from_le_bytes([fmt_buf[0], fmt_buf[1]]);
    let channels = u16::from_le_bytes([fmt_buf[2], fmt_buf[3]]);
    let sample_rate = u32::from_le_bytes([fmt_buf[4], fmt_buf[5], fmt_buf[6], fmt_buf[7]]);
    let bits_per_sample = u16::from_le_bytes([fmt_buf[14], fmt_buf[15]]);
    if format_code == 0xfffe && fmt_size >= 40 {
        // WAVE_FORMAT_EXTENSIBLE — sub-format GUID at offset 24..40,
        // first 2 bytes indicate real format (1 = PCM, 3 = float).
        format_code = u16::from_le_bytes([fmt_buf[24], fmt_buf[25]]);
    }

    let (data_offset, data_size) = find_chunk(&mut file, b"data")?;
    file.seek(SeekFrom::Start(data_offset))?;
    let mut data = vec![0u8; data_size as usize];
    file.read_exact(&mut data)?;

    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let frame_bytes = bytes_per_sample * channels as usize;
    let frames = data.len() / frame_bytes;

    let mut planar: Vec<Vec<f32>> = (0..channels).map(|_| Vec::with_capacity(frames)).collect();
    match (format_code, bits_per_sample) {
        (1, 16) => {
            for f in 0..frames {
                for c in 0..channels as usize {
                    let off = f * frame_bytes + c * 2;
                    let v = i16::from_le_bytes([data[off], data[off + 1]]);
                    planar[c].push(v as f32 / 32_768.0);
                }
            }
        }
        (1, 24) => {
            for f in 0..frames {
                for c in 0..channels as usize {
                    let off = f * frame_bytes + c * 3;
                    let mut v: i32 = (data[off] as i32)
                        | ((data[off + 1] as i32) << 8)
                        | ((data[off + 2] as i32) << 16);
                    if v & 0x80_0000 != 0 { v |= -0x100_0000; }
                    planar[c].push(v as f32 / 8_388_608.0);
                }
            }
        }
        (1, 32) => {
            for f in 0..frames {
                for c in 0..channels as usize {
                    let off = f * frame_bytes + c * 4;
                    let v = i32::from_le_bytes([
                        data[off], data[off + 1], data[off + 2], data[off + 3],
                    ]);
                    planar[c].push(v as f32 / 2_147_483_648.0);
                }
            }
        }
        (3, 32) => {
            for f in 0..frames {
                for c in 0..channels as usize {
                    let off = f * frame_bytes + c * 4;
                    let bytes = [data[off], data[off + 1], data[off + 2], data[off + 3]];
                    planar[c].push(f32::from_le_bytes(bytes));
                }
            }
        }
        (fc, bps) => {
            return Err(io_err(&format!("unsupported WAV format: code={fc} bits={bps}")));
        }
    }

    Ok((sample_rate, channels, planar))
}

fn find_chunk(file: &mut fs::File, id: &[u8; 4]) -> std::io::Result<(u64, u32)> {
    file.seek(SeekFrom::Start(12))?;
    loop {
        let mut hdr = [0u8; 8];
        if file.read(&mut hdr)? < 8 {
            return Err(io_err(&format!(
                "chunk {:?} not found",
                std::str::from_utf8(id).unwrap_or("?"),
            )));
        }
        let chunk_id = &hdr[..4];
        let size = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
        let offset = file.stream_position()?;
        if chunk_id == id {
            return Ok((offset, size));
        }
        // Skip the chunk body (RIFF pads to even byte alignment).
        let pad = if size % 2 == 1 { 1 } else { 0 };
        file.seek(SeekFrom::Current(size as i64 + pad as i64))?;
    }
}

fn io_err(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg)
}

// ── JSON rendering ─────────────────────────────────────────────────────────
//
// Hand-rolled (zero deps).  Output schema: `loui.dsp-core.snapshot.v1`.

fn render_json(r: &Result) -> String {
    fn f64s(v: f64) -> String {
        if v.is_finite() {
            format!("{v:.6}")
        } else if v.is_nan() {
            "null".into()
        } else if v < 0.0 {
            // -Infinity → represent as a very large negative number for
            // JSON compatibility while remaining recognisable.
            "-1e308".into()
        } else {
            "1e308".into()
        }
    }
    format!(
        "{{\n  \"schema\": \"loui.dsp-core.snapshot.v1\",\n  \"crateVersion\": \"{ver}\",\n  \"path\": \"{path}\",\n  \"sampleRate\": {sr},\n  \"channels\": {ch},\n  \"durationSec\": {dur},\n  \"samplesProcessed\": {sp},\n  \"loudness\": {{\n    \"integratedLufs\": {il},\n    \"shortTermLufs\": {sl},\n    \"momentaryLufs\": {ml},\n    \"loudnessRange\": {lra},\n    \"truePeakDbtp\": {tp},\n    \"gatedBlocks\": {gb}\n  }},\n  \"peakRms\": {{\n    \"samplePeakDb\": {pk},\n    \"rmsDb\": {rms}\n  }},\n  \"stereo\": {{\n    \"correlation\": {corr},\n    \"msRatioDb\": {ms}\n  }}\n}}\n",
        ver = r.crate_version,
        path = r.path.replace('\\', "/").replace('"', "\\\""),
        sr = r.sample_rate,
        ch = r.channels,
        dur = f64s(r.duration_sec),
        sp = r.samples_processed,
        il = f64s(r.integrated_lufs),
        sl = f64s(r.short_term_lufs),
        ml = f64s(r.momentary_lufs),
        lra = f64s(r.loudness_range),
        tp = f64s(r.true_peak_dbtp),
        gb = r.gated_blocks,
        pk = f64s(r.sample_peak_db),
        rms = f64s(r.rms_db),
        corr = f64s(r.correlation),
        ms = f64s(r.ms_ratio_db),
    )
}
