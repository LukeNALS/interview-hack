import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route/lib dưới test có `import "server-only"` — mock rỗng để chạy được dưới vitest (P05).
vi.mock("server-only", () => ({}));

/**
 * Integration test cho POST /api/sessions/:id/soniox-key — mock Supabase +
 * global fetch (Soniox REST temp-key, KHÔNG gọi API thật), AAA. Route cấp 1
 * CẶP key single-use (canonical + en); thời gian đóng băng để `elapsed` tất định.
 */

interface FakeResult {
  data: unknown;
  error: unknown;
}

const NOW = new Date("2026-09-29T12:00:00.000Z");

function liveSession(overrides: Record<string, unknown> = {}): FakeResult {
  return {
    data: {
      id: "session-1",
      status: "live",
      started_at: new Date(NOW.getTime() - 600 * 1000).toISOString(),
      cap_seconds: 5400,
      ...overrides,
    },
    error: null,
  };
}

let sessionSelectResult: FakeResult = liveSession();
let infoSpy: ReturnType<typeof vi.spyOn>;
let emailConfirmedAt: string | null = "2026-01-01T00:00:00Z";

function makeFakeClient() {
  const from = vi.fn((table: string) => {
    if (table !== "sessions") throw new Error(`bảng không mong đợi trong test: ${table}`);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => sessionSelectResult }) }) };
  });
  // bump_rate_limit trả true (cho qua) — ca chặn rate limit nằm ở rate-limit.test.ts.
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

interface KeyBody {
  usage_type: string;
  expires_in_seconds: number;
  single_use: boolean;
  max_session_duration_seconds: number;
  client_reference_id: string;
}

interface FakeFetchResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

let mintCount = 0;
const fetchMock = vi.fn<(url: string, init: { body: string }) => Promise<FakeFetchResponse>>(async () => {
  // Chốt số thứ tự lúc GỌI — 2 mint chạy song song, đọc `mintCount` muộn (trong json()) sẽ ra 2 key trùng.
  const n = ++mintCount;
  return {
    ok: true,
    json: async () => ({ api_key: `temp:key-${n}`, expires_at: `2026-09-29T12:01:0${n}.000Z` }),
    text: async () => "",
  };
});

function mintedBodies(): KeyBody[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(call[1].body) as KeyBody);
}

describe("POST /api/sessions/:id/soniox-key", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    sessionSelectResult = liveSession();
    emailConfirmedAt = "2026-01-01T00:00:00Z";
    mintCount = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("test_soniox_key_success_returns_two_distinct_keys_for_one_connection_pair", async () => {
    // Arrange — session live, chưa chạm cap (mặc định beforeEach)
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { keys: string[]; expires_at: string };
    // Assert
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.soniox.com/v1/auth/temporary-api-key",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer soniox-real-key-test" }),
      }),
    );
    expect(body.keys).toHaveLength(2);
    expect(new Set(body.keys).size).toBe(2);
  });

  test("test_soniox_key_expires_at_is_earliest_of_the_two_keys", async () => {
    // Arrange — mint lần 1 hết hạn :01, lần 2 hết hạn :02 (mock theo thứ tự gọi)
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { expires_at: string };
    // Assert
    expect(body.expires_at).toBe("2026-09-29T12:01:01.000Z");
  });

  test("test_soniox_key_mint_payload_is_single_use_short_ttl_with_remaining_duration_and_session_reference", async () => {
    // Arrange — started_at = now − 600 s, cap 5400 ⇒ còn 4800 s
    // Act
    await POST(makeRequest(), makeCtx());
    // Assert — CẢ 2 lần mint cùng payload
    expect(mintedBodies()).toEqual([
      {
        usage_type: "transcribe_websocket",
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: 4800,
        client_reference_id: "session-1",
      },
      {
        usage_type: "transcribe_websocket",
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: 4800,
        client_reference_id: "session-1",
      },
    ]);
  });

  test("test_soniox_key_remaining_duration_is_clamped_to_provider_max_18000", async () => {
    // Arrange — cap 30000 s, vừa start (elapsed 0) ⇒ còn 30000 > giới hạn provider 18000
    sessionSelectResult = liveSession({ cap_seconds: 30000, started_at: NOW.toISOString() });
    // Act
    await POST(makeRequest(), makeCtx());
    // Assert
    expect(mintedBodies().map((b) => b.max_session_duration_seconds)).toEqual([18000, 18000]);
  });

  test("test_soniox_key_when_one_mint_fails_returns_502_soniox_key_failed", async () => {
    // Arrange — mint thứ 2 bị Soniox từ chối
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ api_key: "temp:ok", expires_at: "2026-09-29T12:01:00.000Z" }),
      text: async () => "",
    }));
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(502);
    expect(body.error.code).toBe("soniox_key_failed");
  });

  test("test_soniox_key_when_soniox_body_has_no_api_key_returns_502_soniox_key_failed", async () => {
    // Arrange — Soniox trả 200 nhưng body không có api_key
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({}), text: async () => "" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(502);
    expect(body.error.code).toBe("soniox_key_failed");
  });

  test("test_soniox_key_success_logs_mint_latency_without_key_material", async () => {
    // Arrange — infoSpy đã bật ở beforeEach
    // Act
    await POST(makeRequest(), makeCtx());
    // Assert — có số đo độ trễ + còn lại, KHÔNG có giá trị key hay expires_at
    expect(infoSpy).toHaveBeenCalledWith(
      "[soniox-key] issued",
      expect.objectContaining({ session_id: "session-1", soniox_ms: expect.any(Number), remaining_s: 4800 }),
    );
    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged).not.toContain("temp:key-");
    expect(logged).not.toContain("soniox-real-key-test");
    expect(logged).not.toContain("2026-09-29T12:01");
  });

  test("test_soniox_key_when_elapsed_exceeds_cap_returns_403_cap_reached", async () => {
    // Arrange — started_at 6000s trước (> cap_seconds=5400)
    sessionSelectResult = liveSession({ started_at: new Date(NOW.getTime() - 6000 * 1000).toISOString() });
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
    expect(fetchMock).not.toHaveBeenCalled();
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
