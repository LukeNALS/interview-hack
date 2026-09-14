import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route dưới test có `import "server-only"` (qua withAuth) — mock rỗng để chạy được dưới vitest (P05).
vi.mock("server-only", () => ({}));

/**
 * Integration test cho GET /api/sessions/:id/utterances?after_seq= (backfill
 * sau reconnect) — mock Supabase, AAA, khớp tên test phase-05 bước 17.
 */

let sessionExists = true;
let backfillRows: Array<{ id: string; seq: number }> = [];
const gtSpy = vi.fn();
const orderSpy = vi.fn();
const limitSpy = vi.fn();

function makeFakeClient() {
  const from = vi.fn((table: string) => {
    if (table === "sessions") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => (sessionExists ? { data: { id: "session-1" }, error: null } : { data: null, error: null }) }),
        }),
      };
    }
    if (table === "utterances") {
      const query = {
        eq: () => query,
        gt: (col: string, val: unknown) => {
          gtSpy(col, val);
          return query;
        },
        order: (col: string, opts: unknown) => {
          orderSpy(col, opts);
          return query;
        },
        limit: async (n: number) => {
          limitSpy(n);
          return { data: backfillRows, error: null };
        },
      };
      return { select: () => query };
    }
    throw new Error(`bảng không mong đợi trong test: ${table}`);
  });
  const auth = { getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null })) };
  // P07: GET backfill giờ qua checkRateLimit (`utterances:backfill:{sessionId}`) —
  // stub `bump_rate_limit` trả true để các test dưới kiểm ĐÚNG logic backfill.
  // Hành vi khi vượt ngưỡng có test riêng ở tests/integration/rate-limit.test.ts.
  const rpc = vi.fn(async (name: string) => {
    if (name === "bump_rate_limit") return { data: true, error: null };
    throw new Error(`RPC không mong đợi trong test: ${name}`);
  });
  return { from, auth, rpc };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeFakeClient()),
}));

const { GET } = await import("@/app/api/sessions/[id]/utterances/route");

function makeRequest(afterSeq?: string): NextRequest {
  const url = afterSeq === undefined ? "http://localhost/api/sessions/session-1/utterances" : `http://localhost/api/sessions/session-1/utterances?after_seq=${afterSeq}`;
  return { url } as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/sessions/:id/utterances", () => {
  beforeEach(() => {
    sessionExists = true;
    backfillRows = [
      { id: "u1", seq: 6 },
      { id: "u2", seq: 7 },
    ];
    gtSpy.mockClear();
    orderSpy.mockClear();
    limitSpy.mockClear();
  });

  test("test_backfill_returns_only_rows_after_given_seq_in_ascending_order", async () => {
    // Arrange — after_seq=5, mock trả 2 dòng seq=6,7 (route đã lọc/order qua query builder thật;
    // ở đây assert route TRUYỀN đúng tham số gt/order/limit + trả pass-through đúng thứ tự).
    // Act
    const res = await GET(makeRequest("5"), makeCtx());
    const body = (await res.json()) as { utterances: { seq: number }[]; next_after_seq: number | null };
    // Assert
    expect(res.status).toBe(200);
    expect(gtSpy).toHaveBeenCalledWith("seq", 5);
    expect(orderSpy).toHaveBeenCalledWith("seq", { ascending: true });
    expect(limitSpy).toHaveBeenCalledWith(500);
    expect(body.utterances.map((u) => u.seq)).toEqual([6, 7]);
    expect(body.next_after_seq).toBeNull();
  });

  test("test_backfill_defaults_after_seq_zero_when_query_param_missing", async () => {
    // Arrange + Act
    const res = await GET(makeRequest(), makeCtx());
    // Assert
    expect(res.status).toBe(200);
    expect(gtSpy).toHaveBeenCalledWith("seq", 0);
  });

  test("test_backfill_returns_next_after_seq_when_exactly_limit_rows_returned", async () => {
    // Arrange — giả lập đủ 500 dòng (limit) → next_after_seq = seq dòng cuối
    backfillRows = Array.from({ length: 500 }, (_, i) => ({ id: `u${i}`, seq: i + 1 }));
    // Act
    const res = await GET(makeRequest("0"), makeCtx());
    const body = (await res.json()) as { next_after_seq: number | null };
    // Assert
    expect(body.next_after_seq).toBe(500);
  });

  test("test_backfill_session_not_owned_returns_404", async () => {
    // Arrange
    sessionExists = false;
    // Act
    const res = await GET(makeRequest("0"), makeCtx("other-session"));
    const body = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});
