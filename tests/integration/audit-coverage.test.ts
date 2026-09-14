import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route/lib dưới test có `import "server-only"` — mock rỗng để chạy dưới vitest.
vi.mock("server-only", () => ({}));

/**
 * Integration test audit coverage — Interview Hack (chỉ ứng viên) chỉ còn 1 đường
 * mutation ghi `audit_log`: session delete (`DELETE /api/sessions/:id`, xem
 * `src/lib/audit.ts` + route). Các đường khác từng có audit (question CRUD/reorder,
 * report update, share create/revoke) đã bị xoá cùng tính năng người phỏng vấn.
 *
 * Assert: đúng 1 row insert vào `audit_log`, action='delete', entity='session',
 * `before` đúng snapshot session, `after` null, và `session_id = null` (CỐ Ý —
 * FK on-delete-cascade sẽ xoá mất chính entry đó nếu ghi kèm session_id).
 *
 * Mock Supabase bespoke (chainable + fromResultsRef theo thứ tự gọi từng bảng) —
 * KHÔNG chạm DB thật.
 */

interface FakeQueryResult {
  data: unknown;
  error: unknown;
}

interface AuditRow {
  user_id: string;
  session_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before: unknown;
  after: unknown;
}

interface ActResult {
  status: number;
  audit: AuditRow[];
}

const fromResultsRef: { current: Record<string, FakeQueryResult[]> } = { current: {} };
let auditRows: AuditRow[] = [];
const authUser = { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" as string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chainable(table: string, result: FakeQueryResult): any {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "order", "limit", "in", "update", "delete"]) {
    obj[m] = vi.fn(() => obj);
  }
  obj.insert = vi.fn((payload: unknown) => {
    if (table === "audit_log") auditRows.push(payload as AuditRow);
    return obj;
  });
  obj.single = vi.fn(() => Promise.resolve(result));
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (resolve: (v: FakeQueryResult) => void, reject: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  return obj;
}

function makeFakeClient() {
  const callIndex: Record<string, number> = {};
  const from = vi.fn((table: string) => {
    const idx = callIndex[table] ?? 0;
    callIndex[table] = idx + 1;
    const results = fromResultsRef.current[table] ?? [];
    return chainable(table, results[idx] ?? { data: null, error: null });
  });
  // Session delete xoá file storage trước khi xoá row — bucket rỗng cho test audit.
  const storage = {
    from: () => ({
      list: async () => ({ data: [], error: null }),
      remove: async () => ({ data: null, error: null }),
    }),
  };
  const auth = { getUser: vi.fn(async () => ({ data: { user: authUser }, error: null })) };
  // Session delete có rate limit (M11) → route gọi RPC `bump_rate_limit`; thiếu
  // `rpc` là 500 "supabase.rpc is not a function".
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "bump_rate_limit") return { data: true, error: null };
    return { data: null, error: null };
  });
  return { from, storage, rpc, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeFakeClient()),
  createServiceRoleClient: vi.fn(() => makeFakeClient()),
}));

const { DELETE: sessionDelete } = await import("@/app/api/sessions/[id]/route");

function makeRequest(body?: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const BASE_SESSION = {
  id: "s1",
  user_id: "user-1",
  status: "done",
  candidate_name: "Nguyễn Văn A",
  created_at: "2026-08-01T00:00:00Z",
  ended_at: "2026-08-01T01:00:00Z",
};

/** Reset state trước mỗi Act — helper tự dọn, không chia sẻ state giữa test. */
function resetFixtures() {
  fromResultsRef.current = {};
  auditRows = [];
}

async function actSessionDelete(): Promise<ActResult & { before: typeof BASE_SESSION }> {
  resetFixtures();
  const before = { ...BASE_SESSION };
  fromResultsRef.current = {
    sessions: [
      { data: before, error: null },
      { data: null, error: null }, // delete
    ],
  };
  const res = await sessionDelete(makeRequest(), makeCtx("s1"));
  return { status: res.status, audit: [...auditRows], before };
}

beforeEach(() => {
  resetFixtures();
});

describe("audit_log — session delete", () => {
  test("test_audit_session_delete_writes_one_row_with_null_session_id_to_survive_cascade", async () => {
    // Arrange + Act
    const { status, audit, before } = await actSessionDelete();

    // Assert — session_id = null CỐ Ý: audit_log.session_id FK on-delete-cascade,
    // ghi kèm session_id sẽ bị cascade xoá mất chính entry vừa ghi.
    expect(status).toBe(200);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("delete");
    expect(audit[0].entity).toBe("session");
    expect(audit[0].entity_id).toBe("s1");
    expect(audit[0].session_id).toBeNull();
    expect(audit[0].before).toEqual(before);
    expect(audit[0].after).toBeNull();
  });
});
