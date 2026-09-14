import { expect, test, vi } from "vitest";
import { createSuggestionTrigger } from "@/hooks/live-session/suggestion-trigger";

/** Harness fake-clock: điều khiển thời gian + timer bằng tay, không timer thật. */
function makeHarness(nowStart = 100_000) {
  let now = nowStart;
  let pending: { cb: () => void; at: number } | null = null;
  const post = vi.fn(() => Promise.resolve());
  const trigger = createSuggestionTrigger({
    post,
    debounceMs: 2500,
    minGapMs: 20_000,
    now: () => now,
    setTimer: (cb, ms) => {
      pending = { cb, at: now + ms };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  /** Tua thời gian tới mốc; timer tới hạn thì cháy. */
  const advance = (ms: number) => {
    now += ms;
    if (pending && now >= pending.at) {
      const { cb } = pending;
      pending = null;
      cb();
    }
  };
  return { trigger, post, advance, hasPending: () => pending !== null };
}

test("test_suggestion_trigger_debounces_rapid_finals_into_single_post", () => {
  // Arrange
  const h = makeHarness();

  // Act — 3 final liên tiếp cách nhau 1s (chưa đủ 2.5s im lặng), rồi im 2.5s
  h.trigger.onCandidateFinal();
  h.advance(1000);
  h.trigger.onCandidateFinal();
  h.advance(1000);
  h.trigger.onCandidateFinal();
  h.advance(2500);

  // Assert
  expect(h.post).toHaveBeenCalledTimes(1);
});

test("test_suggestion_trigger_skips_post_within_min_gap_then_allows_after", () => {
  // Arrange
  const h = makeHarness();
  h.trigger.onCandidateFinal();
  h.advance(2500); // post #1

  // Act — final mới chỉ 5s sau post #1 → debounce cháy trong gap → bỏ qua
  h.advance(5000);
  h.trigger.onCandidateFinal();
  h.advance(2500);

  // Assert
  expect(h.post).toHaveBeenCalledTimes(1);

  // Act — qua đủ 20s kể từ post #1 → lượt mới được bắn
  h.advance(15_000);
  h.trigger.onCandidateFinal();
  h.advance(2500);

  // Assert
  expect(h.post).toHaveBeenCalledTimes(2);
});

test("test_suggestion_trigger_dispose_cancels_pending_debounce_and_blocks_new_finals", () => {
  // Arrange
  const h = makeHarness();
  h.trigger.onCandidateFinal();

  // Act
  h.trigger.dispose();
  h.advance(2500);
  h.trigger.onCandidateFinal();
  h.advance(2500);

  // Assert
  expect(h.post).toHaveBeenCalledTimes(0);
  expect(h.hasPending()).toBe(false);
});

test("test_suggestion_trigger_post_rejection_does_not_break_next_cycle", async () => {
  // Arrange — post ném lỗi (vd 429/mạng): trigger nuốt, chu kỳ sau vẫn chạy
  let now = 100_000;
  let pending: { cb: () => void; at: number } | null = null;
  const post = vi.fn(() => Promise.reject(new Error("rate_limit")));
  const trigger = createSuggestionTrigger({
    post,
    debounceMs: 2500,
    minGapMs: 20_000,
    now: () => now,
    setTimer: (cb, ms) => {
      pending = { cb, at: now + ms };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  const advance = (ms: number) => {
    now += ms;
    if (pending && now >= pending.at) {
      const { cb } = pending;
      pending = null;
      cb();
    }
  };

  // Act
  trigger.onCandidateFinal();
  advance(2500);
  await Promise.resolve(); // cho rejection được nuốt trong microtask
  advance(20_000);
  trigger.onCandidateFinal();
  advance(2500);

  // Assert — không unhandled rejection, vẫn gọi lần 2
  expect(post).toHaveBeenCalledTimes(2);
});
