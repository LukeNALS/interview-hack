import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route/lib dưới test có `import "server-only"` — mock rỗng để chạy dưới vitest.
vi.mock("server-only", () => ({}));

/**
 * Integration test rate limit — Interview Hack (chỉ ứng viên) chỉ còn các
 * endpoint LLM-backed/destructive sau: `/utterances` (theo session), `/soniox-key`
 * (theo session), `/sessions` create/start/end (theo user). Các nhóm từng có ở
 * đây (generate-questions, cv, report/steps/*, export-pdf, share, `/r/[token]`)
 * đã bị xoá cùng tính năng người phỏng vấn.
 *
 * Mục tiêu: chứng minh rate limit **thật sự chặn** chứ không chỉ có mặt —
 * mỗi endpoint assert (a) RPC `bump_rate_limit` trả false → 429 +
 * `rate_limit_exceeded`, (b) key ĐÚNG SCOPE (user-scoped chứa userId,
 * session-scoped chứa sessionId và KHÔNG chứa userId), (c) trả true → đi tiếp
 * bình thường.
 *
 * Mock Supabase bespoke (pattern questions-crud.test.ts cũ: chainable per-table
 * + rpc phân nhánh theo tên) — KHÔNG gọi API/DB thật.
 */

interface BumpCall {
  key: string;
  window: string;
  limit: number;
}

/** Ghi lại mọi lần gọi RPC `bump_rate_limit` để assert key/scope/ngưỡng. */
let bumpCalls: BumpCall[] = [];
let rateLimitAllowed = true;
/**
 * Lỗi RPC (khác "vượt ngưỡng"). `code` mô phỏng SQLSTATE của PostgrestError:
 * `"42501"` = permission denied → fail-CLOSED (H3); mọi code khác/không có =
 * lỗi hạ tầng → fail-open.
 */
let rateLimitRpcError: { message: string; code?: string } | null = null;
let sessionRow: Record<string, unknown> | null = null;
let utteranceRows: Array<Record<string, unknown>> = [];
let authUserId = "user-1";

/**
 * Op GHI đã thực sự chạm bảng (insert/update/upsert/delete) + tên mọi RPC đã
 * gọi. Cần để assert "bị chặn thì KHÔNG có tác dụng phụ" có nghĩa — mock luôn
 * trả success nên chỉ đếm được bằng spy, không suy ra từ response [M11].
 */
let tableOps: Array<{ table: string; op: string }> = [];
let rpcCalls: string[] = [];

const MUTATING_OPS = new Set(["update", "delete", "insert", "upsert"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chainable(result: { data: unknown; error: unknown }, table = "unknown"): any {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gt", "order", "limit", "update", "delete", "insert", "upsert"]) {
    obj[m] = vi.fn(() => {
      if (MUTATING_OPS.has(m)) tableOps.push({ table, op: m });
      return obj;
    });
  }
  obj.single = vi.fn(async () => result);
  obj.maybeSingle = vi.fn(async () => result);
  obj.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  return obj;
}

function makeFakeClient() {
  const from = vi.fn((table: string) => {
    if (table === "sessions") return chainable({ data: sessionRow, error: null }, table);
    if (table === "utterances") return chainable({ data: utteranceRows, error: null }, table);
    return chainable({ data: null, error: null }, table);
  });

  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push(fn);
    if (fn === "bump_rate_limit") {
      bumpCalls.push({
        key: args.p_key as string,
        window: args.p_window as string,
        limit: args.p_limit as number,
      });
      if (rateLimitRpcError) return { data: null, error: rateLimitRpcError };
      return { data: rateLimitAllowed, error: null };
    }
    if (fn === "next_utterance_seq") return { data: 1, error: null };
    return { data: null, error: null };
  });

  const auth = {
    getUser: vi.fn(async () => ({
      data: { user: { id: authUserId, email_confirmed_at: "2026-01-01T00:00:00Z" } },
      error: null,
    })),
  };

  return { from, rpc, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeFakeClient()),
  createServiceRoleClient: vi.fn(() => makeFakeClient()),
}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    SONIOX_API_KEY: "x",
    ANTHROPIC_API_KEY: "x",
    SUPABASE_SERVICE_ROLE_KEY: "x",
  }),
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  }),
}));

vi.mock("@/lib/realtime/broadcast-server", () => ({ broadcastEvent: vi.fn(async () => undefined) }));

const { checkRateLimit, getClientIp } = await import("@/lib/rate-limit");
const { POST: utterancesPost } = await import("@/app/api/sessions/[id]/utterances/route");
const { POST: sonioxKeyPost } = await import("@/app/api/sessions/[id]/soniox-key/route");
const { POST: sessionCreatePost } = await import("@/app/api/sessions/route");
const { POST: sessionStartPost } = await import("@/app/api/sessions/[id]/start/route");
const { POST: sessionEndPost } = await import("@/app/api/sessions/[id]/end/route");

function makeRequest(body?: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

function liveSessionRow(overrides: Record<string, unknown> = {}) {
  return { id: "session-1", status: "live", started_at: new Date().toISOString(), cap_seconds: 5400, ...overrides };
}

function bumpCallFor(prefix: string): BumpCall {
  const call = bumpCalls.find((c) => c.key.startsWith(`${prefix}:`));
  if (!call) throw new Error(`không có lần bump_rate_limit nào cho prefix "${prefix}" (đã bump: ${bumpCalls.map((c) => c.key).join(", ") || "none"})`);
  return call;
}

/** Op ghi đã chạm bảng `table` — dùng để assert "chặn thì không side-effect". */
function mutationsOn(table: string): Array<{ table: string; op: string }> {
  return tableOps.filter((o) => o.table === table);
}

beforeEach(() => {
  bumpCalls = [];
  tableOps = [];
  rpcCalls = [];
  rateLimitAllowed = true;
  rateLimitRpcError = null;
  sessionRow = null;
  utteranceRows = [];
  authUserId = "user-1";
});

describe("rate limit — POST /api/sessions/:id/utterances (session-scoped)", () => {
  beforeEach(() => {
    sessionRow = liveSessionRow();
    // Utterance đã tồn tại theo client_utt_id → route đi nhánh update, không cần insert.
    utteranceRows = [
      {
        id: "utt-1",
        seq: 1,
        client_utt_id: "c1",
        speaker: "candidate",
        lang: "vi",
        text_orig: "Xin chào",
        question_id: null,
        t_start_ms: 0,
      },
    ];
  });

  function ingestBody() {
    return { utterances: [{ client_utt_id: "c1", speaker: "candidate", lang: "vi", text_orig: "Xin chào" }] };
  }

  test("test_rate_limit_utterances_when_minute_bucket_exceeded_returns_429_rate_limit_exceeded", async () => {
    // Arrange
    rateLimitAllowed = false;

    // Act
    const res = await utterancesPost(makeRequest(ingestBody()), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  test("test_rate_limit_utterances_uses_two_session_scoped_buckets_minute_and_burst", async () => {
    // Arrange — cho qua để route bump đủ cả 2 bucket
    rateLimitAllowed = true;

    // Act
    const res = await utterancesPost(makeRequest(ingestBody()), makeCtx());

    // Assert — 60/phút + 20/10s, key theo SESSION (không theo user)
    expect(res.status).toBe(200);
    expect(bumpCalls).toEqual([
      { key: "utterances:min:session-1", window: "60 seconds", limit: 60 },
      { key: "utterances:burst:session-1", window: "10 seconds", limit: 20 },
    ]);
    for (const call of bumpCalls) expect(call.key).not.toContain("user-1");
  });

  test("test_rate_limit_utterances_key_is_scoped_per_session_not_shared_across_sessions", async () => {
    // Arrange — cùng user, session khác
    rateLimitAllowed = false;

    // Act
    await utterancesPost(makeRequest(ingestBody()), makeCtx("session-2"));

    // Assert — bucket riêng cho session-2 (1 session ồn không chặn session khác của cùng user)
    expect(bumpCalls[0].key).toBe("utterances:min:session-2");
  });
});

describe("rate limit — POST /api/sessions/:id/soniox-key (session-scoped)", () => {
  beforeEach(() => {
    sessionRow = liveSessionRow();
  });

  test("test_rate_limit_soniox_key_when_bump_returns_false_returns_429_rate_limit_exceeded", async () => {
    // Arrange — session live, chưa chạm cap; RPC trả false
    rateLimitAllowed = false;

    // Act
    const res = await sonioxKeyPost(makeRequest({}), makeCtx());
    const body = await res.json();

    // Assert — 60 key/giờ/session
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(bumpCallFor("soniox-key")).toEqual({ key: "soniox-key:session-1", window: "3600 seconds", limit: 60 });
    expect(bumpCallFor("soniox-key").key).not.toContain("user-1");
  });
});

/**
 * M11 — rate limit trên các đường mutation `/sessions`. Khác nhóm session-scoped
 * ở chỗ phải chứng minh chặn xảy ra TRƯỚC tác dụng phụ: mock luôn trả success nên
 * "không insert/update/RPC" chỉ assert được qua spy đếm (`tableOps`, `rpcCalls`),
 * không suy ra từ status code.
 */
describe("rate limit — POST /api/sessions (tạo session)", () => {
  const body = { mode: "online" as const };

  test("test_rate_limit_session_create_when_bump_returns_false_returns_429_and_inserts_nothing", async () => {
    // Arrange — đã tạo 30 session trong giờ
    rateLimitAllowed = false;

    // Act
    const res = await sessionCreatePost(makeRequest(body), makeCtx());
    const resBody = await res.json();

    // Assert — chặn TRƯỚC insert (không rác session trong DB)
    expect(res.status).toBe(429);
    expect(resBody.error.code).toBe("rate_limit_exceeded");
    expect(bumpCallFor("session-create")).toEqual({
      key: "session-create:user-1",
      window: "3600 seconds",
      limit: 30,
    });
    expect(mutationsOn("sessions")).toEqual([]);
  });

  test("test_rate_limit_session_create_when_bump_returns_true_inserts_session_and_returns_201", async () => {
    // Arrange
    rateLimitAllowed = true;
    sessionRow = { id: "session-1", status: "prep", mode: "online", created_at: "2026-08-17T00:00:00Z" };

    // Act
    const res = await sessionCreatePost(makeRequest(body), makeCtx());

    // Assert — qua cổng và chạm insert thật
    expect(res.status).toBe(201);
    expect(mutationsOn("sessions").map((o) => o.op)).toContain("insert");
  });

  test("test_rate_limit_session_create_key_is_scoped_per_user_not_shared_across_users", async () => {
    // Arrange
    rateLimitAllowed = false;
    authUserId = "user-2";

    // Act
    await sessionCreatePost(makeRequest(body), makeCtx());

    // Assert
    expect(bumpCallFor("session-create").key).toBe("session-create:user-2");
  });
});

describe("rate limit — POST /api/sessions/:id/start (trước khi trừ quota)", () => {
  test("test_rate_limit_session_start_when_bump_returns_false_returns_429_without_debiting_quota", async () => {
    // Arrange — session sẵn sàng start: nếu chặn đặt SAU RPC thì user mất
    // buổi free mà buổi không bắt đầu được
    rateLimitAllowed = false;
    sessionRow = { id: "session-1", status: "prep" };

    // Act
    const res = await sessionStartPost(makeRequest({}), makeCtx());
    const body = await res.json();

    // Assert — quota nguyên vẹn, session không đổi trạng thái
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(bumpCallFor("session-start")).toEqual({
      key: "session-start:user-1",
      window: "3600 seconds",
      limit: 60,
    });
    expect(rpcCalls).not.toContain("debit_free_session");
    expect(mutationsOn("sessions")).toEqual([]);
  });

  test("test_rate_limit_session_start_when_bump_returns_true_debits_quota_and_starts", async () => {
    // Arrange
    rateLimitAllowed = true;
    sessionRow = {
      id: "session-1",
      status: "prep",
      started_at: "2026-08-17T00:00:00Z",
      cap_seconds: 5400,
      mode: "online",
    };

    // Act
    const res = await sessionStartPost(makeRequest({}), makeCtx());
    const body = await res.json();

    // Assert — qua cổng thì mới trừ quota
    expect(res.status).toBe(200);
    expect(body.started_at).toBe("2026-08-17T00:00:00Z");
    expect(rpcCalls).toContain("debit_free_session");
  });
});

describe("rate limit — POST /api/sessions/:id/end (ngưỡng rộng, chặn nhầm = hỏng buổi)", () => {
  test("test_rate_limit_session_end_when_bump_returns_false_returns_429_without_refunding", async () => {
    // Arrange — buổi đang live, dưới ngưỡng hoàn quota
    rateLimitAllowed = false;
    sessionRow = liveSessionRow();

    // Act
    const res = await sessionEndPost(makeRequest({}), makeCtx());
    const body = await res.json();

    // Assert — không update, không hoàn quota (tránh sai lệch quota do retry bị chặn)
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(bumpCallFor("session-end")).toEqual({
      key: "session-end:user-1",
      window: "3600 seconds",
      limit: 60,
    });
    expect(rpcCalls).not.toContain("refund_free_session");
    expect(mutationsOn("sessions")).toEqual([]);
  });

  test("test_rate_limit_session_end_when_bump_returns_true_ends_session", async () => {
    // Arrange
    rateLimitAllowed = true;
    sessionRow = liveSessionRow();

    // Act
    const res = await sessionEndPost(makeRequest({}), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.status).toBe("done");
    expect(mutationsOn("sessions").map((o) => o.op)).toContain("update");
  });
});

describe("checkRateLimit — fail-open khi RPC lỗi hạ tầng", () => {
  test("test_check_rate_limit_when_rpc_returns_infra_error_fails_open_and_allows_request", async () => {
    // Arrange — RPC lỗi (không phải "vượt ngưỡng"): hành vi CỐ Ý là không chặn user
    rateLimitRpcError = { message: "connection reset" };

    // Act
    const decision = await checkRateLimit({ key: "any:key", windowSeconds: 3600, limit: 10 });

    // Assert
    expect(decision).toEqual({ allowed: true });
  });

  test("test_rate_limit_soniox_key_when_rpc_errors_does_not_block_with_429", async () => {
    // Arrange — lỗi hạ tầng ở tầng route (không phải quota); soniox-key có
    // onPermissionDenied mặc định fail-open nên lỗi hạ tầng cũng fail-open
    rateLimitRpcError = { message: "statement timeout" };
    sessionRow = null;

    // Act
    const res = await sonioxKeyPost(makeRequest({}), makeCtx());
    const body = await res.json();

    // Assert — fail-open: đi tiếp tới handler (404), KHÔNG trả 429
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("test_check_rate_limit_when_rpc_returns_false_blocks_request", async () => {
    // Arrange — đối chứng cho fail-open: false thật sự chặn
    rateLimitAllowed = false;

    // Act
    const decision = await checkRateLimit({ key: "any:key", windowSeconds: 3600, limit: 10 });

    // Assert
    expect(decision).toEqual({ allowed: false, reason: "limit_exceeded" });
  });
});

/**
 * H3 — `permission denied for function` (SQLSTATE 42501) KHÔNG phải sự cố hạ
 * tầng thoáng qua mà là dấu hiệu grant bị mất. Fail-open ở lớp lỗi này = rate
 * limit tắt vĩnh viễn trong im lặng. Mặc định phải fail-CLOSED.
 */
describe("checkRateLimit — fail-CLOSED khi RPC bị từ chối quyền (42501)", () => {
  test("test_check_rate_limit_when_rpc_permission_denied_fails_closed_with_backend_denied", async () => {
    // Arrange — grant bump_rate_limit bị mất
    rateLimitRpcError = { message: "permission denied for function bump_rate_limit", code: "42501" };

    // Act
    const decision = await checkRateLimit({ key: "any:key", windowSeconds: 3600, limit: 10 });

    // Assert — chặn, và phân biệt được với "user vượt hạn"
    expect(decision).toEqual({ allowed: false, reason: "backend_denied" });
  });

  test("test_check_rate_limit_when_permission_denied_and_fail_mode_open_allows_request", async () => {
    // Arrange — call site cố ý chọn fail-open (đường /utterances)
    rateLimitRpcError = { message: "permission denied for function bump_rate_limit", code: "42501" };

    // Act
    const decision = await checkRateLimit({
      key: "utterances:min:session-1",
      windowSeconds: 60,
      limit: 60,
      onPermissionDenied: "open",
    });

    // Assert
    expect(decision).toEqual({ allowed: true });
  });

  test("test_rate_limit_utterances_when_permission_denied_still_ingests_to_protect_transcript", async () => {
    // Arrange — NGOẠI LỆ CỐ Ý: chặn ingest = mất transcript đang thu.
    // Session live + không có utterance cũ → handler đi tới nhánh insert bình thường.
    rateLimitRpcError = { message: "permission denied for function bump_rate_limit", code: "42501" };
    sessionRow = liveSessionRow();
    utteranceRows = [];

    // Act
    const res = await utterancesPost(
      makeRequest({ utterances: [{ client_utt_id: "c1", speaker: "candidate", lang: "vi", text_orig: "Xin chào" }] }),
      makeCtx(),
    );

    // Assert — KHÔNG bị 429/503, request đi qua rate limit
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(503);
    expect(bumpCallFor("utterances")).toBeDefined();
  });
});

describe("getClientIp", () => {
  test("test_get_client_ip_with_multi_hop_x_forwarded_for_returns_first_hop", () => {
    // Arrange — hop đầu là client thật, các hop sau là proxy trung gian
    const headers = new Headers({ "x-forwarded-for": " 203.0.113.5 , 70.41.3.18 , 150.172.238.178 " });

    // Act
    const ip = getClientIp(headers);

    // Assert
    expect(ip).toBe("203.0.113.5");
  });

  test("test_get_client_ip_without_forwarded_for_falls_back_to_x_real_ip", () => {
    // Arrange
    const headers = new Headers({ "x-real-ip": " 198.51.100.22 " });

    // Act
    const ip = getClientIp(headers);

    // Assert
    expect(ip).toBe("198.51.100.22");
  });

  test("test_get_client_ip_without_any_ip_header_returns_unknown", () => {
    // Arrange — hiếm khi xảy ra sau proxy Vercel; dồn chung 1 bucket thay vì throw
    const headers = new Headers();

    // Act
    const ip = getClientIp(headers);

    // Assert
    expect(ip).toBe("unknown");
  });

  test("test_get_client_ip_with_empty_forwarded_for_falls_back_to_x_real_ip", () => {
    // Arrange — header tồn tại nhưng rỗng (proxy cấu hình sai)
    const headers = new Headers({ "x-forwarded-for": "", "x-real-ip": "198.51.100.9" });

    // Act
    const ip = getClientIp(headers);

    // Assert
    expect(ip).toBe("198.51.100.9");
  });
});

/**
 * H-1 — ĐƯỜNG SỐNG CÒN của buổi phỏng vấn phải fail-OPEN khi grant lệch (42501).
 *
 * Hành lang: `/start` -> `/soniox-key` -> `/utterances` -> `/end`. Ban đầu chỉ
 * `/utterances` được miễn, nhưng như vậy VÔ NGHĨA: `/soniox-key` 503 thì không
 * stream nào mở, không có utterance nào để mà cứu; `/start` 503 thì còn không
 * tới được đó. Trần chi phí THẬT của hành lang này là quota free
 * (`debit_free_session`), không phải rate limit — nên nới ở đây không mở cửa
 * cho lạm dụng tiền, trong khi chặn thì làm hỏng buổi phỏng vấn đang diễn ra.
 */
describe("H-1 — hành lang buổi phỏng vấn fail-OPEN khi 42501", () => {
  const PERMISSION_DENIED_ERROR = {
    message: "permission denied for function bump_rate_limit",
    code: "42501",
  };

  test("test_rate_limit_session_start_when_permission_denied_still_starts_session", async () => {
    // Arrange — grant lệch; session sẵn sàng start
    rateLimitRpcError = PERMISSION_DENIED_ERROR;
    sessionRow = {
      id: "session-1",
      status: "prep",
      started_at: "2026-08-17T00:00:00Z",
      cap_seconds: 5400,
      mode: "online",
    };

    // Act
    const res = await sessionStartPost(makeRequest({}), makeCtx());

    // Assert — KHÔNG bị chặn: buổi vẫn bắt đầu được
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(503);
  });

  test("test_rate_limit_soniox_key_when_permission_denied_still_issues_key", async () => {
    // Arrange — cửa vào đường thu âm; chặn ở đây là không stream nào mở nổi
    rateLimitRpcError = PERMISSION_DENIED_ERROR;
    sessionRow = liveSessionRow();

    // Act
    const res = await sonioxKeyPost(makeRequest({}), makeCtx());

    // Assert
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(503);
  });

  test("test_rate_limit_session_end_when_permission_denied_still_ends_session", async () => {
    // Arrange — chặn /end = buổi kẹt 'live', phải chờ sweeper auto-end
    rateLimitRpcError = PERMISSION_DENIED_ERROR;
    sessionRow = liveSessionRow();

    // Act
    const res = await sessionEndPost(makeRequest({}), makeCtx());

    // Assert
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(503);
  });
});
