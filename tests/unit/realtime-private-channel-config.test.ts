import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Audit 2026-09-28 #4 — server và browser PHẢI cùng dùng private channel (0020). Lệch một
 * phía (server private + client public hay ngược lại) = client không nhận event nào, nên
 * khoá cấu hình ở mức unit: REST body, fallback channel và client channel đều `private`.
 * Hành vi quyền thật (owner/non-owner/anon) nằm ở tests/integration/realtime-private-channel.test.ts.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://supabase.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }),
  getServerEnv: () => ({ SUPABASE_SERVICE_ROLE_KEY: "service" }),
}));

const serverChannelSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: () => ({
    channel: (name: string, opts: unknown) => {
      serverChannelSpy(name, opts);
      return {
        subscribe: (cb: (status: string) => void) => cb("CLOSED"),
        send: () => Promise.resolve("ok"),
      };
    },
    removeChannel: () => Promise.resolve("ok"),
  }),
}));

const EVENT = { type: "conn.degraded" } as const;

function makeBrowserClient(order: string[]) {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn(() => order.push("subscribe")),
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(() => Promise.resolve("ok")),
    realtime: { setAuth: vi.fn(async () => void order.push("setAuth")) },
  };
  return { client, channel };
}

afterEach(() => {
  vi.unstubAllGlobals();
  serverChannelSpy.mockClear();
});

describe("realtime private channel config", () => {
  test("test_broadcast_rest_sends_private_message_on_session_topic", async () => {
    // Arrange
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    await broadcastEvent("11111111-1111-1111-1111-111111111111", EVENT as never);

    // Assert
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages).toEqual([
      { topic: "session:11111111-1111-1111-1111-111111111111", event: "conn.degraded", payload: EVENT, private: true },
    ]);
    expect(serverChannelSpy).not.toHaveBeenCalled();
  });

  test("test_broadcast_fallback_after_rest_failure_opens_private_channel", async () => {
    // Arrange
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { broadcastEvent } = await import("@/lib/realtime/broadcast-server");

    // Act
    await broadcastEvent("22222222-2222-2222-2222-222222222222", EVENT as never);

    // Assert
    expect(serverChannelSpy).toHaveBeenCalledWith("session:22222222-2222-2222-2222-222222222222", {
      config: { private: true, broadcast: { self: false } },
    });
  });

  test("test_subscribe_client_joins_private_channel_after_set_auth", async () => {
    // Arrange
    const order: string[] = [];
    const { client, channel } = makeBrowserClient(order);
    const { subscribeSessionChannel } = await import("@/lib/realtime/subscribe-client");

    // Act
    subscribeSessionChannel({ sessionId: "33333333-3333-3333-3333-333333333333", onEvent: vi.fn(), client: client as never });
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));

    // Assert
    expect(client.channel).toHaveBeenCalledWith("session:33333333-3333-3333-3333-333333333333", {
      config: { private: true },
    });
    expect(order).toEqual(["setAuth", "subscribe"]);
  });

  test("test_subscribe_client_unsubscribed_before_set_auth_resolves_never_joins", async () => {
    // Arrange
    const { client, channel } = makeBrowserClient([]);
    let releaseAuth: () => void = () => undefined;
    client.realtime.setAuth = vi.fn(() => new Promise<void>((resolve) => (releaseAuth = resolve)));
    const { subscribeSessionChannel } = await import("@/lib/realtime/subscribe-client");

    // Act
    const unsubscribe = subscribeSessionChannel({ sessionId: "44444444-4444-4444-4444-444444444444", onEvent: vi.fn(), client: client as never });
    unsubscribe();
    releaseAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Assert
    expect(channel.subscribe).not.toHaveBeenCalled();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });
});
