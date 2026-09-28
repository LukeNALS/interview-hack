import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/**
 * Integration test cho POST /api/sessions/:id/end — route giờ gọi RPC `end_session`
 * (0018, port từ interview-copilot fix/session-quota-lockdown) thay vì tự update +
 * refund tách rời. Interview Hack (chỉ ứng viên) không còn report job — end_session
 * chốt THẲNG status='done', khớp hành vi route trước khi port. Mock chỉ còn spy vào
 * `rpc("end_session", ...)`, KHÔNG còn spy `.update()` trên sessions (route không tự
 * update nữa — RPC làm hết dưới quyền owner).
 */

interface SessionFixture {
  id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  ended_reason: string | null;
}

interface EndSessionRpcRow {
  id: string;
  status: string;
  ended_at: string;
  duration_sec: number;
  ended_reason: string;
}

let sessionFixture: SessionFixture;
let endSessionResult: { data: EndSessionRpcRow | null; error: { message: string } | null };
const endSessionRpcSpy = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionsBuilder(): any {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: sessionFixture, error: null }),
  };
  return builder;
}

function makeUserClient() {
  const from = vi.fn((table: string) => {
    if (table === "sessions") return sessionsBuilder();
    throw new Error(`bảng không mong đợi trong test: ${table}`);
  });
  // Route /end nay có rate limit (M11) → `bump_rate_limit` chạy trước mọi thứ.
  // Trả sớm TRƯỚC `endSessionRpcSpy` để bump không bị đếm nhầm thành lần kết thúc.
  const rpc = vi.fn((fn: string, args: unknown) => {
    if (fn === "bump_rate_limit") return Promise.resolve({ data: true, error: null });
    endSessionRpcSpy(fn, args);
    return Promise.resolve(endSessionResult);
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
    endSessionRpcSpy.mockClear();
  });

  test("test_end_session_shorter_than_five_minutes_refunds_free_session", async () => {
    // Arrange — buổi live 4 phút (< ngưỡng 300s) — RPC tự hoàn quota nội bộ, route
    // chỉ cần gọi đúng RPC với đúng session id (RPC guard double-refund ở tầng DB).
    sessionFixture = {
      id: "session-1",
      status: "live",
      started_at: minutesAgoIso(4),
      ended_at: null,
      duration_sec: null,
      ended_reason: null,
    };
    endSessionResult = {
      data: { id: "session-1", status: "done", ended_at: new Date().toISOString(), duration_sec: 240, ended_reason: "user" },
      error: null,
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.duration_sec).toBeLessThan(300);
    expect(endSessionRpcSpy).toHaveBeenCalledWith("end_session", { p_session: "session-1" });
  });

  test("test_end_session_longer_than_five_minutes_does_not_refund", async () => {
    // Arrange — buổi live 20 phút (>= ngưỡng 300s) — RPC tự quyết định không refund.
    sessionFixture = {
      id: "session-1",
      status: "live",
      started_at: minutesAgoIso(20),
      ended_at: null,
      duration_sec: null,
      ended_reason: null,
    };
    endSessionResult = {
      data: { id: "session-1", status: "done", ended_at: new Date().toISOString(), duration_sec: 1200, ended_reason: "user" },
      error: null,
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.duration_sec).toBeGreaterThanOrEqual(300);
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
    endSessionResult = {
      data: { id: "session-1", status: "done", ended_at: new Date().toISOString(), duration_sec: 1200, ended_reason: "user" },
      error: null,
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — done thẳng, ended_reason='user' (enum DB không có 'manual')
    expect(res.status).toBe(200);
    expect(body.status).toBe("done");
    expect(body.ended_reason).toBe("user");
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
    endSessionResult = {
      data: { id: "session-1", status: "done", ended_at: new Date().toISOString(), duration_sec: 5400, ended_reason: "cap" },
      error: null,
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
    // Arrange — session đã ended_at + status='done' từ trước (route rẽ nhánh alreadyEnded
    // TRƯỚC KHI gọi RPC — không cần mock end_session cho ca này).
    sessionFixture = {
      id: "session-1",
      status: "done",
      started_at: minutesAgoIso(90),
      ended_at: minutesAgoIso(1),
      duration_sec: 5340,
      ended_reason: "cap",
    };
    const { POST } = await import("@/app/api/sessions/[id]/end/route");

    // Act — gọi 2 lần: cả 2 đều phải idempotent (0 lần gọi end_session).
    const res1 = await POST(makeRequest(), makeCtx());
    const body1 = await res1.json();
    const res2 = await POST(makeRequest(), makeCtx());
    const body2 = await res2.json();

    // Assert
    expect(res1.status).toBe(200);
    expect(body1.status).toBe("done");
    expect(res2.status).toBe(200);
    expect(body2.ended_at).toBe(body1.ended_at);
    expect(endSessionRpcSpy).not.toHaveBeenCalled();
  });
});
