/**
 * Nhóm delay HUỶ ĐƯỢC — dùng cho backoff retry của `IngestQueue`.
 *
 * Vì sao cần: backoff 429 có thể ngủ tới 30s (hoặc `Retry-After` server trả). Khi user bấm
 * "Kết thúc", `endInterview()` dispose pipeline rồi flush batch cuối với hạn 3s — nếu chu kỳ
 * flush đang treo trong `setTimeout` 30s thì flush cuối không kịp chờ nó nhả, và đuôi queue
 * mất im lặng (CRITICAL-1, code review WAVE A). `abortAll()` cho mọi delay đang chờ nhả NGAY
 * để chu kỳ cũ unwind kịp, flush cuối mới có cửa gửi nốt.
 *
 * `setTimeoutFn`/`clearTimeoutFn` tiêm qua DI để test dùng fake timer y như `IngestQueue`.
 */
export class AbortableDelays {
  private readonly pending = new Set<() => void>();

  constructor(
    private readonly setTimeoutFn: typeof setTimeout = setTimeout,
    private readonly clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ) {}

  /** Chờ `ms`, HOẶC nhả sớm nếu `abortAll()` được gọi. Không bao giờ reject. */
  wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // `timer` giữ trong holder vì `settle` phải khai báo TRƯỚC khi có id timer (nó chính là
      // callback của timer), mà `settle` lại cần clear timer khi bị abort sớm.
      const holder: { timer?: ReturnType<typeof setTimeout> } = {};
      const settle = () => {
        this.pending.delete(settle);
        if (holder.timer !== undefined) this.clearTimeoutFn(holder.timer);
        resolve();
      };
      this.pending.add(settle);
      holder.timer = this.setTimeoutFn(settle, ms);
    });
  }

  /** Nhả mọi delay đang chờ ngay lập tức (idempotent). */
  abortAll(): void {
    const aborts = [...this.pending];
    this.pending.clear();
    for (const abort of aborts) abort();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
