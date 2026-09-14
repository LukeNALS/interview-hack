/**
 * Keeps incoming Realtime `seq` numbers in order (SU T8 — Supabase Realtime broadcast
 * does NOT replay missed messages). When a gap is detected, reports the missing range so
 * the caller (FE wave's `use-backfill` hook) can fetch it via
 * `GET /utterances?after_seq=`. Waiting for the gap to "heal" itself would stall forever
 * since Realtime never resends — so `feed()` always advances past the gap immediately
 * and lets backfill fill in the missing rows asynchronously.
 */

export interface SeqBufferOptions {
  /** Fired when seq jumps ahead of expected — range is [fromSeqExclusive, toSeqInclusive]. */
  onGapDetected: (fromSeqExclusive: number, toSeqInclusive: number) => void;
  /** Fired for every seq accepted (in-order or past-a-gap), in the order fed. */
  onAccepted: (seq: number) => void;
}

export class SeqBuffer {
  private lastSeq: number | null;

  constructor(private readonly opts: SeqBufferOptions, initialSeq: number | null = null) {
    this.lastSeq = initialSeq;
  }

  /** Feeds one incoming seq. Stale/duplicate seqs (<= last accepted) are ignored. */
  feed(seq: number): void {
    if (this.lastSeq !== null && seq <= this.lastSeq) return;
    if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      this.opts.onGapDetected(this.lastSeq + 1, seq - 1);
    }
    this.lastSeq = seq;
    this.opts.onAccepted(seq);
  }

  /** Resets the tracked position — e.g. after a full backfill-from-zero on reload. */
  reset(seq: number | null = null): void {
    this.lastSeq = seq;
  }

  get current(): number | null {
    return this.lastSeq;
  }
}
