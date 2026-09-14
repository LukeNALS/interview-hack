import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  closeAllStreamsOnce,
  flushIngestQueueBeforeEnd,
  handleSeqGap,
  reconnectWithBackoff,
  resolveT0LocalMs,
  resyncAfterReconnect,
  type StreamRuntime,
} from "@/hooks/use-live-session";
import { clockOffsetStorageKey } from "@/hooks/use-session";
import { IngestQueue, type IngestUtterancePayload } from "@/lib/transcript/ingest-queue";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

test("test_live_page_restores_t0_local_from_persisted_clock_offset_after_reload", () => {
  // Arrange — /start trước đó đã persist clock_offset = t0_local - started_at_server (fix B14)
  const sessionId = "sess-reload-1";
  const startedAt = "2026-08-12T00:00:00.000Z";
  const clockOffsetMs = 1500;
  window.localStorage.setItem(clockOffsetStorageKey(sessionId), String(clockOffsetMs));

  // Act — reload giữa buổi: đọc lại clock_offset, dựng lại t0_local
  const t0Local = resolveT0LocalMs(sessionId, startedAt);

  // Assert — t0_local = started_at (server) + clock_offset (client persisted), KHÔNG dùng Date.now() hiện tại
  expect(t0Local).toBe(new Date(startedAt).getTime() + clockOffsetMs);
});

test("test_live_page_falls_back_to_now_when_clock_offset_missing", () => {
  // Arrange — localStorage trống (thiếu key) -> coi như phiên mới (reconnect), không dùng started_at
  const fakeNow = () => 999999;

  // Act
  const t0Local = resolveT0LocalMs("sess-reload-2", "2026-08-12T00:00:00.000Z", fakeNow);

  // Assert
  expect(t0Local).toBe(999999);
});

test("test_realtime_reconnect_backfills_from_last_seq_and_shows_restored", async () => {
  // Arrange — fix B15: broadcast lỡ trong lúc Realtime rớt không replay được -> backfill bù
  const backfillFrom = vi.fn().mockResolvedValue({ utterances: [], next_after_seq: null });
  const applyBackfillRow = vi.fn();
  const syncSeqBuffer = vi.fn();
  const showRestored = vi.fn();

  // Act — Realtime resubscribe thành công sau khi rớt
  await resyncAfterReconnect({
    backfillFrom,
    lastSeq: 12,
    applyBackfillRow,
    syncSeqBuffer,
    showRestored,
  });

  // Assert — backfill từ last_seq local + báo banner xanh
  expect(backfillFrom).toHaveBeenCalledWith(12);
  expect(showRestored).toHaveBeenCalledTimes(1);
});

test("test_realtime_reconnect_applies_backfilled_rows_after_refetch", async () => {
  // Arrange
  const rows = [{ seq: 13 }, { seq: 14 }];
  const backfillFrom = vi.fn().mockResolvedValue({ utterances: rows, next_after_seq: null });
  const applyBackfillRow = vi.fn();

  // Act
  await resyncAfterReconnect({
    backfillFrom,
    lastSeq: 12,
    applyBackfillRow,
    syncSeqBuffer: vi.fn(),
    showRestored: vi.fn(),
  });

  // Assert
  expect(applyBackfillRow).toHaveBeenCalledTimes(2);
  expect(applyBackfillRow).toHaveBeenNthCalledWith(1, rows[0]);
  expect(applyBackfillRow).toHaveBeenNthCalledWith(2, rows[1]);
});

test("test_realtime_reconnect_syncs_seq_buffer_with_backfilled_rows_M4_fix", async () => {
  // Arrange — M4 (code review): trước fix, seqBufferRef không được cập nhật sau backfill ->
  // event Realtime kế tiếp trông như "seq nhảy cóc" -> handleSeqGap kích hoạt thừa 1 lần.
  const rows = [{ seq: 20 }, { seq: 21 }, { seq: 22 }];
  const backfillFrom = vi.fn().mockResolvedValue({ utterances: rows, next_after_seq: null });
  const syncSeqBuffer = vi.fn();

  // Act
  await resyncAfterReconnect({
    backfillFrom,
    lastSeq: 19,
    applyBackfillRow: vi.fn(),
    syncSeqBuffer,
    showRestored: vi.fn(),
  });

  // Assert — PHẢI đồng bộ seqBuffer với toàn bộ rows vừa backfill (caller tự lấy seq lớn nhất)
  expect(syncSeqBuffer).toHaveBeenCalledTimes(1);
  expect(syncSeqBuffer).toHaveBeenCalledWith(rows);
});

test("test_realtime_reconnect_syncs_seq_buffer_skips_when_no_rows_backfilled", async () => {
  // Arrange — không có gì mới backfill -> syncSeqBuffer vẫn được gọi (caller tự no-op khi rỗng)
  const backfillFrom = vi.fn().mockResolvedValue({ utterances: [], next_after_seq: null });
  const syncSeqBuffer = vi.fn();

  // Act
  await resyncAfterReconnect({
    backfillFrom,
    lastSeq: 19,
    applyBackfillRow: vi.fn(),
    syncSeqBuffer,
    showRestored: vi.fn(),
  });

  // Assert
  expect(syncSeqBuffer).toHaveBeenCalledWith([]);
});

test("test_seq_gap_detected_triggers_backfill_with_correct_after_seq", async () => {
  // Arrange — SeqBuffer báo gap(fromExcl=5, toIncl=6) khi seq nhảy từ 4 lên 7
  const backfillFrom = vi.fn().mockResolvedValue({ utterances: [{ seq: 5 }, { seq: 6 }], next_after_seq: null });
  const applyBackfillRow = vi.fn();

  // Act
  await handleSeqGap(5, backfillFrom, applyBackfillRow);

  // Assert — backfill từ seq đã biết cuối cùng (fromExcl - 1 = lastSeq = 4), lấp đủ khoảng thiếu
  expect(backfillFrom).toHaveBeenCalledWith(4);
  expect(applyBackfillRow).toHaveBeenCalledTimes(2);
});

// ===== C1 fix: reconnectWithBackoff — retry giới hạn, KHÔNG loop vô hạn =====

test("test_reconnect_with_backoff_succeeds_on_first_attempt_without_giving_up", async () => {
  // Arrange
  const reconnect = vi.fn().mockResolvedValue(undefined);
  const onGiveUp = vi.fn();

  // Act
  await reconnectWithBackoff({ getApiKey: () => "key-1", reconnect, onGiveUp });

  // Assert
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(reconnect).toHaveBeenCalledWith("key-1");
  expect(onGiveUp).not.toHaveBeenCalled();
});

test("test_reconnect_with_backoff_gives_up_after_max_attempts_without_infinite_loop", async () => {
  // Arrange — luôn thất bại -> phải dừng sau đúng maxAttempts, KHÔNG loop vô hạn
  const reconnect = vi.fn().mockRejectedValue(new Error("still down"));
  const onGiveUp = vi.fn();
  const delayFn = vi.fn().mockResolvedValue(undefined);

  // Act
  await reconnectWithBackoff({ getApiKey: () => "key", reconnect, onGiveUp }, { maxAttempts: 3, delayFn });

  // Assert — đúng 3 lần thử, give up đúng 1 lần, backoff giữa các lần (không delay sau lần cuối)
  expect(reconnect).toHaveBeenCalledTimes(3);
  expect(onGiveUp).toHaveBeenCalledTimes(1);
  expect(delayFn).toHaveBeenCalledTimes(2);
});

test("test_reconnect_with_backoff_stops_retrying_once_a_later_attempt_succeeds", async () => {
  // Arrange — thất bại 2 lần rồi thành công lần 3
  const reconnect = vi
    .fn()
    .mockRejectedValueOnce(new Error("down"))
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValueOnce(undefined);
  const onGiveUp = vi.fn();
  const delayFn = vi.fn().mockResolvedValue(undefined);

  // Act
  await reconnectWithBackoff({ getApiKey: () => "key", reconnect, onGiveUp }, { maxAttempts: 5, delayFn });

  // Assert — dừng NGAY khi thành công, không chạy hết maxAttempts
  expect(reconnect).toHaveBeenCalledTimes(3);
  expect(onGiveUp).not.toHaveBeenCalled();
});

test("test_reconnect_with_backoff_skips_reconnect_call_when_api_key_unavailable", async () => {
  // Arrange — chưa có lease (vd TempKeyClient chưa fetchInitial xong) -> không gọi reconnect(),
  // nhưng vẫn tính vào vòng retry (không loop vô hạn chờ key).
  const reconnect = vi.fn();
  const onGiveUp = vi.fn();
  const delayFn = vi.fn().mockResolvedValue(undefined);

  // Act
  await reconnectWithBackoff({ getApiKey: () => null, reconnect, onGiveUp }, { maxAttempts: 2, delayFn });

  // Assert
  expect(reconnect).not.toHaveBeenCalled();
  expect(onGiveUp).toHaveBeenCalledTimes(1);
});

// ===== M2 fix: closeAllStreamsOnce — idempotent, tránh double-close khi unmount ngay sau endInterview() =====

function makeFakeStreamRuntime(overrides: {
  label?: StreamRuntime["label"];
  pcmStop?: () => void;
  controllerStop?: () => Promise<void>;
  dispose?: () => void;
  mediaStream?: unknown;
} = {}): StreamRuntime {
  const pcmCapture = { stop: overrides.pcmStop ?? vi.fn() };
  const controller = { stop: overrides.controllerStop ?? vi.fn().mockResolvedValue(undefined) };
  const alignBuffer = { dispose: overrides.dispose ?? vi.fn() };
  return {
    label: overrides.label ?? "mic",
    fixedRole: "interviewer",
    controller,
    alignBuffer,
    pcmCapture,
    mediaStream: overrides.mediaStream ?? {},
    directSpeakerMap: new Map(),
  } as unknown as StreamRuntime;
}

test("test_close_all_streams_once_stops_each_stream_and_clears_ref", () => {
  // Arrange
  const pcmStopA = vi.fn();
  const pcmStopB = vi.fn();
  const controllerStopA = vi.fn().mockResolvedValue(undefined);
  const controllerStopB = vi.fn().mockResolvedValue(undefined);
  const disposeA = vi.fn();
  const disposeB = vi.fn();
  const ref = {
    current: [
      makeFakeStreamRuntime({ label: "mic", pcmStop: pcmStopA, controllerStop: controllerStopA, dispose: disposeA }),
      makeFakeStreamRuntime({ label: "tab", pcmStop: pcmStopB, controllerStop: controllerStopB, dispose: disposeB }),
    ],
  };
  const stopOnline = vi.fn();
  const stopDirect = vi.fn();

  // Act
  closeAllStreamsOnce(ref, { stopOnline, stopDirect });

  // Assert
  expect(pcmStopA).toHaveBeenCalledTimes(1);
  expect(pcmStopB).toHaveBeenCalledTimes(1);
  expect(controllerStopA).toHaveBeenCalledTimes(1);
  expect(controllerStopB).toHaveBeenCalledTimes(1);
  expect(disposeA).toHaveBeenCalledTimes(1);
  expect(disposeB).toHaveBeenCalledTimes(1);
  expect(stopOnline).toHaveBeenCalledTimes(1); // 2 stream -> online mode, raw track release
  expect(stopDirect).not.toHaveBeenCalled();
  expect(ref.current).toEqual([]);
});

test("test_close_all_streams_once_called_twice_in_a_row_is_idempotent_no_double_close", () => {
  // Arrange — mô phỏng endInterview() rồi unmount ngay sau (SPA router.push)
  const pcmStop = vi.fn();
  const controllerStop = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  const ref = { current: [makeFakeStreamRuntime({ pcmStop, controllerStop, dispose })] };
  const stopDirect = vi.fn();

  // Act — gọi 2 lần liên tiếp
  closeAllStreamsOnce(ref, { stopOnline: vi.fn(), stopDirect });
  closeAllStreamsOnce(ref, { stopOnline: vi.fn(), stopDirect });

  // Assert — lần 2 là no-op (ref đã rỗng sau lần 1), KHÔNG double-close
  expect(pcmStop).toHaveBeenCalledTimes(1);
  expect(controllerStop).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(stopDirect).toHaveBeenCalledTimes(1);
});

test("test_close_all_streams_once_swallows_controller_stop_rejection_without_throwing", async () => {
  // Arrange — SDK reject khi đóng session đã đóng (chưa verify idempotent với SDK Soniox thật)
  const controllerStop = vi.fn().mockRejectedValue(new Error("already closed"));
  const ref = { current: [makeFakeStreamRuntime({ controllerStop })] };

  // Act + Assert — không throw đồng bộ
  expect(() => closeAllStreamsOnce(ref, { stopOnline: vi.fn(), stopDirect: vi.fn() })).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0)); // để .catch() nội bộ nuốt rejection chạy xong
  expect(controllerStop).toHaveBeenCalledTimes(1);
});

// ===== M3 fix: flushIngestQueueBeforeEnd — flush trước mọi đường kết thúc buổi, timeout ngắn =====

test("test_flush_ingest_queue_before_end_awaits_flush_now", async () => {
  // Arrange
  const flushNow = vi.fn().mockResolvedValue(undefined);

  // Act
  await flushIngestQueueBeforeEnd({ flushNow });

  // Assert
  expect(flushNow).toHaveBeenCalledTimes(1);
});

test("test_flush_ingest_queue_before_end_does_not_hang_forever_when_flush_stalls", async () => {
  // Arrange — mạng đơ giữa lúc flush cuối -> vẫn phải resolve sau timeout, không treo navigate
  vi.useFakeTimers();
  const flushNow = vi.fn(() => new Promise<void>(() => {}));
  let resolved = false;

  // Act
  const promise = flushIngestQueueBeforeEnd({ flushNow }, 3000).then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(3000);
  await promise;

  // Assert
  expect(resolved).toBe(true);
});

test("test_flush_ingest_queue_before_end_noop_when_queue_is_null", async () => {
  // Arrange + Act + Assert — endInterview() gọi trước cả khi mount effect chưa kịp tạo IngestQueue
  await expect(flushIngestQueueBeforeEnd(null)).resolves.toBeUndefined();
});

test("test_flush_ingest_queue_before_end_posts_pending_final_still_in_debounce_window", async () => {
  // Arrange — M3 (code review): trước fix, batch cuối còn trong 300ms debounce lúc bấm "Kết
  // thúc" có thể KHÔNG BAO GIỜ được gửi nếu tab đóng ngay sau navigate. Dùng IngestQueue THẬT
  // (không mock) để verify finals thật sự được POST, không chỉ verify flushNow() được gọi.
  const posted: IngestUtterancePayload[] = [];
  const payload: IngestUtterancePayload = {
    client_utt_id: "final-pending-1",
    speaker: "interviewer",
    lang: "ja",
    text_orig: "xin chào",
    translations: { vi: null, ja: null, en: null },
    t_start_ms: 0,
    t_end_ms: 500,
  };
  const queue = new IngestQueue({
    postFn: async (batch) => {
      posted.push(...batch);
      return { results: batch.map((u) => ({ client_utt_id: u.client_utt_id, seq: 1 })) };
    },
  });
  queue.enqueue(payload); // vẫn còn trong debounce 300ms, CHƯA gửi

  // Act — endInterview() gọi flushIngestQueueBeforeEnd() TRƯỚC /end + navigate
  await flushIngestQueueBeforeEnd(queue);

  // Assert — batch cuối ĐÃ được POST xong (không phải chỉ enqueue) trước khi hàm resolve
  expect(posted).toEqual([payload]);
  expect(queue.pendingCount).toBe(0);
});
