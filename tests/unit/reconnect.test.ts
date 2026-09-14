import { describe, expect, test } from "vitest";
import { ReconnectBuffer, epochConnForReplay, scheduleKeyRenewal } from "@/lib/soniox/reconnect";

describe("ReconnectBuffer — RAM-only, capped at 2 minutes", () => {
  test("test_reconnect_buffer_push_and_drain_returns_chunks_in_capture_order", () => {
    // Arrange
    const buffer = new ReconnectBuffer();
    // Act
    buffer.push(new Uint8Array([1]), 1000);
    buffer.push(new Uint8Array([2]), 1100);
    const drained = buffer.drain();
    // Assert
    expect(drained.map((c) => c.captureTs)).toEqual([1000, 1100]);
    expect(buffer.isEmpty).toBe(true); // drain() clears the buffer
  });

  test("test_reconnect_buffer_evicts_chunks_older_than_max_duration", () => {
    // Arrange — cap at 2 minutes (120_000ms), default
    const buffer = new ReconnectBuffer(120_000);
    // Act
    buffer.push(new Uint8Array([1]), 0); // will fall outside the 2min window once t=120_001 arrives
    buffer.push(new Uint8Array([2]), 60_000);
    buffer.push(new Uint8Array([3]), 120_001);
    // Assert — first chunk (captureTs=0) evicted; the other two remain
    expect(buffer.peek().map((c) => c.captureTs)).toEqual([60_000, 120_001]);
  });

  test("test_reconnect_buffer_clear_empties_without_returning_chunks", () => {
    const buffer = new ReconnectBuffer();
    buffer.push(new Uint8Array([1]), 0);
    buffer.clear();
    expect(buffer.isEmpty).toBe(true);
  });
});

describe("epochConnForReplay — fix B13", () => {
  test("test_epoch_conn_for_replay_returns_capture_ts_of_first_chunk", () => {
    // Arrange
    const chunks = [
      { data: new Uint8Array([1]), captureTs: 5000 },
      { data: new Uint8Array([2]), captureTs: 5100 },
    ];
    // Act + Assert
    expect(epochConnForReplay(chunks)).toBe(5000);
  });

  test("test_epoch_conn_for_replay_empty_buffer_returns_null", () => {
    expect(epochConnForReplay([])).toBeNull();
  });
});

describe("scheduleKeyRenewal — TTL-120s lead time (SU R7)", () => {
  test("test_schedule_key_renewal_fires_at_ttl_minus_lead_ms", () => {
    // Arrange
    let scheduledDelay: number | null = null;
    const fakeSetTimeout = ((_cb: () => void, ms: number) => {
      scheduledDelay = ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const lease = { key: "temp-key", expiresAt: 100_000 };

    // Act
    scheduleKeyRenewal(lease, () => {}, {
      leadMs: 120_000 - 100_000 + 20_000, // arbitrary, just verifying the math below
      now: () => 0,
      setTimeoutFn: fakeSetTimeout,
    });

    // Assert — delay = expiresAt - leadMs - now()
    expect(scheduledDelay).toBe(100_000 - 40_000 - 0);
  });

  test("test_schedule_key_renewal_clamps_negative_delay_to_zero_when_already_past_due", () => {
    // Arrange
    let scheduledDelay: number | null = null;
    const fakeSetTimeout = ((_cb: () => void, ms: number) => {
      scheduledDelay = ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const lease = { key: "temp-key", expiresAt: 1000 };

    // Act — leadMs (120_000) alone already exceeds expiresAt -> would-be-negative delay
    scheduleKeyRenewal(lease, () => {}, { now: () => 0, setTimeoutFn: fakeSetTimeout });

    // Assert
    expect(scheduledDelay).toBe(0);
  });

  test("test_schedule_key_renewal_cancel_clears_the_underlying_timer", () => {
    // Arrange
    let cleared = false;
    const fakeClear = (() => {
      cleared = true;
    }) as typeof clearTimeout;
    const fakeSetTimeout = ((() => 1) as unknown) as typeof setTimeout;
    const lease = { key: "temp-key", expiresAt: 200_000 };

    // Act
    const cancel = scheduleKeyRenewal(lease, () => {}, {
      now: () => 0,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
    });
    cancel();

    // Assert
    expect(cleared).toBe(true);
  });
});
