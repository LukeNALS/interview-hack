/**
 * Reconnect-buffer primitives (§Architecture, Implementation Step 13's lib portion). Không còn renew
 * key định kỳ: key single-use, stream sống tới `max_session_duration` — mỗi lần reconnect xin cặp MỚI.
 *
 * Audio is NEVER written to disk/IndexedDB (AC6) — `ReconnectBuffer` is RAM-only, capped
 * at 2 minutes, ALWAYS recording (reconnect replays from the last emitted boundary, not just
 * from the drop) and cleared when the stream stops.
 */

export interface BufferedChunk {
  data: Uint8Array;
  /** Date.now() at the moment this chunk was CAPTURED (not when it's replayed). */
  captureTs: number;
}

/** RAM-only buffer of the most recent PCM chunks (always on, not only while a connection is down).
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

  /** Chunk có `captureTs >= ts`, đúng thứ tự capture, KHÔNG xoá buffer (buffer luôn ghi nên reconnect lần sau vẫn dùng được). */
  chunksSince(ts: number): BufferedChunk[] {
    return this.chunks.filter((c) => c.captureTs >= ts);
  }

  /** captureTs của chunk cũ nhất còn giữ; null khi rỗng. */
  get oldestCaptureTs(): number | null {
    return this.chunks.length > 0 ? this.chunks[0].captureTs : null;
  }

  /** Buffered chunks in capture order, without clearing. */
  peek(): readonly BufferedChunk[] {
    return this.chunks;
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
