import { describe, expect, test, vi } from "vitest";
import { TempKeyClient } from "@/lib/soniox/temp-key-client";

describe("TempKeyClient", () => {
  test("test_temp_key_client_fetch_initial_stores_and_returns_lease", async () => {
    // Arrange
    const lease = { key: "temp-abc", expiresAt: 100_000 };
    const client = new TempKeyClient(async () => lease);

    // Act
    const result = await client.fetchInitial();

    // Assert
    expect(result).toEqual(lease);
    expect(client.currentLease).toEqual(lease);
  });

  test("test_temp_key_client_renew_replaces_current_lease", async () => {
    // Arrange
    let call = 0;
    const client = new TempKeyClient(async () => {
      call++;
      return { key: `key-${call}`, expiresAt: call * 1000 };
    });
    await client.fetchInitial();

    // Act
    const renewed = await client.renew();

    // Assert
    expect(renewed.key).toBe("key-2");
    expect(client.currentLease?.key).toBe("key-2");
  });

  test("test_temp_key_client_schedule_renewal_without_lease_throws", () => {
    // Arrange
    const client = new TempKeyClient(async () => ({ key: "k", expiresAt: 0 }));
    // Act + Assert — must fetchInitial()/renew() first
    expect(() => client.scheduleRenewal(() => {})).toThrow();
  });

  test("test_temp_key_client_schedule_renewal_fires_onRenewDue_via_injected_timer", async () => {
    // Arrange
    // Params kept typed so `.mock.calls` below carries the real [cb, ms] tuple shape
    // instead of an inferred `[]` — void-referenced to satisfy no-unused-vars.
    const fakeSetTimeout = vi.fn((cb: () => void, ms: number) => {
      void cb;
      void ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const client = new TempKeyClient(async () => ({ key: "k", expiresAt: 200_000 }), {
      now: () => 0,
      setTimeoutFn: fakeSetTimeout as unknown as typeof setTimeout,
    });
    await client.fetchInitial();
    let renewDueCalled = false;

    // Act
    client.scheduleRenewal(() => (renewDueCalled = true));
    const [scheduledCb, scheduledMs] = fakeSetTimeout.mock.calls[0];
    scheduledCb();

    // Assert
    expect(scheduledMs).toBe(200_000 - 120_000); // default leadMs=120_000
    expect(renewDueCalled).toBe(true);
  });

  test("test_temp_key_client_dispose_cancels_pending_renewal", async () => {
    // Arrange
    const fakeSetTimeout = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const fakeClearTimeout = vi.fn();
    const client = new TempKeyClient(async () => ({ key: "k", expiresAt: 200_000 }), {
      now: () => 0,
      setTimeoutFn: fakeSetTimeout as unknown as typeof setTimeout,
      clearTimeoutFn: fakeClearTimeout as unknown as typeof clearTimeout,
    });
    await client.fetchInitial();
    client.scheduleRenewal(() => {});

    // Act
    client.dispose();

    // Assert
    expect(fakeClearTimeout).toHaveBeenCalledTimes(1);
  });
});
