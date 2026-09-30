import { describe, expect, test } from "vitest";
import {
  createReconnectStreakGuard,
  MAX_QUICK_DEGRADES,
  QUICK_FAILURE_WINDOW_MS,
} from "@/hooks/live-session/reconnect-streak-guard";

/**
 * Vòng degrade→reconnect chỉ được dừng bởi guard này (không phải bởi rate limit 60/giờ của route mint): connection
 * mở được rồi lại rớt/bị từ chối ngay (401 ~230 ms sau connect, 429, 5xx) thì mỗi vòng `reconnectWithBackoff` có
 * bộ đếm 3 lượt mới — không có trần nào khác.
 */

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createReconnectStreakGuard", () => {
  test("test_streak_guard_first_quick_degrade_reconnects_immediately", () => {
    // Arrange
    const clock = makeClock();
    const guard = createReconnectStreakGuard(clock.now);
    // Act — lỗi đến ngay sau lần mở đầu (mốc ban đầu = lúc tạo)
    clock.advance(230);
    // Assert
    expect(guard.onDegraded()).toEqual({ action: "reconnect", waitMs: 0 });
  });

  test("test_streak_guard_consecutive_quick_degrades_wait_1s_then_2s_then_give_up", () => {
    // Arrange
    const clock = makeClock();
    const guard = createReconnectStreakGuard(clock.now);
    const decisions = [];

    // Act — mỗi lần: reconnect xong (markConnected) rồi rớt lại sau 230 ms
    for (let i = 0; i < MAX_QUICK_DEGRADES; i++) {
      clock.advance(230);
      decisions.push(guard.onDegraded());
      guard.markConnected();
    }

    // Assert — 0 s, 1 s, 2 s rồi bỏ cuộc ở lần thứ MAX_QUICK_DEGRADES (=4)
    expect(decisions).toEqual([
      { action: "reconnect", waitMs: 0 },
      { action: "reconnect", waitMs: 1000 },
      { action: "reconnect", waitMs: 2000 },
      { action: "give_up" },
    ]);
  });

  test("test_streak_guard_connection_stable_for_window_resets_streak", () => {
    // Arrange — 2 lần thất bại nhanh
    const clock = makeClock();
    const guard = createReconnectStreakGuard(clock.now);
    clock.advance(100);
    guard.onDegraded();
    guard.markConnected();
    clock.advance(100);
    expect(guard.onDegraded()).toEqual({ action: "reconnect", waitMs: 1000 });
    guard.markConnected();

    // Act — lần này kết nối sống đủ cửa sổ rồi mới rớt (mạng chập chờn bình thường)
    clock.advance(QUICK_FAILURE_WINDOW_MS);

    // Assert — reset về lần 1: reconnect ngay, không chờ
    expect(guard.onDegraded()).toEqual({ action: "reconnect", waitMs: 0 });
  });

  test("test_streak_guard_degrade_just_under_window_still_counts_as_quick", () => {
    // Arrange
    const clock = makeClock();
    const guard = createReconnectStreakGuard(clock.now);
    clock.advance(100);
    guard.onDegraded();
    guard.markConnected();

    // Act — rớt sau (cửa sổ − 1 ms)
    clock.advance(QUICK_FAILURE_WINDOW_MS - 1);

    // Assert — vẫn là thất bại nhanh thứ 2 (chờ 1 s)
    expect(guard.onDegraded()).toEqual({ action: "reconnect", waitMs: 1000 });
  });

  test("test_streak_guard_reset_after_stable_period_allows_a_fresh_full_streak", () => {
    // Arrange — 3 thất bại nhanh rồi ổn định
    const clock = makeClock();
    const guard = createReconnectStreakGuard(clock.now);
    for (let i = 0; i < MAX_QUICK_DEGRADES - 1; i++) {
      clock.advance(50);
      guard.onDegraded();
      guard.markConnected();
    }
    clock.advance(QUICK_FAILURE_WINDOW_MS + 1);
    guard.onDegraded();
    guard.markConnected();

    // Act — thất bại nhanh mới sau lần ổn định
    clock.advance(50);

    // Assert — đếm lại từ đầu, không bỏ cuộc sớm
    expect(guard.onDegraded()).toEqual({ action: "reconnect", waitMs: 1000 });
  });
});
