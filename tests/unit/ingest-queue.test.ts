import { afterEach, describe, expect, test, vi } from "vitest";
import {
  IngestQueue,
  IngestRateLimitedError,
  IngestSessionEndedError,
  type IngestPostFn,
  type IngestPostResultItem,
  type IngestUtterancePayload,
} from "@/lib/transcript/ingest-queue";

afterEach(() => {
  vi.useRealTimers();
});

function makePayload(id: string): IngestUtterancePayload {
  return {
    client_utt_id: id,
    speaker: "interviewer",
    lang: "ja",
    text_orig: "xin chào",
    translations: { vi: null, ja: null, en: null },
    t_start_ms: 0,
    t_end_ms: 500,
  };
}

describe("IngestQueue — batch ≤5 + debounce 300ms", () => {
  test("test_ingest_queue_batches_up_to_five_and_debounces_300ms", async () => {
    // Arrange
    vi.useFakeTimers();
    const calls: IngestUtterancePayload[][] = [];
    const postFn: IngestPostFn = vi.fn(async (batch: IngestUtterancePayload[]) => {
      calls.push(batch);
      return { results: batch.map((u) => ({ client_utt_id: u.client_utt_id, seq: 1 })) };
    });
    const queue = new IngestQueue({ postFn });

    // Act — 7 rapid enqueues (> batchSize 5) within the debounce window
    for (let i = 0; i < 7; i++) queue.enqueue(makePayload(`u${i}`));
    expect(calls).toHaveLength(0); // nothing sent before debounce elapses

    await vi.advanceTimersByTimeAsync(300);

    // Assert — drained as chunks of ≤5: first request 5 items, second request 2 items
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(5);
    expect(calls[1]).toHaveLength(2);
  });
});

describe("IngestQueue — 429 retry keeps queue (no drop)", () => {
  test("test_ingest_queue_429_retries_with_backoff_and_keeps_item_queued", async () => {
    // Arrange
    vi.useFakeTimers();
    let attempt = 0;
    const postFn: IngestPostFn = vi.fn(async (batch: IngestUtterancePayload[]) => {
      attempt++;
      if (attempt === 1) throw new IngestRateLimitedError(1000);
      return { results: batch.map((u) => ({ client_utt_id: u.client_utt_id, seq: 1 })) };
    });
    const results: IngestPostResultItem[] = [];
    const queue = new IngestQueue({ postFn, onResult: (r) => results.push(r) });

    // Act
    queue.enqueue(makePayload("u0"));
    await vi.advanceTimersByTimeAsync(300); // debounce fires -> first attempt: 429

    // Assert — item still queued, not dropped, while backing off
    expect(queue.pendingCount).toBe(1);
    expect(results).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000); // backoff elapses -> retry succeeds

    expect(attempt).toBe(2);
    expect(results).toEqual([{ client_utt_id: "u0", seq: 1 }]);
    expect(queue.pendingCount).toBe(0);
  });
});

describe("IngestQueue — 409 session_ended stops sending", () => {
  test("test_ingest_queue_409_session_ended_stops_sending_and_calls_callback", async () => {
    // Arrange
    vi.useFakeTimers();
    const postFn: IngestPostFn = vi.fn(async () => {
      throw new IngestSessionEndedError();
    });
    let sessionEndedCalled = false;
    const queue = new IngestQueue({ postFn, onSessionEnded: () => (sessionEndedCalled = true) });

    // Act
    queue.enqueue(makePayload("u0"));
    await vi.advanceTimersByTimeAsync(300);

    // Assert — u0 stays queued (never delivered, session ended before it could send)
    expect(sessionEndedCalled).toBe(true);
    expect(queue.isStopped).toBe(true);
    const pendingAfterSessionEnded = queue.pendingCount;
    expect(pendingAfterSessionEnded).toBe(1);

    // Act — further enqueue after session_ended must be a no-op (never re-sends)
    queue.enqueue(makePayload("u1"));

    // Assert — pendingCount unchanged, u1 was never added
    expect(queue.pendingCount).toBe(pendingAfterSessionEnded);
  });
});

describe("IngestQueue — drain backlog still chunks by batchSize", () => {
  test("test_ingest_queue_flush_now_drains_backlog_in_chunks_of_batch_size", async () => {
    // Arrange
    const calls: IngestUtterancePayload[][] = [];
    const postFn: IngestPostFn = vi.fn(async (batch: IngestUtterancePayload[]) => {
      calls.push(batch);
      return { results: batch.map((u) => ({ client_utt_id: u.client_utt_id, seq: 1 })) };
    });
    // Large debounce so the natural timer never fires during this test — flushNow()
    // must bypass it entirely.
    const queue = new IngestQueue({ postFn, debounceMs: 100_000 });
    for (let i = 0; i < 12; i++) queue.enqueue(makePayload(`u${i}`));

    // Act
    await queue.flushNow();

    // Assert — 12 items drained as 5 + 5 + 2, never a batch over 5
    expect(calls.map((b) => b.length)).toEqual([5, 5, 2]);
  });
});

/**
 * M9 — queue trước đây đệ quy `sendBatch(batch, attempt+1)` KHÔNG trần số lần VÀ
 * `disposeLivePipeline` không chạm tới queue: rời màn live rồi mà vòng retry 429 vẫn quay
 * suốt vòng đời SPA. Bộ test này khoá cả 2 vế + khoá luôn ràng buộc ngược chiều (dispose
 * KHÔNG được giết batch cuối buổi, vì `endInterview()` dispose TRƯỚC rồi mới flush).
 */
describe("IngestQueue — M9: trần retry 429 + dispose cắt hoạt động nền", () => {
  test("test_ingest_queue_permanent_429_stops_after_max_retry_attempts_and_keeps_batch", async () => {
    // Arrange — server 429 mãi mãi; trần đặt 2 cho test chạy nhanh
    vi.useFakeTimers();
    let calls = 0;
    const errors: unknown[] = [];
    const postFn: IngestPostFn = vi.fn(async () => {
      calls++;
      throw new IngestRateLimitedError(1000);
    });
    const queue = new IngestQueue({ postFn, maxRetryAttempts: 2, onError: (e) => errors.push(e) });

    // Act — 1 lần gửi đầu + retry, rồi để trôi 60s (thừa sức cho retry vô hạn nếu không có trần)
    queue.enqueue(makePayload("u0"));
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(60_000);

    // Assert — đúng 1 lần đầu + 2 retry rồi DỪNG; batch vẫn nằm trong queue (không mất dữ liệu)
    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(IngestRateLimitedError);
    expect(queue.pendingCount).toBe(1);
  });

  test("test_ingest_queue_dispose_mid_backoff_stops_background_retry_and_blocks_enqueue", async () => {
    // Arrange — 429 mãi, trần cao; dispose rơi ĐÚNG lúc đang chờ backoff
    vi.useFakeTimers();
    let calls = 0;
    const postFn: IngestPostFn = vi.fn(async () => {
      calls++;
      throw new IngestRateLimitedError(1000);
    });
    const queue = new IngestQueue({ postFn, maxRetryAttempts: 50 });
    queue.enqueue(makePayload("u0"));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(1);

    // Act — user rời màn live -> disposeLivePipeline() gọi queue.dispose()
    queue.dispose();
    queue.enqueue(makePayload("u1"));
    await vi.advanceTimersByTimeAsync(60_000);

    // Assert — không còn lần gửi NỀN nào nữa, và queue không nhận thêm item mới
    expect(calls).toBe(1);
    expect(queue.isDisposed).toBe(true);
    expect(queue.pendingCount).toBe(1);
  });

  test("test_ingest_queue_dispose_still_allows_final_flush_of_last_batch", async () => {
    // Arrange — mô phỏng ĐÚNG thứ tự trong endInterview(): dispose pipeline TRƯỚC, flush SAU
    const sent: IngestUtterancePayload[][] = [];
    const postFn: IngestPostFn = vi.fn(async (batch: IngestUtterancePayload[]) => {
      sent.push(batch);
      return { results: batch.map((u) => ({ client_utt_id: u.client_utt_id, seq: 1 })) };
    });
    const queue = new IngestQueue({ postFn });
    queue.enqueue(makePayload("last-utterance"));

    // Act
    queue.dispose();
    await queue.flushNow();

    // Assert — câu cuối của buổi phỏng vấn VẪN lên server (dispose chỉ cắt hoạt động nền)
    expect(sent).toHaveLength(1);
    expect(sent[0][0].client_utt_id).toBe("last-utterance");
    expect(queue.pendingCount).toBe(0);
  });
});

/**
 * CRITICAL-1 (code review WAVE A) — HỒI QUY do chính fix M9 gây ra.
 *
 * `flush()` mở đầu bằng `if (this.sending || this.stopped) return;` -> `flushNow()` KHÔNG
 * join vào chu kỳ đang chạy, nó no-op. Trong khi `sending` VẪN true suốt thời gian
 * `sendBatch` ngủ chờ backoff 429. Đường đi thật của `endInterview()`:
 *   `disposeLivePipeline()` -> `queue.dispose()` -> `flushIngestQueueBeforeEnd()` -> `flushNow()`
 * Nếu ĐÚNG lúc đó queue đang treo trong 1 vòng backoff 429 thì `flushNow()` no-op, còn chu kỳ
 * cũ khi tỉnh dậy lại thấy `disposed` nên bỏ luôn (check M9 mới thêm) -> ĐUÔI QUEUE MẤT HẲN.
 *
 * TRƯỚC WAVE A không mất: retry vô hạn rốt cuộc vẫn đẩy được lên server. Fix M9 cắt retry mà
 * không mở đường cho flush cuối join -> vá chỗ này thủng chỗ kia, đúng lớp "hỏng im lặng
 * giữa buổi phỏng vấn thật" mà cả wave sinh ra để chống.
 */
describe("IngestQueue — CRITICAL-1: flush cuối phải join được chu kỳ đang treo backoff", () => {
  test("test_ingest_queue_dispose_then_flush_now_mid_429_backoff_still_delivers_tail", async () => {
    // Arrange — batch đầu bị 429 với backoff DÀI (10s) -> queue kẹt trong sleep, sending=true
    vi.useFakeTimers();
    const sent: string[][] = [];
    let rejectedOnce = false;
    const postFn: IngestPostFn = vi.fn(async (batch: IngestUtterancePayload[]) => {
      if (!rejectedOnce) {
        rejectedOnce = true;
        throw new IngestRateLimitedError(10_000);
      }
      sent.push(batch.map((u) => u.client_utt_id));
      return { results: batch.map((u) => ({ client_utt_id: u.client_utt_id, seq: 1 })) };
    });
    const queue = new IngestQueue({ postFn });
    queue.enqueue(makePayload("tail-1"));
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(0); // đang treo giữa backoff

    // Act — user bấm "Kết thúc": endInterview() dispose TRƯỚC rồi mới flush batch cuối
    queue.dispose();
    await queue.flushNow();

    // Assert — câu cuối buổi VẪN lên server, không kẹt lại vĩnh viễn trong queue
    expect(sent).toEqual([["tail-1"]]);
    expect(queue.pendingCount).toBe(0);
  });
});
