/**
 * AudioContext/AudioWorkletNode wiring (browser API — allowed to touch it here per
 * development-rules "Browser API chỉ chạm ở capture-*.ts/pcm-worklet.ts"). The actual
 * resample math is a pure, side-effect-free function (`downsampleToPcm16`) so it's
 * directly unit-testable without any browser globals
 * (test_pcm_worklet_downsamples_48k_to_16k_length_matches).
 */

export const TARGET_SAMPLE_RATE_HZ = 16000;
export const CHUNK_MS = 100;
const PROCESSOR_NAME = "raw-frame-processor";

/** Float32 -> PCM16, clamped to [-1, 1]. */
function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/**
 * Linear-interpolation downsample from `inputSampleRate` to `targetSampleRate`, then
 * converts to PCM16. Pure function — no AudioContext/AudioWorklet involved, so it can be
 * unit-tested directly with plain Float32Array input (e.g. simulating a 48kHz Chrome tab
 * capture being downsampled to Soniox's required 16kHz).
 */
export function downsampleToPcm16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number = TARGET_SAMPLE_RATE_HZ,
): Int16Array {
  if (inputSampleRate === targetSampleRate) {
    return floatTo16BitPcm(input);
  }
  const ratio = inputSampleRate / targetSampleRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[idx + 1] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return floatTo16BitPcm(out);
}

export interface PcmWorkletOptions {
  chunkMs?: number;
  targetSampleRate?: number;
  /** Called with one PCM16 chunk (ArrayBuffer), ready to fan out to Soniox connections. */
  onChunk: (chunk: ArrayBuffer) => void;
  onError?: (err: Error) => void;
}

/** Wraps an AudioContext + AudioWorkletNode fed by a MediaStream (mic or tab audio),
 *  resampling every ~100ms native-rate frame down to 16kHz PCM16 on the main thread. */
export class PcmWorkletCapture {
  private audioContext: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pending: number[] = [];

  constructor(private readonly opts: PcmWorkletOptions) {}

  async start(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    const moduleUrl = new URL("./worklet-processor.js", import.meta.url);
    await ctx.audioWorklet.addModule(moduleUrl);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      processorOptions: { chunkMs: this.opts.chunkMs ?? CHUNK_MS },
    });
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.handleFrame(ev.data, ctx.sampleRate);
    node.onprocessorerror = () => this.opts.onError?.(new Error(`[pcm-worklet] processor error`));
    source.connect(node);
    this.audioContext = ctx;
    this.node = node;
  }

  private handleFrame(frame: Float32Array, inputSampleRate: number): void {
    for (const s of frame) this.pending.push(s);
    const needed = Math.round((inputSampleRate * (this.opts.chunkMs ?? CHUNK_MS)) / 1000);
    while (this.pending.length >= needed) {
      const slice = this.pending.splice(0, needed);
      const pcm16 = downsampleToPcm16(
        Float32Array.from(slice),
        inputSampleRate,
        this.opts.targetSampleRate ?? TARGET_SAMPLE_RATE_HZ,
      );
      this.opts.onChunk(pcm16.buffer as ArrayBuffer);
    }
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    void this.audioContext?.close();
    this.node = null;
    this.audioContext = null;
    this.pending = [];
  }
}
