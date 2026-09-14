import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route/lib dưới test có `import "server-only"` — mock rỗng để chạy được dưới vitest (P05).
vi.mock("server-only", () => ({}));

/**
 * Integration test cho POST /api/sessions/:id/soniox-key — mock Supabase +
 * global fetch (Soniox REST temp-key, KHÔNG gọi API thật), AAA, khớp tên
 * test phase-05 bước 17.
 */

interface FakeResult {
  data: unknown;
  error: unknown;
}

let sessionSelectResult: FakeResult = {
  data: { id: "session-1", status: "live", started_at: new Date().toISOString(), cap_seconds: 5400 },
  error: null,
};
let emailConfirmedAt: string | null = "2026-01-01T00:00:00Z";

function makeFakeClient() {
  const from = vi.fn((table: string) => {
    if (table !== "sessions") throw new Error(`bảng không mong đợi trong test: ${table}`);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => sessionSelectResult }) }) };
  });
  // bump_rate_limit — fail-open mặc định (true), không test rate-limit-exceeded ở đây.
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const auth = { getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: emailConfirmedAt } }, error: null })) };
  return { from, rpc, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeFakeClient()),
}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    SONIOX_API_KEY: "soniox-real-key-test",
    ANTHROPIC_API_KEY: "x",
    SUPABASE_SERVICE_ROLE_KEY: "x",
  }),
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

const { POST } = await import("@/app/api/sessions/[id]/soniox-key/route");

function makeRequest(): NextRequest {
  return { json: async () => undefined } as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ api_key: "temp:abc123", expires_at: "2026-08-12T02:00:00.000Z" }),
  text: async () => "",
}));

describe("POST /api/sessions/:id/soniox-key", () => {
  beforeEach(() => {
    sessionSelectResult = {
      data: { id: "session-1", status: "live", started_at: new Date().toISOString(), cap_seconds: 5400 },
      error: null,
    };
    emailConfirmedAt = "2026-01-01T00:00:00Z";
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("test_soniox_key_success_returns_keys_array_and_expires_at", async () => {
    // Arrange — session live, chưa chạm cap (mặc định beforeEach)
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { keys: string[]; expires_at: string };
    // Assert
    expect(res.status).toBe(200);
    expect(body.keys).toEqual(["temp:abc123"]);
    expect(body.expires_at).toBe("2026-08-12T02:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.soniox.com/v1/auth/temporary-api-key",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer soniox-real-key-test" }),
      }),
    );
  });

  test("test_soniox_key_when_elapsed_exceeds_cap_returns_403_cap_reached", async () => {
    // Arrange — started_at 6000s trước (> cap_seconds=5400)
    sessionSelectResult = {
      data: {
        id: "session-1",
        status: "live",
        started_at: new Date(Date.now() - 6000 * 1000).toISOString(),
        cap_seconds: 5400,
      },
      error: null,
    };
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("cap_reached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("test_soniox_key_when_session_not_live_returns_409_invalid_session_status", async () => {
    // Arrange — session chưa start (status='prep')
    sessionSelectResult = { data: { id: "session-1", status: "prep", started_at: null, cap_seconds: 5400 }, error: null };
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("invalid_session_status");
  });

  test("test_soniox_key_email_not_confirmed_returns_403", async () => {
    // Arrange
    emailConfirmedAt = null;
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("email_not_confirmed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
