/**
 * Client-side batching queue for `POST /api/sessions/:id/utterances` (§Requirements
 * Non-functional — REQUIREMENT, not just risk-mitigation): batches finals ≤5/req with a
 * 300ms debounce so unbatched worst-case traffic (~7200 req/h across 4 streams) never
 * gets close to the server's 60/min + burst 20 rate limit.
 *
 * All HTTP is injected via `postFn` (DI — no fetch() in this file, testable without
 * network). `postFn` MUST reject with `IngestRateLimitedError` on HTTP 429 and
 * `IngestSessionEndedError` on HTTP 409 `session_ended` so this queue can branch
 * correctly; any other rejection is treated as a transient error (item stays queued,
 * flush stops for this cycle, retried on the next enqueue()/flushNow()).
 *
 * ⚠️ GIỚI HẠN CỦA "never drops" — đọc trước khi tin queue không bao giờ mất dữ liệu.
 * Cam kết "không bao giờ drop" chỉ đúng khi queue còn SỐNG (chưa `dispose()`). Sau
 * `dispose()` (user rời màn live / bấm "Kết thúc") hàng đợi chuyển sang chế độ BEST-EFFORT:
 * `flushNow()` được đúng MỘT lượt gửi cho mỗi batch, KHÔNG retry — vì `endInterview()` chỉ
 * cho `flushIngestQueueBeforeEnd()` hạn cứng 3s trước khi điều hướng đi. Lượt cuối đó mà
 * vẫn dính 429 thì batch nằm lại `pendingCount` và KHÔNG ai gửi nữa.
 *
 * Đây là ĐÁNH ĐỔI CÓ CHỦ ĐÍCH, không phải bug: giữ retry sau dispose chính là lỗi M9
 * (queue quay vô hạn suốt vòng đời SPA), còn kéo dài hạn 3s thì treo đường rời màn live.
 * Rủi ro tồn dư này chỉ kích hoạt khi server đang rate-limit ĐÚNG lúc buổi phỏng vấn kết
 * thúc. Xem `docs/security-notes.md` §7 (WAVE A / CRITICAL-1).
 */

import { AbortableDelays } from "./abortable-delay";

export interface IngestTranslations {
  vi: string | null;
  ja: string | null;
  en: string | null;
}

export interface IngestUtterancePayload {
  client_utt_id: string;
  speaker: string;
  lang: string | null;
  text_orig: string;
  translations: IngestTranslations;
  t_start_ms: number;
  t_end_ms: number;
  question_id?: string | null;
  en_pending?: boolean;
}

export interface IngestPostResultItem {
  client_utt_id: string;
  seq: number;
}

export interface IngestPostResult {
  results: IngestPostResultItem[];
}

export type IngestPostFn = (batch: IngestUtterancePayload[]) => Promise<IngestPostResult>;

export class IngestRateLimitedError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super("soniox ingest rate limited (429)");
    this.name = "IngestRateLimitedError";
  }
}

export class IngestSessionEndedError extends Error {
  constructor() {
    super("session already ended (409 session_ended)");
    this.name = "IngestSessionEndedError";
  }
}

export interface IngestQueueOptions {
  postFn: IngestPostFn;
  /** Max utterances per POST body. Default 5 (REQUIREMENT). */
  batchSize?: number;
  /** Debounce before flushing newly enqueued items. Default 300ms (REQUIREMENT). */
  debounceMs?: number;
  /** Backoff base for 429 retry, doubles per attempt (capped at maxBackoffMs). Default 1000ms. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** M9 fix: TRẦN số lần retry 429 cho MỘT batch. Default 6 (1+2+4+8+16+30 = 61s, phủ trọn
   *  cửa sổ rate limit 60/phút của server). Hết trần: batch VẪN nằm trong queue (không mất),
   *  chỉ dừng vòng retry của chu kỳ này — `enqueue()`/`flushNow()` kế tiếp thử lại. */
  maxRetryAttempts?: number;
  onSessionEnded?: () => void;
  onResult?: (result: IngestPostResultItem) => void;
  onError?: (err: unknown) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class IngestQueue {
  private queue: IngestUtterancePayload[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private stopped = false;
  private disposed = false;
  /** CRITICAL-1 fix: chu kỳ flush đang chạy, để caller thứ hai JOIN thay vì no-op. */
  private inFlight: Promise<void> | null = null;
  private readonly backoffDelays: AbortableDelays;

  constructor(private readonly opts: IngestQueueOptions) {
    this.backoffDelays = new AbortableDelays(opts.setTimeoutFn, opts.clearTimeoutFn);
  }

  /** Enqueues one final utterance. Không drop trong lúc queue còn sống — kể cả đang giữa
   *  backoff 429, item vẫn nằm trong queue tới khi được nhận hoặc session xác nhận đã kết
   *  thúc (§Requirements). Sau `dispose()` thì `enqueue` bị chặn và phần còn tồn đọng chỉ
   *  được gửi best-effort 1 lượt — xem cảnh báo "GIỚI HẠN CỦA never drops" ở đầu file. */
  enqueue(payload: IngestUtterancePayload): void {
    if (this.stopped || this.disposed) return;
    this.queue.push(payload);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer !== null || this.disposed) return;
    const { debounceMs = 300, setTimeoutFn = setTimeout } = this.opts;
    this.debounceTimer = setTimeoutFn(() => {
      this.debounceTimer = null;
      // `.catch()` bắt buộc: chu kỳ này được `flushNow()` JOIN lại (CRITICAL-1 fix), nên
      // rejection ở đây mà không nuốt sẽ lan sang `endInterview()` và CHẶN `router.push`.
      void this.flush().catch(() => {});
    }, debounceMs);
  }

  /**
   * CRITICAL-1 fix: trước đây `if (this.sending) return;` khiến caller thứ hai NO-OP — mà
   * `sending` vẫn true suốt thời gian `sendBatch` ngủ chờ backoff 429. `flushNow()` gọi đúng
   * lúc đó thì không gửi gì, không chờ gì, và đuôi queue mất im lặng. Nay trả lại ĐÚNG
   * promise của chu kỳ đang chạy để caller JOIN được.
   */
  private flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve();
    this.sending = true;
    this.inFlight = this.drain().finally(() => {
      this.sending = false;
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    const { batchSize = 5 } = this.opts;
    while (this.queue.length > 0 && !this.stopped) {
      const batch = this.queue.slice(0, batchSize);
      const ok = await this.sendBatch(batch);
      if (!ok) break;
      this.queue.splice(0, batch.length);
    }
  }

  private async sendBatch(batch: IngestUtterancePayload[], attempt = 0): Promise<boolean> {
    try {
      const result = await this.opts.postFn(batch);
      for (const r of result.results) this.opts.onResult?.(r);
      return true;
    } catch (err) {
      if (err instanceof IngestSessionEndedError) {
        this.stopped = true;
        this.opts.onSessionEnded?.();
        return false;
      }
      if (err instanceof IngestRateLimitedError) {
        const {
          baseBackoffMs = 1000,
          maxBackoffMs = 30000,
          maxRetryAttempts = 6,
        } = this.opts;
        // M9 fix: trước đây đệ quy KHÔNG trần -> server 429 kéo dài là queue quay vòng vô hạn.
        // Hết trần thì báo onError và trả false: batch còn nguyên trong queue (không mất dữ liệu),
        // chỉ dừng chu kỳ flush này.
        if (attempt >= maxRetryAttempts) {
          this.opts.onError?.(err);
          return false;
        }
        // Đã dispose/409 thì KHÔNG ngủ thêm lượt nào: flush cuối của `endInterview()` chỉ có
        // ~3s, mỗi batch được đúng 1 lượt best-effort. Chặn TRƯỚC khi ngủ (không phải sau)
        // để chu kỳ cũ unwind ngay, nhường đường cho flush cuối.
        if (this.stopped || this.disposed) return false;
        const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt);
        await this.backoffDelays.wait(err.retryAfterMs ?? delay);
        // dispose/409 rơi ĐÚNG lúc đang chờ backoff -> dừng ngay, không retry nền tiếp.
        if (this.stopped || this.disposed) return false;
        return this.sendBatch(batch, attempt + 1);
      }
      this.opts.onError?.(err);
      return false;
    }
  }

  private cancelDebounce(): void {
    if (this.debounceTimer === null) return;
    const { clearTimeoutFn = clearTimeout } = this.opts;
    clearTimeoutFn(this.debounceTimer);
    this.debounceTimer = null;
  }

  /**
   * Bypasses the debounce and flushes immediately — e.g. before navigating to /wait.
   *
   * CRITICAL-1 fix: nếu có chu kỳ flush đang dở (điển hình: treo giữa backoff 429), CHỜ nó
   * unwind xong rồi mới drain lần cuối. `dispose()` đã nhả backoff nên chờ này ngắn, không
   * ăn hết hạn 3s của `flushIngestQueueBeforeEnd`.
   */
  async flushNow(): Promise<void> {
    this.cancelDebounce();
    // Nuốt lỗi chu kỳ cũ: mục tiêu ở đây là ĐI TIẾP và drain nốt, không phải báo lỗi ngược
    // lên `endInterview()` (lỗi ở đó chặn luôn đường rời màn live).
    if (this.inFlight) await this.inFlight.catch(() => {});
    await this.flush();
  }

  /**
   * M9 fix — pipeline live đóng (rời màn live / kết thúc buổi): dừng mọi hoạt động NỀN
   * (huỷ debounce timer, cắt vòng retry đang chờ backoff, chặn enqueue mới). Trước đây
   * `disposeLivePipeline` không chạm queue nên nó chạy tiếp suốt vòng đời SPA.
   *
   * CỐ Ý KHÔNG khoá `flushNow()`: `endInterview()` dispose pipeline TRƯỚC rồi mới gọi
   * `flushIngestQueueBeforeEnd(queue)` — khoá ở đây là mất batch CUỐI của buổi phỏng vấn.
   * Có test khoá ràng buộc này (`..._dispose_still_allows_final_flush_...`).
   */
  dispose(): void {
    this.disposed = true;
    this.cancelDebounce();
    // CRITICAL-1 fix: nhả mọi backoff đang treo (có thể tới 30s) để chu kỳ flush đang chạy
    // unwind NGAY -> `flushNow()` ngay sau đó join được và còn kịp gửi đuôi queue.
    this.backoffDelays.abortAll();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
