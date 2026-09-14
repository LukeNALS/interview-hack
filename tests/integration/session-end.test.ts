import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/**
 * Integration test cho POST /api/sessions/:id/end — Interview Hack (chỉ ứng
 * viên) chốt buổi thẳng status='done', KHÔNG còn report job (report_jobs
 * marker/skip_report đã bị xoá cùng tính năng người phỏng vấn). Mock Supabase
 * bespoke (chainable, chỉ còn 1 client — route không dùng service-role nữa).
 */

interface SessionFixture {
  id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  ended_reason: string | null;
}

let sessionFixture: SessionFixture;
const refundRpcSpy = vi.fn();
const sessionUpdateSpy = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionsBuilder(): any {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: sessionFixture, error: null }),
    update: (payload: Record<string, unknown>) => {
      sessionUpdateSpy(payload);
      Object.assign(sessionFixture, payload);
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
  };
  return builder;
}

function makeUserClient() {
  const from = vi.fn((table: string) => {
    if (table === "sessions") return sessionsBuilder();
    throw new Error(`bảng không mong đợi trong test: ${table}`);
  });
  // Route /end nay có rate limit (M11) → `bump_rate_limit` chạy trước mọi thứ.
  // Trả sớm TRƯỚC `refundRpcSpy` để bump không bị đếm nhầm thành lần hoàn quota.
  const rpc = vi.fn((fn: string, args: unknown) => {
    if (fn === "bump_rate_limit") return Promise.resolve({ data: true, error: null });
    refundRpcSpy(fn, args);
    return Promise.resolve({ data: 2, error: null });
  });
  const auth = { getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null })) };
  return { from, rpc, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeUserClient()),
}));

function makeRequest(): NextRequest {
  return { json: async () => ({}) } as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe("POST /api/sessions/:id/end", () => {
  beforeEach(() => {
    refundRpcSpy.mockClear();
    sessionUpdateSpy.mockClear();
  });

  test("test_end_session_shorter_than_five_minutes_refunds_free_session", async () => {
    // Arrange — buổi live 4 phút (< ngưỡng 300s)
    sessionFixture = {
      id: "session-1",
      status: "live",
      started_at: minutesAgoIso(4),
      ended_at: null,
      duration_sec: null,
      ended_reason: null,
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.duration_sec).toBeLessThan(300);
    expect(refundRpcSpy).toHaveBeenCalledWith("refund_free_session", { p_session: "session-1" });
  });

  test("test_end_session_longer_than_five_minutes_does_not_refund", async () => {
    // Arrange — buổi live 20 phút (>= ngưỡng 300s)
    sessionFixture = {
      id: "session-1",
      status: "live",
      started_at: minutesAgoIso(20),
      ended_at: null,
      duration_sec: null,
      ended_reason: null,
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.duration_sec).toBeGreaterThanOrEqual(300);
    expect(refundRpcSpy).not.toHaveBeenCalled();
  });

  test("test_end_session_from_live_sets_status_done_directly", async () => {
    // Arrange — buổi live 20 phút — Interview Hack không còn report job, mọi
    // lần kết thúc thủ công đi thẳng status='done'.
    sessionFixture = {
      id: "session-1",
      status: "live",
      started_at: minutesAgoIso(20),
      ended_at: null,
      duration_sec: null,
      ended_reason: null,
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — done thẳng, ended_reason='user' (enum DB không có 'manual')
    expect(res.status).toBe(200);
    expect(body.status).toBe("done");
    expect(body.ended_reason).toBe("user");
    expect(sessionUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "done", ended_reason: "user" }));
  });

  test("test_end_session_cap_pending_also_sets_status_done", async () => {
    // Arrange — buổi đã bị cap (processing/cap, chưa qua /end) — vẫn chốt thẳng 'done'.
    sessionFixture = {
      id: "session-1",
      status: "processing",
      started_at: minutesAgoIso(90),
      ended_at: null,
      duration_sec: null,
      ended_reason: "cap",
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.status).toBe("done");
    expect(body.ended_reason).toBe("cap");
  });

  test("test_end_session_already_done_is_idempotent_no_side_effect", async () => {
    // Arrange — P05 đã đánh dấu status='processing'+ended_reason='cap' lúc cap 90' nhưng chưa qua /end.
    sessionFixture = {
      id: "session-1",
      status: "processing",
      started_at: minutesAgoIso(90),
      ended_at: null,
      duration_sec: null,
      ended_reason: "cap",
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act — gọi 2 lần: lần 1 xử lý thật, lần 2 phải idempotent (0 side-effect thêm).
    const res1 = await POST(makeRequest(), makeCtx());
    const body1 = await res1.json();
    sessionUpdateSpy.mockClear();
    const res2 = await POST(makeRequest(), makeCtx());
    const body2 = await res2.json();

    // Assert
    expect(res1.status).toBe(200);
    expect(body1.status).toBe("done");
    expect(res2.status).toBe(200);
    expect(body2.ended_at).toBe(body1.ended_at);
    expect(sessionUpdateSpy).not.toHaveBeenCalled();
  });
});
