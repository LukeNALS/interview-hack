// @vitest-environment node
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  createAdminClient,
  createAnonClient,
  createTestUser,
  deleteTestUsers,
  seedSession,
  signInAsUser,
} from "./db-test-support";

/**
 * Audit 2026-09-28 #4 — transcript/gợi ý phát trên Broadcast public: ai có UUID phiên cũng
 * nghe lén hoặc gửi event giả được. 0020 + `private: true` ở broadcast-server/subscribe-client
 * khoá lại: CHỈ chủ phiên join/nhận, không ai ngoài service-role gửi được.
 *
 * Chạy WebSocket THẬT tới Realtime local (không mock) — node environment để dùng WebSocket
 * native. Mọi ca "nhận 0 event" đều có đối chứng dương: chờ owner nhận được CÙNG event rồi
 * mới kết luận phía bị chặn không nhận (tránh pass giả do event chưa kịp tới).
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_TEST_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_TEST_ANON_KEY,
  }),
  getServerEnv: () => ({ SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_TEST_SERVICE_KEY }),
}));

const suite = canRunDbTests ? describe : describe.skip;

const JOIN_TIMEOUT_MS = 10_000;
const DELIVERY_TIMEOUT_MS = 5_000;
const HOOK_TIMEOUT_MS = 30_000;

type JoinResult = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

interface Listener {
  channel: RealtimeChannel;
  joined: Promise<JoinResult>;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
}

/** Join `session:{id}` và gom mọi broadcast nhận được; trả kết quả join đầu tiên. */
async function listen(client: SupabaseClient, sessionId: string, isPrivate = true): Promise<Listener> {
  await client.realtime.setAuth();
  const events: Listener["events"] = [];
  const channel = client.channel(`session:${sessionId}`, { config: { private: isPrivate } });
  channel.on("broadcast", { event: "*" }, (msg) => events.push({ event: msg.event, payload: msg.payload }));
  const joined = new Promise<JoinResult>((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), JOIN_TIMEOUT_MS);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        resolve(status);
      }
    });
  });
  return { channel, joined, events };
}

async function waitForEvent(listener: Listener, marker: string): Promise<void> {
  await vi.waitFor(() => expect(listener.events.some((e) => e.payload?.marker === marker)).toBe(true), {
    timeout: DELIVERY_TIMEOUT_MS,
    interval: 50,
  });
}

function markerEvent(marker: string) {
  // `conn.degraded` là ServerEvent hợp lệ; `marker` thêm vào để phân biệt từng ca test.
  return { type: "conn.degraded", marker } as never;
}

suite("Realtime private channel (0020) — chỉ chủ phiên nhận, browser không gửi được", () => {
  const suffix = Date.now();
  const sessionId = crypto.randomUUID();
  const userIds: string[] = [];
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let ownerSecondTab: SupabaseClient;
  let stranger: SupabaseClient;
  const openClients: SupabaseClient[] = [];

  beforeAll(async () => {
    admin = createAdminClient();
    const ownerId = await createTestUser(admin, `rt-owner-${suffix}@example.test`);
    const strangerId = await createTestUser(admin, `rt-stranger-${suffix}@example.test`);
    userIds.push(ownerId, strangerId);
    await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "live" } });
    owner = await signInAsUser(`rt-owner-${suffix}@example.test`);
    ownerSecondTab = await signInAsUser(`rt-owner-${suffix}@example.test`);
    stranger = await signInAsUser(`rt-stranger-${suffix}@example.test`);
    openClients.push(owner, ownerSecondTab, stranger);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openClients.map((c) => c.removeAllChannels()));
    await deleteTestUsers(admin, userIds);
  }, HOOK_TIMEOUT_MS);

  test("test_realtime_owner_private_join_receives_server_rest_broadcast", async () => {
    // Arrange
    const ownerListener = await listen(owner, sessionId);
    expect(await ownerListener.joined).toBe("SUBSCRIBED");
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    await broadcastEvent(sessionId, markerEvent("rest-owner"));

    // Assert
    await waitForEvent(ownerListener, "rest-owner");
    await owner.removeChannel(ownerListener.channel);
  });

  test("test_realtime_owner_receives_server_fallback_broadcast_when_rest_fails", async () => {
    // Arrange
    const ownerListener = await listen(owner, sessionId);
    expect(await ownerListener.joined).toBe("SUBSCRIBED");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/realtime/v1/api/broadcast")
        ? Promise.resolve(new Response(null, { status: 503 }))
        : realFetch(input, init),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    await broadcastEvent(sessionId, markerEvent("fallback-owner"));

    // Assert
    await waitForEvent(ownerListener, "fallback-owner");
    vi.unstubAllGlobals();
    await owner.removeChannel(ownerListener.channel);
  });

  test("test_realtime_non_owner_private_join_is_rejected_and_receives_nothing", async () => {
    // Arrange
    const ownerListener = await listen(owner, sessionId);
    const strangerListener = await listen(stranger, sessionId);
    expect(await ownerListener.joined).toBe("SUBSCRIBED");
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    const strangerJoin = await strangerListener.joined;
    await broadcastEvent(sessionId, markerEvent("non-owner"));
    await waitForEvent(ownerListener, "non-owner");

    // Assert
    expect(strangerJoin).not.toBe("SUBSCRIBED");
    expect(strangerListener.events).toEqual([]);
    await owner.removeChannel(ownerListener.channel);
    await stranger.removeChannel(strangerListener.channel);
  });

  test("test_realtime_anon_private_join_is_rejected_and_receives_nothing", async () => {
    // Arrange
    const anon = createAnonClient();
    openClients.push(anon);
    const ownerListener = await listen(owner, sessionId);
    const anonListener = await listen(anon, sessionId);
    expect(await ownerListener.joined).toBe("SUBSCRIBED");
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    const anonJoin = await anonListener.joined;
    await broadcastEvent(sessionId, markerEvent("anon"));
    await waitForEvent(ownerListener, "anon");

    // Assert
    expect(anonJoin).not.toBe("SUBSCRIBED");
    expect(anonListener.events).toEqual([]);
    await owner.removeChannel(ownerListener.channel);
  });

  test("test_realtime_public_subscriber_on_same_topic_receives_no_private_broadcast", async () => {
    // Arrange — đường nghe lén cũ: channel public cùng topic, không cần là chủ phiên.
    const ownerListener = await listen(owner, sessionId);
    const publicListener = await listen(stranger, sessionId, false);
    expect(await ownerListener.joined).toBe("SUBSCRIBED");
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    await publicListener.joined;
    await broadcastEvent(sessionId, markerEvent("public-eavesdrop"));
    await waitForEvent(ownerListener, "public-eavesdrop");

    // Assert
    expect(publicListener.events).toEqual([]);
    await owner.removeChannel(ownerListener.channel);
    await stranger.removeChannel(publicListener.channel);
  });

  test("test_realtime_browser_forged_send_on_private_channel_is_not_delivered", async () => {
    // Arrange — kẻ gửi giả là CHÍNH chủ phiên ở tab khác (quyền cao nhất phía browser).
    const receiver = await listen(owner, sessionId);
    const forger = await listen(ownerSecondTab, sessionId);
    expect(await receiver.joined).toBe("SUBSCRIBED");
    await forger.joined;
    const { data: auth } = await ownerSecondTab.auth.getSession();
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act — gửi qua WebSocket và qua REST bằng JWT user, rồi 1 event server làm đối chứng.
    await forger.channel.send({ type: "broadcast", event: "conn.degraded", payload: { marker: "forged-ws" } });
    await fetch(`${process.env.SUPABASE_TEST_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_TEST_ANON_KEY!,
        Authorization: `Bearer ${auth.session!.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ topic: `session:${sessionId}`, event: "conn.degraded", payload: { marker: "forged-rest" }, private: true }],
      }),
    });
    await broadcastEvent(sessionId, markerEvent("server-after-forge"));
    await waitForEvent(receiver, "server-after-forge");

    // Assert
    const markers = receiver.events.map((e) => e.payload?.marker);
    expect(markers).not.toContain("forged-ws");
    expect(markers).not.toContain("forged-rest");
    await owner.removeChannel(receiver.channel);
    await ownerSecondTab.removeChannel(forger.channel);
  });

  test("test_realtime_owner_rejoins_private_channel_after_socket_drop", async () => {
    // Arrange — socket rớt rồi nối lại ⇒ realtime-js join lại channel private (CHANNEL_ERROR →
    // SUBSCRIBED), Realtime kiểm quyền LẠI lúc join. `conn.close()` trần KHÔNG ngắt được socket
    // của realtime-js (đo 2026-09-29) nên mô phỏng bằng disconnect()+connect().
    const statuses: string[] = [];
    await owner.realtime.setAuth();
    const events: Listener["events"] = [];
    const channel = owner.channel(`session:${sessionId}`, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (msg) => events.push({ event: msg.event, payload: msg.payload }));
    channel.subscribe((status) => statuses.push(status));
    await vi.waitFor(() => expect(statuses).toContain("SUBSCRIBED"), { timeout: JOIN_TIMEOUT_MS });
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    await owner.realtime.disconnect();
    owner.realtime.connect();
    await vi.waitFor(() => expect(statuses.filter((s) => s === "SUBSCRIBED").length).toBeGreaterThanOrEqual(2), {
      timeout: 20_000,
      interval: 100,
    });
    await broadcastEvent(sessionId, markerEvent("after-rejoin"));

    // Assert
    await vi.waitFor(() => expect(events.some((e) => e.payload?.marker === "after-rejoin")).toBe(true), {
      timeout: DELIVERY_TIMEOUT_MS,
    });
    await owner.removeChannel(channel);
  }, 40_000);

  test("test_realtime_owner_keeps_receiving_after_token_refresh", async () => {
    // Arrange
    const ownerListener = await listen(owner, sessionId);
    expect(await ownerListener.joined).toBe("SUBSCRIBED");
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act — TOKEN_REFRESHED ⇒ supabase-js tự realtime.setAuth(token mới) trên channel đang mở.
    const { error } = await owner.auth.refreshSession();
    expect(error).toBeNull();
    await broadcastEvent(sessionId, markerEvent("after-refresh"));

    // Assert
    await waitForEvent(ownerListener, "after-refresh");
    await owner.removeChannel(ownerListener.channel);
  });
});
