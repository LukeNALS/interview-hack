import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route/lib dưới test có `import "server-only"` — mock rỗng để chạy được dưới vitest (P05).
vi.mock("server-only", () => ({}));

/**
 * Integration test cho POST /api/sessions/:id/start — route giờ gọi RPC `start_session`
 * (0018, port từ interview-copilot fix/session-quota-lockdown) thay vì
 * debit_free_session + update tách rời. Mock chỉ còn spy vào `rpc("start_session", ...)`,
 * KHÔNG còn spy `.update()` trên sessions (route không tự update nữa — RPC làm hết dưới
 * quyền owner, atomic thật).
 */

interface FakeResult {
  data: unknown;
  error: unknown;
}

let sessionSelectResult: FakeResult = { data: { id: "session-1", status: "prep" }, error: null };
let startSessionResult: FakeResult = {
  data: { started_at: "2026-08-12T00:00:00.000Z", cap_seconds: 5400, mode: "direct", status: "live" },
  error: null,
};
const startSessionRpcSpy = vi.fn();

function makeFakeClient() {
  const from = vi.fn((table: string) => {
    if (table !== "sessions") throw new Error(`bảng không mong đợi trong test: ${table}`);
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => sessionSelectResult }),
      }),
    };
  });
  // Route /start nay có rate limit (M11) → gọi RPC `bump_rate_limit` TRƯỚC
  // `start_session`. Mock phải phân nhánh theo tên hàm: trả `startSessionResult`
  // cho mọi RPC sẽ khiến bump nhận data khác `true` → 429 giả.
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    if (fn === "bump_rate_limit") return { data: true, error: null };
    startSessionRpcSpy(fn, args);
    return startSessionResult;
  });
  const auth = { getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null })) };
  return { from, rpc, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeFakeClient()),
}));

const { POST } = await import("@/app/api/sessions/[id]/start/route");

function makeRequest(body?: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/sessions/:id/start", () => {
  beforeEach(() => {
    sessionSelectResult = { data: { id: "session-1", status: "prep" }, error: null };
    startSessionResult = {
      data: { started_at: "2026-08-12T00:00:00.000Z", cap_seconds: 5400, mode: "direct", status: "live" },
      error: null,
    };
    startSessionRpcSpy.mockClear();
  });

  test("test_start_session_success_sets_live_status_and_returns_cap_seconds", async () => {
    // Arrange — mặc định beforeEach: status='prep', start_session thành công
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { started_at: string; cap_seconds: number };
    // Assert
    expect(res.status).toBe(200);
    expect(body.cap_seconds).toBe(5400);
    expect(body.started_at).toBe("2026-08-12T00:00:00.000Z");
    expect(startSessionRpcSpy).toHaveBeenCalledWith("start_session", { p_session: "session-1" });
  });

  test("test_start_session_with_zero_free_sessions_returns_409_no_free_sessions", async () => {
    // Arrange — RPC start_session raise "hết buổi free" (P0001, xem 0018_atomic_session_lifecycle_rpcs.sql)
    startSessionResult = { data: null, error: { message: "hết buổi free" } };
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("no_free_sessions");
  });

  test("test_start_session_when_not_prep_status_returns_409_invalid_session_status", async () => {
    // Arrange — session đã live (double start hoặc reload nhầm màn) — route reject
    // Ở TẦNG PRE-CHECK (trước khi gọi RPC), khớp hành vi cũ.
    sessionSelectResult = { data: { id: "session-1", status: "live" }, error: null };
    // Act
    const res = await POST(makeRequest(), makeCtx());
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("invalid_session_status");
    expect(startSessionRpcSpy).not.toHaveBeenCalled();
  });

  test("test_start_session_with_mode_body_persists_picked_mode", async () => {
    // Arrange — BUG #4: chế độ chọn ở màn setup phải được CHỐT lên server ngay lúc /start,
    // vì màn live đọc `mode` từ server (chọn "trực tiếp" mà server còn 'online' -> bị hỏi
    // chia sẻ tab giữa buổi).
    startSessionResult = {
      data: { started_at: "2026-08-12T00:00:00.000Z", cap_seconds: 5400, mode: "direct", status: "live" },
      error: null,
    };

    // Act
    const res = await POST(makeRequest({ mode: "direct" }), makeCtx());
    const body = (await res.json()) as { mode: string };

    // Assert
    expect(res.status).toBe(200);
    expect(startSessionRpcSpy).toHaveBeenCalledWith("start_session", { p_session: "session-1", p_mode: "direct" });
    expect(body.mode).toBe("direct");
  });

  test("test_start_session_without_mode_body_keeps_existing_mode", async () => {
    // Arrange — caller cũ POST không body: KHÔNG được truyền p_mode (RPC coalesce giữ mode cũ).
    // Act
    const res = await POST(makeRequest(), makeCtx());

    // Assert
    expect(res.status).toBe(200);
    expect(startSessionRpcSpy).toHaveBeenCalledWith("start_session", { p_session: "session-1" });
  });

  test("test_start_session_with_invalid_mode_returns_400_validation_error", async () => {
    // Arrange — mode lạ (client cũ/nghịch tay) phải bị zod chặn, không tới RPC.
    // Act
    const res = await POST(makeRequest({ mode: "hybrid" }), makeCtx());
    const body = (await res.json()) as { error: { code: string } };

    // Assert
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(startSessionRpcSpy).not.toHaveBeenCalled();
  });

  test("test_start_session_not_owned_returns_404", async () => {
    // Arrange — session không tồn tại/không thuộc user (RLS trả 0 dòng)
    sessionSelectResult = { data: null, error: null };
    // Act
    const res = await POST(makeRequest(), makeCtx("other-session"));
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});
