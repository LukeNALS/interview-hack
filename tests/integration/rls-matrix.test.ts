import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  createAdminClient,
  createAnonClient,
  createTestUser,
  deleteTestUsers,
  seedSession,
  signInAsUser,
  throwOnError,
} from "./db-test-support";

/**
 * RLS matrix (AC9) — user B thử select/update/delete TỪNG bảng của user A, và client
 * anon (chưa đăng nhập) đọc TỪNG bảng. Chạy đối đầu local Supabase stack.
 *
 * 2 lớp phòng thủ (0002_rls.sql):
 * - `authenticated` CÓ grant bảng → RLS lọc row ⇒ trả 0 row (không lỗi).
 * - `authenticated` KHÔNG có grant thao tác đó (reports.delete, report_jobs.update/delete,
 *   export_jobs.update/delete, audit_log.update/delete, profiles.delete, và MỌI cột
 *   `profiles` trừ `name` sau migration 0011) ⇒ 42501 ở tầng privilege.
 * - `anon` bị `revoke all on all tables` ⇒ 42501 trên MỌI bảng.
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

const PERMISSION_DENIED = "42501";

type Outcome = "zero-rows" | "denied";
type Result = { data: unknown[] | null; error: PostgrestError | null };

function expectZeroRows(result: Result, label: string): void {
  expect(result.error, `${label}: mong 0 row nhưng lỗi ${result.error?.code}`).toBeNull();
  expect(result.data, `${label}: RLS phải lọc sạch row của user khác`).toEqual([]);
}

function expectDenied(result: Result, label: string): void {
  expect(result.error?.code, `${label}: mong bị từ chối ở tầng privilege`).toBe(PERMISSION_DENIED);
  expect(result.data).toBeNull();
}

function expectOutcome(outcome: Outcome, result: Result, label: string): void {
  if (outcome === "zero-rows") expectZeroRows(result, label);
  else expectDenied(result, label);
}

suite("RLS matrix — cross-user + anon (local stack)", () => {
  const suffix = Date.now();
  const emailA = `rls-matrix-a-${suffix}@example.com`;
  const emailB = `rls-matrix-b-${suffix}@example.com`;

  // Id cố định của dữ liệu thuộc user A — fixture chỉ đọc, không test nào sửa được (đó là điều đang test).
  const ids = {
    session: crypto.randomUUID(),
    question: crypto.randomUUID(),
    utterance: crypto.randomUUID(),
    report: crypto.randomUUID(),
    reportJob: crypto.randomUUID(),
    exportJob: crypto.randomUUID(),
    auditLog: crypto.randomUUID(),
  };

  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let userAId = "";
  let userBId = "";

  /** Bảng → (id row của A, patch thử sửa, kết quả mong đợi khi user B update/delete). */
  const matrix: Array<{
    table: string;
    rowId: () => string;
    patch: Record<string, unknown>;
    update: Outcome;
    remove: Outcome;
  }> = [
    { table: "sessions", rowId: () => ids.session, patch: { candidate_name: "HACKED" }, update: "zero-rows", remove: "zero-rows" },
    { table: "questions", rowId: () => ids.question, patch: { text: "HACKED" }, update: "zero-rows", remove: "zero-rows" },
    { table: "utterances", rowId: () => ids.utterance, patch: { text_orig: "HACKED" }, update: "zero-rows", remove: "zero-rows" },
    { table: "reports", rowId: () => ids.report, patch: { edited_by_user: true }, update: "zero-rows", remove: "denied" },
    { table: "report_jobs", rowId: () => ids.reportJob, patch: { step_status: "failed" }, update: "denied", remove: "denied" },
    { table: "export_jobs", rowId: () => ids.exportJob, patch: { status: "failed" }, update: "denied", remove: "denied" },
    { table: "audit_log", rowId: () => ids.auditLog, patch: { action: "hacked" }, update: "denied", remove: "denied" },
    // `free_sessions_left` KHÔNG còn nằm trong grant của `authenticated` (migration 0011)
    // → bị chặn ở tầng privilege TRƯỚC cả khi RLS kịp lọc row. Chặt hơn `zero-rows` cũ:
    // kể cả user B nhắm vào row của CHÍNH MÌNH cũng không sửa được cột này.
    // Lớp RLS-lọc-dòng của profiles được phủ riêng ở test `..._name_column_...` bên dưới.
    { table: "profiles", rowId: () => userAId, patch: { free_sessions_left: 99 }, update: "denied", remove: "denied" },
  ];

  beforeAll(async () => {
    admin = createAdminClient();
    anon = createAnonClient();

    userAId = await createTestUser(admin, emailA);
    userBId = await createTestUser(admin, emailB);
    clientA = await signInAsUser(emailA);
    clientB = await signInAsUser(emailB);

    await seedSession(admin, {
      id: ids.session,
      userId: userAId,
      fields: { status: "done", candidate_name: "Dữ liệu riêng của A", duration_sec: 600 },
    });

    const seeds: Array<[string, Record<string, unknown>]> = [
      ["questions", { id: ids.question, session_id: ids.session, order_idx: 0, text: "Câu hỏi của A" }],
      [
        "utterances",
        { id: ids.utterance, session_id: ids.session, seq: 1, speaker: "candidate", lang: "vi", text_orig: "Lời thoại của A" },
      ],
      ["reports", { id: ids.report, session_id: ids.session, status: "ready" }],
      ["report_jobs", { id: ids.reportJob, session_id: ids.session, step: 0, step_status: "done" }],
      ["export_jobs", { id: ids.exportJob, session_id: ids.session, mode: "combined", langs: ["vi"], status: "ready" }],
      [
        "audit_log",
        { id: ids.auditLog, user_id: userAId, session_id: ids.session, entity: "session", entity_id: ids.session, action: "session.create" },
      ],
    ];
    for (const [table, row] of seeds) {
      const { error } = await admin.from(table).insert(row);
      throwOnError(`seed ${table}`, error);
    }
  }, 60000);

  afterAll(async () => {
    await deleteTestUsers(admin, [userAId, userBId]);
  }, 60000);

  test("test_rls_matrix_user_a_reads_own_rows_on_every_table_positive_control", async () => {
    // Arrange — chứng minh phép deny bên dưới KHÔNG phải do bảng rỗng / seed hỏng.
    // Act + Assert — chủ dữ liệu đọc được đúng 1 row mỗi bảng.
    for (const { table, rowId } of matrix) {
      const { data, error } = await clientA.from(table).select("id").eq("id", rowId());
      expect(error, `${table}: chủ sở hữu phải đọc được`).toBeNull();
      expect(data, `${table}: chủ sở hữu phải thấy đúng 1 row`).toHaveLength(1);
    }
  }, 60000);

  for (const spec of matrix) {
    test(`test_rls_matrix_user_b_cannot_select_update_delete_${spec.table}_of_user_a`, async () => {
      // Arrange — row thuộc user A đã seed ở beforeAll.
      const rowId = spec.rowId();

      // Act + Assert — SELECT: RLS lọc sạch.
      const selected = await clientB.from(spec.table).select("id").eq("id", rowId);
      expectZeroRows(selected as Result, `${spec.table}.select`);

      // Act + Assert — UPDATE: 0 row (RLS) hoặc 42501 (không có grant).
      const updated = await clientB.from(spec.table).update(spec.patch).eq("id", rowId).select("id");
      expectOutcome(spec.update, updated as Result, `${spec.table}.update`);

      // Act + Assert — DELETE: 0 row (RLS) hoặc 42501 (không có grant).
      const deleted = await clientB.from(spec.table).delete().eq("id", rowId).select("id");
      expectOutcome(spec.remove, deleted as Result, `${spec.table}.delete`);

      // Assert — row của A vẫn còn nguyên (kiểm bằng service-role, không qua RLS).
      const { data: survivor, error: survivorError } = await admin.from(spec.table).select("id").eq("id", rowId);
      throwOnError(`đọc lại ${spec.table} bằng service-role`, survivorError);
      expect(survivor, `${spec.table}: row của A phải còn nguyên sau mọi thao tác của B`).toHaveLength(1);
    }, 60000);
  }

  /**
   * Lớp RLS của `profiles` — phủ phần mà matrix ở trên KHÔNG còn chạm tới.
   *
   * Sau migration 0011, `authenticated` chỉ còn grant `update (name)`. Mọi cột khác bị
   * chặn ở tầng privilege nên không bao giờ đi tới RLS. `name` là cột DUY NHẤT còn đi
   * qua được tầng grant → cũng là đường DUY NHẤT còn kiểm chứng được rằng policy
   * `profiles_update_self` thật sự khoá theo `auth.uid()`. Mất test này là mất luôn
   * bằng chứng cho lớp phòng thủ thứ hai của profiles.
   */
  test("test_rls_matrix_user_b_cannot_update_name_column_of_user_a_profile", async () => {
    // Arrange — `name` là cột user ĐƯỢC phép tự sửa trên profile CỦA MÌNH.
    const { data: before } = await admin.from("profiles").select("name").eq("id", userAId).single();

    // Act — user B nhắm vào profile của user A qua đúng cột được grant.
    const updated = await clientB.from("profiles").update({ name: "HACKED" }).eq("id", userAId).select("id");

    // Assert — qua được tầng grant, nhưng RLS lọc sạch: 0 row, KHÔNG lỗi.
    expectZeroRows(updated as Result, "profiles.update(name) cross-user");

    // Assert — giá trị thật trong DB không đổi (đọc bằng service-role, không qua RLS).
    const { data: after } = await admin.from("profiles").select("name").eq("id", userAId).single();
    expect(after?.name, "name của A không được đổi bởi B").toBe(before?.name ?? null);
  }, 60000);

  for (const { table } of matrix) {
    test(`test_rls_matrix_anon_client_cannot_read_${table}`, async () => {
      // Arrange — client dùng anon key, KHÔNG đăng nhập.
      // Act
      const result = await anon.from(table).select("id").limit(1);
      // Assert — anon bị revoke toàn bộ quyền bảng ⇒ chặn ngay tầng privilege.
      expectDenied(result as Result, `anon.${table}.select`);
    }, 60000);
  }

  test("test_rls_matrix_anon_client_cannot_read_rate_limit_counters", async () => {
    // Arrange — bảng nội bộ, không cấp cho cả anon lẫn authenticated.
    // Act
    const anonResult = await anon.from("rate_limit_counters").select("key").limit(1);
    const userResult = await clientB.from("rate_limit_counters").select("key").limit(1);
    // Assert
    expectDenied(anonResult as Result, "anon.rate_limit_counters.select");
    expectDenied(userResult as Result, "authenticated.rate_limit_counters.select");
  }, 60000);
});
