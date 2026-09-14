import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCapCountdown } from "@/hooks/use-cap-countdown";

const STARTED_AT = "2026-08-12T00:00:00.000Z";
const CAP_SECONDS = 5400; // 90'

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(STARTED_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

test("test_cap_countdown_warns_once_at_five_minutes_remaining", () => {
  // Arrange
  const onWarn5Min = vi.fn();
  renderHook(() =>
    useCapCountdown({ startedAt: STARTED_AT, capSeconds: CAP_SECONDS, onWarn5Min, onCapReached: vi.fn() }),
  );

  // Act — elapsed = cap - 300s (còn đúng 5 phút)
  act(() => {
    vi.advanceTimersByTime((CAP_SECONDS - 300) * 1000);
  });

  // Assert
  expect(onWarn5Min).toHaveBeenCalledTimes(1);

  // Act — tick tiếp không bắn lại lần 2
  act(() => vi.advanceTimersByTime(10_000));
  expect(onWarn5Min).toHaveBeenCalledTimes(1);
});

test("test_cap_countdown_warns_once_at_one_minute_remaining", () => {
  // Arrange
  const onWarn1Min = vi.fn();
  renderHook(() =>
    useCapCountdown({ startedAt: STARTED_AT, capSeconds: CAP_SECONDS, onWarn1Min, onCapReached: vi.fn() }),
  );

  // Act — elapsed = cap - 60s (còn đúng 1 phút)
  act(() => {
    vi.advanceTimersByTime((CAP_SECONDS - 60) * 1000);
  });

  // Assert
  expect(onWarn1Min).toHaveBeenCalledTimes(1);
});

test("test_cap_countdown_auto_stops_capture_exactly_once_when_cap_reached", () => {
  // Arrange
  const onCapReached = vi.fn();
  renderHook(() =>
    useCapCountdown({ startedAt: STARTED_AT, capSeconds: CAP_SECONDS, onCapReached }),
  );

  // Act — chạm đúng mốc cap
  act(() => vi.advanceTimersByTime(CAP_SECONDS * 1000));
  // Assert
  expect(onCapReached).toHaveBeenCalledTimes(1);

  // Act — sau cap, interval đã tự dừng -> KHÔNG gọi thêm lần nào nữa
  act(() => vi.advanceTimersByTime(60_000));
  expect(onCapReached).toHaveBeenCalledTimes(1);
});

test("test_cap_countdown_ticks_elapsed_seconds_every_interval", () => {
  // Arrange
  const onTick = vi.fn();
  renderHook(() => useCapCountdown({ startedAt: STARTED_AT, capSeconds: CAP_SECONDS, onTick, onCapReached: vi.fn() }));

  // Act
  act(() => vi.advanceTimersByTime(3000));

  // Assert — tick ngay lúc mount (0s) + mỗi giây sau đó
  const calls = onTick.mock.calls.map((c) => c[0] as number);
  expect(calls).toContain(0);
  expect(calls).toContain(3);
});

test("test_cap_countdown_noop_when_started_at_is_null", () => {
  // Arrange — session chưa live (started_at=null) -> hook không throw, không set interval
  const onTick = vi.fn();

  // Act
  renderHook(() => useCapCountdown({ startedAt: null, capSeconds: CAP_SECONDS, onTick, onCapReached: vi.fn() }));
  act(() => vi.advanceTimersByTime(5000));

  // Assert
  expect(onTick).not.toHaveBeenCalled();
});
