import { describe, expect, test, vi } from "vitest";
import { renewKeyWithRetry, type RenewWithRetryDeps } from "@/lib/soniox/renew-with-retry";

/**
 * N2 — chính sách retry của chuỗi gia hạn temp key. Test thuần logic (sleep tiêm qua DI)
 * nên deterministic + không tốn thời gian thật.
 */

const lease = { key: "k-new", expiresAt: Date.now() + 60_000 };

function makeDeps(over: Partial<RenewWithRetryDeps> = {}): RenewWithRetryDeps & {
  events: string[];
  sleeps: number[];
} {
  const events: string[] = [];
  const sleeps: number[] = [];
  return {
    events,
    sleeps,
    renew: vi.fn(async () => lease),
    applyKey: vi.fn(async () => {}),
    isDisposed: () => false,
    onDegraded: () => events.push("degraded"),
    onRestored: () => events.push("restored"),
    onGiveUp: () => events.push("giveup"),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...over,
  };
}

describe("renewKeyWithRetry — N2", () => {
  test("test_renew_retry_permanent_failure_gives_up_after_max_attempts_and_notifies_user", async () => {
    // Arrange — renew ném mãi (mạng rớt hẳn giữa buổi)
    const deps = makeDeps({ renew: vi.fn(async () => { throw new Error("network down"); }), maxAttempts: 3 });

    // Act
    const renewed = await renewKeyWithRetry(deps);

    // Assert — bỏ cuộc CÓ BÁO: banner vàng 1 lần rồi giveUp; caller biết để KHÔNG hẹn tiếp
    expect(renewed).toBe(false);
    expect(deps.renew).toHaveBeenCalledTimes(3);
    expect(deps.events).toEqual(["degraded", "giveup"]);
    expect(deps.sleeps).toEqual([2000, 4000]);
  });

  test("test_renew_retry_transient_failure_then_success_restores_banner_and_returns_true", async () => {
    // Arrange — hỏng 1 lượt rồi ngon (chớp mạng)
    let n = 0;
    const deps = makeDeps({
      renew: vi.fn(async () => {
        n++;
        if (n === 1) throw new Error("blip");
        return lease;
      }),
    });

    // Act
    const renewed = await renewKeyWithRetry(deps);

    // Assert — chuỗi renew SỐNG TIẾP + user thấy banner đã hồi
    expect(renewed).toBe(true);
    expect(deps.applyKey).toHaveBeenCalledWith(lease);
    expect(deps.events).toEqual(["degraded", "restored"]);
  });

  test("test_renew_retry_disposed_mid_flight_exits_quietly_without_banner", async () => {
    // Arrange — user rời màn live đúng lúc renew đang bay: KHÔNG được hù bằng banner lỗi
    let disposed = false;
    const deps = makeDeps({
      renew: vi.fn(async () => {
        disposed = true;
        throw new Error("aborted by unmount");
      }),
      isDisposed: () => disposed,
    });

    // Act
    const renewed = await renewKeyWithRetry(deps);

    // Assert
    expect(renewed).toBe(false);
    expect(deps.events).toEqual([]);
    expect(deps.sleeps).toEqual([]);
  });

  test("test_renew_retry_apply_key_failure_counts_as_attempt_and_gives_up", async () => {
    // Arrange — lấy được key mới nhưng đẩy xuống controller thì ném
    const deps = makeDeps({
      applyKey: vi.fn(async () => { throw new Error("controller closed"); }),
      maxAttempts: 2,
    });

    // Act
    const renewed = await renewKeyWithRetry(deps);

    // Assert — không im lặng nuốt: vẫn báo user rồi dừng
    expect(renewed).toBe(false);
    expect(deps.events).toEqual(["degraded", "giveup"]);
  });
});
