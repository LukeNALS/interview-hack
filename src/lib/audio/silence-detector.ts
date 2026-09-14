/**
 * Detects sustained silence (no mic/tab signal for ~6s, SU AC2's 5-8s window) to raise a
 * "chưa nhận được âm thanh" banner (SU R3 — usually means the user forgot to enable "tab
 * audio share"). Core timing logic (`sample`) is a pure state machine fed by
 * `(rms, atMs)` pairs, so it's directly unit-testable
 * (test_silence_detector_no_signal_for_six_seconds_raises_silent_banner) without any
 * real AnalyserNode/timers. `start()`/`createAnalyserRmsReader` are the only pieces that
 * touch the browser Web Audio API.
 */

export type ReadRmsFn = () => number;

export interface SilenceDetectorOptions {
  /** RMS below this counts as "no signal". Default 0.01 (near-silence for [-1,1] PCM). */
  rmsThreshold?: number;
  /** ms of sustained silence before raising the banner. Default 6000 (SU AC2 5-8s window). */
  silenceThresholdMs?: number;
  /** Poll interval when using start()'s built-in loop. Default 250ms. */
  pollIntervalMs?: number;
  onSilentBanner: () => void;
  onSignalRestored?: () => void;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

export class SilenceDetector {
  private silenceStartedAt: number | null = null;
  private bannerRaised = false;
  private timerId: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SilenceDetectorOptions) {}

  /** Feeds one RMS sample + its wall-clock time. Called by start()'s poll loop, or
   *  directly by tests/callers to simulate elapsed silence deterministically. */
  sample(rms: number, atMs: number): void {
    const { rmsThreshold = 0.01, silenceThresholdMs = 6000, onSilentBanner, onSignalRestored } = this.opts;
    if (rms < rmsThreshold) {
      if (this.silenceStartedAt === null) this.silenceStartedAt = atMs;
      if (!this.bannerRaised && atMs - this.silenceStartedAt >= silenceThresholdMs) {
        this.bannerRaised = true;
        onSilentBanner();
      }
      return;
    }
    this.silenceStartedAt = null;
    if (this.bannerRaised) {
      this.bannerRaised = false;
      onSignalRestored?.();
    }
  }

  /** Starts polling `readRms` on an interval, feeding sample() automatically. */
  start(readRms: ReadRmsFn): void {
    const { pollIntervalMs = 250, now = Date.now, setIntervalFn = setInterval } = this.opts;
    this.timerId = setIntervalFn(() => this.sample(readRms(), now()), pollIntervalMs);
  }

  stop(): void {
    if (this.timerId === null) return;
    const { clearIntervalFn = clearInterval } = this.opts;
    clearIntervalFn(this.timerId);
    this.timerId = null;
  }

  get isBannerRaised(): boolean {
    return this.bannerRaised;
  }
}

/** Real AnalyserNode-backed RMS reader — the only browser-Web-Audio-touching piece. */
export function createAnalyserRmsReader(analyser: AnalyserNode): ReadRmsFn {
  const buffer = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
    return Math.sqrt(sumSquares / buffer.length);
  };
}
