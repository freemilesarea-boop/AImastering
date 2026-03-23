# Mastering Pipeline Specification

## Audio Pipeline

```
Input WAV/FLAC/MP3
  ↓
[1] ffprobe — format, sample rate, bit depth, channels, duration
  ↓
[2] loudnorm pass1 — measure integrated LUFS, LRA, true peak, threshold
  ↓
[3] soundfile + numpy — FFT artifact detection, silence edges, DC offset
  ↓
[4] Build FFmpeg filter chain:
      AI corrections (optional) → Style EQ → Compressor
  ↓
[5] loudnorm pass2 — linear normalization with pass1 measurements injected
  ↓
[6] Output: Master WAV (pcm_s24le, 44100 Hz)
  ↓
[7] libmp3lame 320 kbps → Preview MP3
```

## FFmpeg loudnorm 2-pass

**Pass 1** (measure):
```
ffmpeg -i <input> -af "loudnorm=I=-14:TP=-1:LRA=11:print_format=json" -f null -
```
Extracts: `input_i`, `input_lra`, `input_tp`, `input_thresh`, `target_offset`

**Pass 2** (apply with linear mode):
```
ffmpeg -i <input> -af "<eq_chain>,loudnorm=I=-14:TP=-1:LRA=11:linear=true
  :measured_I=<input_i>:measured_LRA=<input_lra>:measured_TP=<input_tp>
  :measured_thresh=<input_thresh>:offset=<target_offset>:print_format=none"
  -ar 44100 -acodec pcm_s24le <output.wav>
```

## Style Preset EQ Parameters

| Style    | Low Boost      | High Cut/Boost     | Compressor Ratio |
|----------|----------------|--------------------|-----------------|
| Balanced | —              | —                  | 2.5:1           |
| Warm     | +1.5 dB @120Hz | -1.5 dB @5kHz      | 2.0:1           |
| Bright   | -1.0 dB @200Hz | +2.0 dB @10kHz     | 3.0:1           |
| Punch    | +2.0 dB @80Hz  | +1.5 dB @3kHz      | 4.0:1           |

## AI Artifact Detection (FFT-based)

```python
ratio = band_energy(lo, hi) / total_energy

harsh_high_mid    = ratio(3000, 5000) > 0.28   → EQ notch: f=4000 g=-3dB
boomy_low_end     = ratio(60,   200)  > 0.45   → EQ cut:   f=120  g=-4dB
brickwall         = LRA < 2.5 LU               → (informational only)
stereo_imbalance  = |20*log10(RMS_L/RMS_R)| > 3 dB
upsample_suspect  = ratio(0.9*Nyquist, Nyquist) < 0.001
```
