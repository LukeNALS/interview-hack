import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/**
 * Integration test cho DELETE /api/sessions/:id — mock Supabase bespoke (user
 * client cho sessions select/delete, service client cho storage list/remove +
 * audit_log insert — pattern session-end.test.ts/report-steps.test.ts). AAA.
 */

/** Row `sessions` như DB thật — CÓ cột PII, để test H2 (audit không được nuốt PII) có nghĩa. */
interface SessionFixture {
  id: string;
  user_id: string;
  status: string;
  mode: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  cap_seconds: number;
  ended_reason: string | null;
  quota_debited: boolean;
  quota_refunded: boolean;
  // --- PII, KHÔNG được lọt vào audit_log.before ---
  candidate_name: string | null;
  position: string | null;
  jd_text: string | null;
  cv_file_path: string | null;
  quick_eval: Record<string, unknown> | null;
}

/** Cột PII tuyệt đối không được xuất hiện trong `audit_log.before` (H2). */
const PII_COLUMNS = ["candidate_name", "jd_text", "cv_file_path", "quick_eval"] as const;

let sessionFixture: SessionFixture | null;
const sessionDeleteSpy = vi.fn();
const sessionSelectSpy = vi.fn();
const auditInsertSpy = vi.fn();
const storageListSpy = vi.fn();
const storageRemoveSpy = vi.fn();

/**
 * Mô phỏng PostgREST: `.select(cols)` trả về ĐÚNG các cột được yêu cầu, `*` trả cả row.
 *
 * BẮT BUỘC phải có thì test H2 mới có khả năng ĐỎ — nếu mock trả nguyên fixture bất kể
 * select thì `select("*")` và `select(SESSION_AUDIT_SELECT)` cho ra kết quả y hệt, assert
 * "before không chứa PII" sẽ xanh giả.
 */
function projectColumns(row: SessionFixture, selectExpr: string): Record<string, unknown> {
  if (selectExpr.trim() === "*") return { ...row };
  const wanted = selectExpr.split(",").map((c) => c.trim());
  const out: Record<string, unknown> = {};
  for (const col of wanted) {
    if (col in row) out[col] = row[col as keyof SessionFixture];
  }
  return out;
}

/** Entry như storage-js trả về — `id === null` nghĩa là ENTRY THƯ MỤC, không phải file. */
interface StorageEntryFixture {
  name: string;
  id?: string | null;
}

/**
 * Mặc định `limit` của storage-js `.list()` khi KHÔNG truyền option.
 *
 * Con số này được verify THỰC NGHIỆM đối đầu stack thật ở
 * `tests/integration/storage-pagination.test.ts` (upload 101 object rồi gọi
 * `.list(prefix)` không option → trả về đúng 100). Mock BẮT BUỘC mô phỏng đúng
 * ngưỡng đó, nếu không test phân trang sẽ XANH GIẢ (mock trả hết mọi file bất kể
 * option ⇒ route quên phân trang vẫn "xoá đủ").
 */
const STORAGE_DEFAULT_LIMIT = 100;

/** Ghi lại mọi lần gọi RPC `bump_rate_limit` để assert key đúng scope + ngưỡng. */
let bumpCalls: Array<{ key: string; window: string; limit: number }>;
let rateLimitAllowed: boolean;
/** Lỗi RPC rate limit — `code: "42501"` = permission denied → fail-CLOSED (503). */
let rateLimitRpcError: { message: string; code?: string } | null;

/** bucket -> {data, error} trả về từ .list() — mặc định rỗng, test override khi cần. */
let listResultByBucket: Record<string, { data: StorageEntryFixture[] | null; error: { message: string } | null }>;
let removeErrorByBucket: Record<string, { message: string } | null>;
/** bucket -> option của TỪNG lần gọi .list() (undefined = route không truyền gì). */
let listCallsByBucket: Record<string, Array<{ limit?: number; offset?: number } | undefined>>;

/** N file giả trong 1 prefix — tên có thứ tự để assert đủ/không sót. */
function makeFileEntries(count: number): StorageEntryFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file-${String(i).padStart(3, "0")}.pdf`,
    id: `object-${i}`,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionsBuilder(): any {
  let selectExpr = "*";
  const builder = {
    select: (expr = "*") => {
      selectExpr = expr;
      sessionSelectSpy(expr);
      return builder;
    },
    eq: () => builder,
    maybeSingle: async () => ({
      data: sessionFixture ? projectColumns(sessionFixture, selectExpr) : null,
      error: null,
    }),
    delete: () => ({
      eq: (col: string, val: unknown) => {
        sessionDeleteSpy(col, val);
        sessionFixture = null;
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  return builder;
}

function makeUserClient() {
  const from = vi.fn((table: string) => {
    if (table === "sessions") return sessionsBuilder();
    throw new Error(`bảng không mong đợi trong test (user client): ${table}`);
  });
  const auth = {
    getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null })),
  };
  // RPC thật của rate limit — test chạy qua checkRateLimit() thật, không mock module.
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn !== "bump_rate_limit") throw new Error(`RPC không mong đợi trong test: ${fn}`);
    bumpCalls.push({
      key: String(args.p_key),
      window: String(args.p_window),
      limit: Number(args.p_limit),
    });
    if (rateLimitRpcError) return { data: null, error: rateLimitRpcError };
    return { data: rateLimitAllowed, error: null };
  });
  return { from, auth, rpc };
}

function makeServiceClient() {
  const from = vi.fn((table: string) => {
    if (table === "audit_log") {
      return {
        insert: (payload: Record<string, unknown>) => {
          auditInsertSpy(payload);
          return Promise.resolve({ data: null, error: null });
        },
      };
    }
    throw new Error(`bảng không mong đợi trong test (service client): ${table}`);
  });
  const storage = {
    from: (bucket: string) => ({
      // Mô phỏng ĐÚNG semantics storage-js: không truyền option -> cắt ở
      // STORAGE_DEFAULT_LIMIT; có {limit, offset} -> lát đúng cửa sổ đó.
      list: (prefix: string, options?: { limit?: number; offset?: number }) => {
        storageListSpy(bucket, prefix);
        (listCallsByBucket[bucket] ??= []).push(options);
        const result = listResultByBucket[bucket] ?? { data: [], error: null };
        if (result.error) return Promise.resolve({ data: null, error: result.error });
        const limit = options?.limit ?? STORAGE_DEFAULT_LIMIT;
        const offset = options?.offset ?? 0;
        return Promise.resolve({ data: (result.data ?? []).slice(offset, offset + limit), error: null });
      },
      remove: (paths: string[]) => {
        storageRemoveSpy(bucket, paths);
        return Promise.resolve({ data: null, error: removeErrorByBucket[bucket] ?? null });
      },
    }),
  };
  return { from, storage };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeUserClient()),
  createServiceRoleClient: vi.fn(() => makeServiceClient()),
}));

function makeRequest(): NextRequest {
  return {} as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/sessions/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionFixture = {
      id: "session-1",
      user_id: "user-1",
      status: "done",
      mode: "interviewer",
      created_at: "2026-08-01T00:00:00.000Z",
      started_at: "2026-08-01T00:05:00.000Z",
      ended_at: "2026-08-01T01:00:00.000Z",
      duration_sec: 3300,
      cap_seconds: 5400,
      ended_reason: "manual",
      quota_debited: true,
      quota_refunded: false,
      candidate_name: "Nguyễn Văn A",
      position: "Senior Backend Engineer",
      jd_text: "Tuyển backend Go, 5 năm kinh nghiệm, mức lương 2000 man...",
      cv_file_path: "user-1/session-1/1700000000-cv.pdf",
      quick_eval: { fit: "high", note: "ứng viên từng làm fintech" },
    };
    listResultByBucket = {
      cv: { data: [{ name: "1700000000-cv.pdf" }], error: null },
      exports: { data: [{ name: "1700000001-report_combined.pdf" }], error: null },
    };
    removeErrorByBucket = { cv: null, exports: null };
    listCallsByBucket = {};
    bumpCalls = [];
    rateLimitAllowed = true;
    rateLimitRpcError = null;
    sessionDeleteSpy.mockClear();
    sessionSelectSpy.mockClear();
    auditInsertSpy.mockClear();
    storageListSpy.mockClear();
    storageRemoveSpy.mockClear();
  });

  test("test_session_delete_success_removes_row_and_writes_audit_and_calls_storage_remove", async () => {
    // Arrange
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body).toEqual({ deleted: true });
    expect(storageListSpy).toHaveBeenCalledWith("cv", "user-1/session-1");
    expect(storageListSpy).toHaveBeenCalledWith("exports", "user-1/session-1");
    expect(storageRemoveSpy).toHaveBeenCalledWith("cv", ["user-1/session-1/1700000000-cv.pdf"]);
    expect(storageRemoveSpy).toHaveBeenCalledWith("exports", ["user-1/session-1/1700000001-report_combined.pdf"]);
    expect(sessionDeleteSpy).toHaveBeenCalledTimes(1);
    expect(auditInsertSpy).toHaveBeenCalledTimes(1);
    const auditPayload = auditInsertSpy.mock.calls[0][0];
    expect(auditPayload.entity).toBe("session");
    expect(auditPayload.action).toBe("delete");
    expect(auditPayload.session_id).toBeNull();
    expect(auditPayload.entity_id).toBe("session-1");
  });

  test("test_session_delete_not_owner_returns_404_without_side_effects", async () => {
    // Arrange — RLS trả 0 dòng (không phải chủ session)
    sessionFixture = null;
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx("session-other"));
    const body = await res.json();

    // Assert
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(storageListSpy).not.toHaveBeenCalled();
    expect(sessionDeleteSpy).not.toHaveBeenCalled();
    expect(auditInsertSpy).not.toHaveBeenCalled();
  });

  test("test_session_delete_storage_error_returns_500_and_keeps_row", async () => {
    // Arrange — bucket cv lỗi khi list
    listResultByBucket.cv = { data: null, error: { message: "storage unavailable" } };
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — 500, KHÔNG xóa row, KHÔNG ghi audit (2 pha: storage trước, lỗi thì dừng).
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("storage_delete_failed");
    expect(sessionDeleteSpy).not.toHaveBeenCalled();
    expect(auditInsertSpy).not.toHaveBeenCalled();
    expect(sessionFixture).not.toBeNull();
  });

  /**
   * H2 — entry audit của session-delete ghi `session_id = null` (bắt buộc: FK
   * on-delete-cascade sẽ xoá luôn chính entry vừa ghi). Không FK ⇒ `purge_sessions`
   * không cascade tới ⇒ entry SỐNG VĨNH VIỄN. Nên `before` tuyệt đối không được
   * chứa PII, nếu không phase retention tự tạo chỗ giữ PII không bao giờ xoá (phá AC6).
   */
  test("test_session_delete_audit_before_excludes_pii_columns", async () => {
    // Arrange — fixture có đủ PII (candidate_name/jd_text/cv_file_path/quick_eval)
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());

    // Assert
    expect(res.status).toBe(200);
    const before = auditInsertSpy.mock.calls[0][0].before as Record<string, unknown>;
    for (const col of PII_COLUMNS) {
      expect(Object.keys(before)).not.toContain(col);
    }
    // Chốt cứng theo giá trị luôn — tránh ca cột đổi tên mà PII vẫn lọt
    expect(JSON.stringify(before)).not.toContain("Nguyễn Văn A");
    expect(JSON.stringify(before)).not.toContain("backend Go");
    expect(JSON.stringify(before)).not.toContain("fintech");
  });

  test("test_session_delete_audit_before_keeps_traceability_columns", async () => {
    // Arrange
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());

    // Assert — audit vẫn đủ trả lời "ai xoá cái gì, lúc nào, đã trừ quota chưa"
    expect(res.status).toBe(200);
    const auditPayload = auditInsertSpy.mock.calls[0][0];
    const before = auditPayload.before as Record<string, unknown>;
    expect(before.id).toBe("session-1");
    expect(before.status).toBe("done");
    expect(before.created_at).toBe("2026-08-01T00:00:00.000Z");
    expect(before.ended_at).toBe("2026-08-01T01:00:00.000Z");
    expect(before.quota_debited).toBe(true);
    // session_id=null là CỐ Ý (tránh FK cascade tự xoá entry) — giữ nguyên
    expect(auditPayload.session_id).toBeNull();
    expect(auditPayload.entity_id).toBe("session-1");
  });

  /**
   * H4 — `.list()` không truyền option bị storage-js cắt ở STORAGE_DEFAULT_LIMIT.
   * Session nhiều file hơn ngưỡng đó: route xoá phần đầu → xoá row `sessions` →
   * phần dư MỒ CÔI VĨNH VIỄN (`purge_sessions`/`list_expired_sessions` join từ
   * `sessions`, mà session đã biến mất, không còn gì trỏ tới file) ⇒ thủng AC6.
   */
  test("test_session_delete_with_more_files_than_page_size_removes_every_file", async () => {
    // Arrange — 250 file trong bucket cv, vượt xa STORAGE_DEFAULT_LIMIT
    listResultByBucket.cv = { data: makeFileEntries(250), error: null };
    listResultByBucket.exports = { data: [], error: null };
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());

    // Assert — không sót file nào, không trùng path nào
    expect(res.status).toBe(200);
    const removedCv = storageRemoveSpy.mock.calls
      .filter((call) => call[0] === "cv")
      .flatMap((call) => call[1] as string[]);
    expect(removedCv).toHaveLength(250);
    expect(new Set(removedCv).size).toBe(250);
    expect(removedCv).toContain("user-1/session-1/file-000.pdf");
    expect(removedCv).toContain("user-1/session-1/file-249.pdf");
  });

  test("test_session_delete_lists_storage_with_explicit_pagination_options", async () => {
    // Arrange
    listResultByBucket.cv = { data: makeFileEntries(250), error: null };
    listResultByBucket.exports = { data: [], error: null };
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    await DELETE(makeRequest(), makeCtx());

    // Assert — mọi lần list đều truyền {limit, offset} tường minh, offset tăng dần tới hết
    const calls = listCallsByBucket.cv ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toEqual({ limit: 1000, offset: 0 });
    expect(calls[1]).toEqual({ limit: 1000, offset: 250 });
  });

  test("test_session_delete_removes_storage_paths_in_batches", async () => {
    // Arrange — 250 path phải chia lô, không nhồi 1 request khổng lồ
    listResultByBucket.cv = { data: makeFileEntries(250), error: null };
    listResultByBucket.exports = { data: [], error: null };
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    await DELETE(makeRequest(), makeCtx());

    // Assert
    const batchSizes = storageRemoveSpy.mock.calls
      .filter((call) => call[0] === "cv")
      .map((call) => (call[1] as string[]).length);
    expect(batchSizes).toEqual([100, 100, 50]);
  });

  test("test_session_delete_skips_folder_entries_from_storage_list", async () => {
    // Arrange — storage-js trả entry thư mục với id === null, KHÔNG phải file thật
    listResultByBucket.cv = {
      data: [{ name: "nested", id: null }, { name: "cv.pdf", id: "object-1" }],
      error: null,
    };
    listResultByBucket.exports = { data: [], error: null };
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    await DELETE(makeRequest(), makeCtx());

    // Assert
    expect(storageRemoveSpy).toHaveBeenCalledWith("cv", ["user-1/session-1/cv.pdf"]);
  });

  /**
   * M11 — DELETE là endpoint phá huỷ nhất mà đang KHÔNG có trần: mỗi lần gọi =
   * N `storage.list` + N `storage.remove` bằng service-role + 1 row audit_log
   * sống vĩnh viễn. Không trần thì 1 vòng lặp client là spam sạch cả ba.
   */
  test("test_session_delete_rate_limit_exceeded_returns_429_without_touching_storage_or_row", async () => {
    // Arrange — RPC bump_rate_limit trả false (đã vượt ngưỡng trong cửa sổ)
    rateLimitAllowed = false;
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — chặn TRƯỚC mọi tác dụng phụ
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(storageListSpy).not.toHaveBeenCalled();
    expect(storageRemoveSpy).not.toHaveBeenCalled();
    expect(sessionDeleteSpy).not.toHaveBeenCalled();
    expect(auditInsertSpy).not.toHaveBeenCalled();
    expect(sessionFixture).not.toBeNull();
  });

  test("test_session_delete_rate_limit_permission_denied_returns_503_without_deleting", async () => {
    // Arrange — grant EXECUTE bị mất (SQLSTATE 42501) ⇒ rate limit thực chất đã TẮT
    rateLimitRpcError = { message: "permission denied for function bump_rate_limit", code: "42501" };
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — fail-CLOSED: 503 chứ không phải lặng lẽ cho xoá
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("rate_limit_unavailable");
    expect(storageRemoveSpy).not.toHaveBeenCalled();
    expect(sessionDeleteSpy).not.toHaveBeenCalled();
  });

  test("test_session_delete_rate_limit_key_is_scoped_to_user", async () => {
    // Arrange
    const { DELETE } = await import("@/app/api/sessions/[id]/route");

    // Act
    const res = await DELETE(makeRequest(), makeCtx());

    // Assert — key theo USER (không phải theo session: đổi session là né được trần)
    expect(res.status).toBe(200);
    expect(bumpCalls).toHaveLength(1);
    expect(bumpCalls[0].key).toBe("session-delete:user-1");
    expect(bumpCalls[0].window).toBe("3600 seconds");
    expect(bumpCalls[0].limit).toBe(10);
  });
});
