import { afterEach, describe, expect, test, vi } from "vitest";
import { AbortableDelays } from "@/lib/transcript/abortable-delay";

/**
 * MEDIUM-1 (code review WAVE A): `AbortableDelays` là class MỚI của bản vá CRITICAL-1 nhưng
 * chỉ được phủ GIÁN TIẾP qua 4 ca `ingest-queue.test.ts` — hỏng ở đây chỉ lộ ra dưới dạng
 * "batch cuối mất", rất khó lần ngược. Bộ ca dưới khoá thẳng hợp đồng của class: nhả đúng hạn,
 * `abortAll()` nhả SỚM, `pending` không rò ở CẢ HAI đường thoát, và không double-resolve.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("AbortableDelays — backoff huỷ được của IngestQueue", () => {
  test("test_abortable_delays_wait_resolves_after_requested_delay", async () => {
    // Arrange
    vi.useFakeTimers();
    const delays = new AbortableDelays();
    let settled = false;

    // Act — chưa tới hạn thì chưa nhả
    const promise = delays.wait(5000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    const settledBeforeDeadline = settled;
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    // Assert
    expect(settledBeforeDeadline).toBe(false);
    expect(settled).toBe(true);
  });

  test("test_abortable_delays_abort_all_releases_pending_wait_without_advancing_clock", async () => {
    // Arrange — đúng trạng thái CRITICAL-1: chu kỳ flush đang treo giữa backoff 30s
    vi.useFakeTimers();
    const delays = new AbortableDelays();
    let settled = false;
    const promise = delays.wait(30_000).then(() => {
      settled = true;
    });
    expect(delays.pendingCount).toBe(1);

    // Act — dispose() gọi abortAll(), KHÔNG nhích đồng hồ một mili giây nào
    delays.abortAll();
    await promise;

    // Assert
    expect(settled).toBe(true);
    expect(delays.pendingCount).toBe(0);
  });

  test("test_abortable_delays_abort_all_clears_underlying_timer_to_avoid_leak", async () => {
    // Arrange — DI timer để đếm THẬT, không suy đoán qua fake-timer nội bộ vitest
    const cleared: unknown[] = [];
    const setTimeoutFn = ((cb: () => void, ms?: number) => setTimeout(cb, ms)) as typeof setTimeout;
    const clearTimeoutFn = ((id: unknown) => {
      cleared.push(id);
      clearTimeout(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    const delays = new AbortableDelays(setTimeoutFn, clearTimeoutFn);

    // Act — dùng REAL timer (không fake) để chắc chắn không phải ảo giác của fake-timer
    const promise = delays.wait(60_000);
    delays.abortAll();
    await promise;

    // Assert — timer nền bị dọn, không để tiến trình treo 60s
    expect(cleared).toHaveLength(1);
    expect(delays.pendingCount).toBe(0);
  });

  test("test_abortable_delays_natural_fire_removes_itself_from_pending_set", async () => {
    // Arrange
    vi.useFakeTimers();
    const delays = new AbortableDelays();
    const promise = delays.wait(1000);
    expect(delays.pendingCount).toBe(1);

    // Act — để timer trôi tự nhiên (không abort)
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Assert — không rò entry trong Set khi thoát bằng đường "tự bắn"
    expect(delays.pendingCount).toBe(0);
  });

  test("test_abortable_delays_abort_all_after_timer_already_fired_is_safe_noop", async () => {
    // Arrange — timer đã tự bắn xong rồi mới tới lượt dispose() gọi abortAll()
    vi.useFakeTimers();
    const delays = new AbortableDelays();
    let resolveCount = 0;
    const promise = delays.wait(1000).then(() => {
      resolveCount += 1;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Act
    delays.abortAll();
    await vi.advanceTimersByTimeAsync(1000);

    // Assert — không double-resolve, không ném
    expect(resolveCount).toBe(1);
    expect(delays.pendingCount).toBe(0);
  });

  test("test_abortable_delays_abort_all_with_nothing_pending_is_safe_noop", () => {
    // Arrange — dispose() có thể chạy khi queue chưa từng backoff lần nào
    const delays = new AbortableDelays();

    // Act + Assert
    expect(() => delays.abortAll()).not.toThrow();
    expect(delays.pendingCount).toBe(0);
  });

  test("test_abortable_delays_abort_all_releases_every_concurrent_wait", async () => {
    // Arrange — nhiều delay cùng treo (nhiều batch retry chồng nhau)
    vi.useFakeTimers();
    const delays = new AbortableDelays();
    const settled: number[] = [];
    const promises = [2000, 8000, 30_000].map((ms, i) =>
      delays.wait(ms).then(() => {
        settled.push(i);
      }),
    );
    expect(delays.pendingCount).toBe(3);

    // Act
    delays.abortAll();
    await Promise.all(promises);

    // Assert — nhả HẾT, không sót cái dài nhất
    expect(settled.sort()).toEqual([0, 1, 2]);
    expect(delays.pendingCount).toBe(0);
  });
});
