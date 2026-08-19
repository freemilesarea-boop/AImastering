// daw-recorder — a capture tap for the DAW's record path.
//
// It is a SINK, not a processor: nothing downstream reads its output, and the
// audio it sees is untouched.  That matters because the rest of this engine is
// native-node-only precisely so that live and offline render identically; a
// worklet that only copies samples out does not change what is heard.
//
// Two messages come out:
//   { type: 'level', peak }    always, throttled — the input meter
//   { type: 'chunk', channels } while recording, in blocks
//
// Samples are buffered here into blocks before posting.  A render quantum is
// 128 frames; posting each one would be ~375 messages a second per channel,
// and the structured-clone cost of that shows up as glitches on a busy graph.

const BLOCK_FRAMES = 4096;
const LEVEL_INTERVAL_QUANTA = 16;      // ~46 ms at 44.1 kHz

class DawRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const channels = Math.max(1, Math.min(2, options?.processorOptions?.channels ?? 2));
    this.channelCount = channels;
    this.recording = false;
    this.buffers = [];
    for (let c = 0; c < channels; c++) this.buffers.push(new Float32Array(BLOCK_FRAMES));
    this.filled = 0;
    this.peak = 0;
    this.quanta = 0;
    this.captured = 0;

    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === 'start') {
        this.recording = true;
      } else if (type === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'stopped', frames: this.captured });
      } else if (type === 'reset') {
        this.recording = false;
        this.filled = 0;
        this.captured = 0;
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const channels = [];
    for (let c = 0; c < this.channelCount; c++) {
      channels.push(this.buffers[c].slice(0, this.filled));
    }
    this.port.postMessage({ type: 'chunk', channels }, channels.map((c) => c.buffer));
    // The buffers were transferred, so they need replacing.
    this.buffers = [];
    for (let c = 0; c < this.channelCount; c++) this.buffers.push(new Float32Array(BLOCK_FRAMES));
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0] ? input[0].length : 0;
    if (frames === 0) return true;

    // Peak across whatever channels arrived, for the meter.
    for (let c = 0; c < input.length; c++) {
      const data = input[c];
      for (let i = 0; i < frames; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > this.peak) this.peak = v;
      }
    }
    this.quanta++;
    if (this.quanta >= LEVEL_INTERVAL_QUANTA) {
      this.port.postMessage({ type: 'level', peak: this.peak });
      this.peak = 0;
      this.quanta = 0;
    }

    if (!this.recording) return true;

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channelCount; c++) {
        // A mono capture from a stereo input takes channel 0; a stereo capture
        // from a mono input duplicates it.  Either way the recorded file has
        // exactly the channel count that was asked for.
        const source = input[Math.min(c, input.length - 1)];
        this.buffers[c][this.filled] = source ? source[i] : 0;
      }
      this.filled++;
      this.captured++;
      if (this.filled === BLOCK_FRAMES) this.flush();
    }
    return true;
  }
}

registerProcessor('daw-recorder', DawRecorderProcessor);
