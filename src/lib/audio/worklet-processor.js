/* global AudioWorkletProcessor, sampleRate, registerProcessor */
// Runs inside AudioWorkletGlobalScope (no module imports, no TS, no test coverage here —
// jsdom/vitest can't load this scope). Deliberately DUMB: buffers raw mono Float32 frames
// at the native graph sample rate (typically 48kHz) into ~100ms chunks and posts them to
// the main thread. NO resampling/PCM16 conversion here — that logic lives in
// `pcm-worklet.ts` on the main thread, where it's plain, unit-testable TypeScript
// (see `downsampleToPcm16`, covered by test_pcm_worklet_downsamples_48k_to_16k_length_matches).
class RawFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkMs = options?.processorOptions?.chunkMs ?? 100;
    // `sampleRate` is a global provided by AudioWorkletGlobalScope (native graph rate).
    this.samplesPerChunk = Math.round((sampleRate * chunkMs) / 1000);
    this.buffer = new Float32Array(this.samplesPerChunk);
    this.writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex++] = channel[i];
      if (this.writeIndex >= this.samplesPerChunk) {
        this.port.postMessage(this.buffer.slice(0));
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor("raw-frame-processor", RawFrameProcessor);
