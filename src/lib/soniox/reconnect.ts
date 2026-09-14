/**
 * Reconnect-buffer primitives (§Architecture, Implementation Step 13's lib portion) +
 * temp-key renewal scheduling (SU R7 — key TTL 3600s, renew at TTL-120s).
 *
 * Audio is NEVER written to disk/IndexedDB (AC6) — `ReconnectBuffer` is RAM-only, capped
 * at 2 minutes, and cleared immediately after a successful replay.
 */

export interface BufferedChunk {
  data: Uint8Array;
  /** Date.now() at the moment this chunk was CAPTURED (not when it's replayed). */
  captureTs: number;
}

/** RAM-only buffer for PCM chunks captured while a Soniox connection is down/renewing.
 *  Retention is capped at `maxDurationMs` (default 2 min), measured by capture_ts span —
 *  oldest chunks are evicted first. */
export class ReconnectBuffer {
  private chunks: BufferedChunk[] = [];

  constructor(private readonly maxDurationMs = 120_000) {}

  push(data: Uint8Array, captureTs: number): void {
    this.chunks.push({ data, captureTs });
    this.evictOlderThan(captureTs);
  }

  private evictOlderThan(latestTs: number): void {
    while (this.chunks.length > 0 && latestTs - this.chunks[0].captureTs > this.maxDurationMs) {
      this.chunks.shift();
    }
  }

  /** Buffered chunks in capture order, without clearing. */
  peek(): readonly BufferedChunk[] {
    return this.chunks;
  }

  /** Returns buffered chunks and clears the buffer — call once replay to the new
   *  connection has been fed successfully (§Architecture "xóa buffer"). */
  drain(): BufferedChunk[] {
    const out = this.chunks;
    this.chunks = [];
    return out;
  }

  clear(): void {
    this.chunks = [];
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }
}

/**
 * Fix B13: epoch_conn for a connection opened to replay a RAM buffer = capture_ts of the
 * FIRST buffered chunk (≈ moment the outage began), NOT the replay wall-clock time. This
 * keeps the session timeline from jumping forward by the outage duration, and prevents
 * drift from accumulating across multiple reconnects.
 */
export function epochConnForReplay(chunks: readonly BufferedChunk[]): number | null {
  return chunks.length > 0 ? chunks[0].captureTs : null;
}

export interface KeyLease {
  key: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface RenewalScheduleOptions {
  /** Lead time before expiry to trigger renewal. Default 120_000ms (TTL-120s, SU R7). */
  leadMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** Schedules `onRenewDue` at `expiresAt - leadMs` (clamped to >=0 if already past due).
 *  Returns a cancel function — call it on stopCapture()/unmount to avoid a stray renew
 *  firing after the session ended. */
export function scheduleKeyRenewal(
  lease: KeyLease,
  onRenewDue: () => void,
  opts: RenewalScheduleOptions = {},
): () => void {
  const { leadMs = 120_000, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = opts;
  const delay = Math.max(0, lease.expiresAt - leadMs - now());
  const timer = setTimeoutFn(onRenewDue, delay);
  return () => clearTimeoutFn(timer);
}
