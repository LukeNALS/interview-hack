import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  createAdminClient,
  createTestUser,
  DAY_MS,
  deleteTestUsers,
  seedSession,
  signInAsUser,
  throwOnError,
} from "./db-test-support";

/**
 * BYPASS QUOTA — user tự nâng `free_sessions_left` (phát hiện 2026-08-17).
 *
 * `0002_rls.sql:105` cấp UPDATE mức BẢNG cho `authenticated`; policy
 * `profiles_update_self` chỉ khoá DÒNG chứ không khoá CỘT. Kết quả: bất kỳ user
 * đăng nhập nào cũng PATCH được profile của chính mình qua PostgREST bằng anon key
 * (public trong client bundle theo thiết kế) và tự cấp thêm buổi free.
 *
 * `free_sessions_left` là TRẦN CHI PHÍ THẬT (Soniox + Claude). Tự nâng được thì mọi
 * rate limit của P07 vô nghĩa. `retention_days = 0` là đường mất dữ liệu (M6).
 *
 * Test gọi bằng ĐÚNG role `authenticated` (client đã đăng nhập) — không phải
 * service-role — nên phản ánh đúng thứ kẻ tấn công làm được.
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

/** SQLSTATE thiếu quyền cột / vi phạm CHECK. */
const PERMISSION_DENIED = "42501";
const CHECK_VIOLATION = "23514";

/**
 * Hook tạo user thật + seed session chạm auth API và nhiều round-trip DB — mặc định
 * 10s của vitest không đủ trên máy chạy cả stack Docker. Nới riêng cho hook, KHÔNG
 * nới cho test (test chậm bất thường vẫn phải lộ ra).
 */
const HOOK_TIMEOUT_MS = 30_000;

suite("Quyền cột trên profiles — chống bypass quota + hàng rào retention", () => {
  const email = `profile-priv-${Date.now()}@example.test`;

  let admin: SupabaseClient;
  let authed: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    admin = createAdminClient();
    userId = await createTestUser(admin, email);
    authed = await signInAsUser(email);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await deleteTestUsers(admin, [userId]);
  }, HOOK_TIMEOUT_MS);

  /** Đọc lại bằng service-role — RLS không che, thấy giá trị THẬT trong bảng. */
  async function readProfile(): Promise<Record<string, unknown>> {
    const { data, error } = await admin
      .from("profiles")
      .select("free_sessions_left, plan, retention_days, name")
      .eq("id", userId)
      .single();
    throwOnError("đọc profile", error);
    return data as Record<string, unknown>;
  }

  test("test_profiles_authenticated_cannot_raise_own_free_sessions_left", async () => {
    // Arrange — đây LÀ trần chi phí của sản phẩm
    const before = await readProfile();

    // Act — kẻ tấn công tự cấp thêm buổi free
    const { error } = await authed.from("profiles").update({ free_sessions_left: 9999 }).eq("id", userId);

    // Assert — bị chặn ở tầng quyền, và giá trị trong DB KHÔNG đổi
    expect(error?.code).toBe(PERMISSION_DENIED);
    const after = await readProfile();
    expect(after.free_sessions_left).toBe(before.free_sessions_left);
  });

  test("test_profiles_authenticated_cannot_change_own_plan", async () => {
    // Arrange
    const before = await readProfile();

    // Act
    const { error } = await authed.from("profiles").update({ plan: "enterprise" }).eq("id", userId);

    // Assert
    expect(error?.code).toBe(PERMISSION_DENIED);
    const after = await readProfile();
    expect(after.plan).toBe(before.plan);
  });

  test("test_profiles_authenticated_cannot_change_own_retention_days", async () => {
    // Arrange — retention_days=0 làm mọi session của user thành "hết hạn" [M6]
    const before = await readProfile();

    // Act
    const { error } = await authed.from("profiles").update({ retention_days: 0 }).eq("id", userId);

    // Assert
    expect(error?.code).toBe(PERMISSION_DENIED);
    const after = await readProfile();
    expect(after.retention_days).toBe(before.retention_days);
  });

  test("test_profiles_authenticated_can_still_update_own_name", async () => {
    // Arrange — thu hẹp quyền KHÔNG được giết tính năng chính đáng
    // Act
    const { error } = await authed.from("profiles").update({ name: "Nguyễn Văn Test" }).eq("id", userId);

    // Assert
    expect(error).toBeNull();
    const after = await readProfile();
    expect(after.name).toBe("Nguyễn Văn Test");
  });

  test("test_profiles_retention_days_zero_rejected_even_for_service_role", async () => {
    // Arrange — lớp 2: CHECK chặn cả đường service-role lỡ tay, không chỉ user
    // Act
    const { error } = await admin.from("profiles").update({ retention_days: 0 }).eq("id", userId);

    // Assert
    expect(error?.code).toBe(CHECK_VIOLATION);
  });

  test("test_profiles_retention_days_negative_rejected_even_for_service_role", async () => {
    // Arrange + Act — số âm còn tệ hơn 0: now() - (-30 days) = tương lai
    const { error } = await admin.from("profiles").update({ retention_days: -30 }).eq("id", userId);

    // Assert
    expect(error?.code).toBe(CHECK_VIOLATION);
  });

  test("test_profiles_retention_days_within_range_still_accepted", async () => {
    // Arrange — hàng rào không được chặn giá trị hợp lệ
    // Act
    const { error } = await admin.from("profiles").update({ retention_days: 30 }).eq("id", userId);

    // Assert
    expect(error).toBeNull();
    const after = await readProfile();
    expect(after.retention_days).toBe(30);
    // Trả lại mặc định cho các test sau
    await admin.from("profiles").update({ retention_days: 90 }).eq("id", userId);
  });
});

/**
 * Lớp 3 — `purge_sessions` tự tính lại điều kiện hết hạn thay vì tin caller.
 * Trước bản vá: `delete from sessions where id = any(p_ids)` xoá mù theo id, nên
 * một lần truyền nhầm id là mất dữ liệu khách vĩnh viễn (xoá cứng, không backup).
 */
suite("purge_sessions — không xoá session chưa hết hạn", () => {
  const email = `purge-guard-${Date.now()}@example.test`;
  const freshSessionId = "44444444-4444-4444-8444-444444444444";
  const expiredSessionId = "55555555-5555-4555-8555-555555555555";

  let admin: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    admin = createAdminClient();
    userId = await createTestUser(admin, email);
    // retention mặc định 90 ngày: 1 session mới toanh, 1 session 91 ngày tuổi.
    await seedSession(admin, { id: freshSessionId, userId, fields: { status: "done" } });
    await seedSession(admin, {
      id: expiredSessionId,
      userId,
      fields: { status: "done" },
      offsetsMs: { ended_at: -91 * DAY_MS, created_at: -91 * DAY_MS },
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await deleteTestUsers(admin, [userId]);
  }, HOOK_TIMEOUT_MS);

  test("test_purge_sessions_with_not_yet_expired_id_deletes_nothing", async () => {
    // Arrange — caller truyền NHẦM id của session còn hạn
    // Act
    const { error } = await admin.rpc("purge_sessions", { p_ids: [freshSessionId] });

    // Assert — RPC chạy bình thường nhưng KHÔNG xoá gì
    expect(error).toBeNull();
    const { data } = await admin.from("sessions").select("id").eq("id", freshSessionId).maybeSingle();
    expect(data).not.toBeNull();
  });

  test("test_purge_sessions_with_expired_id_still_deletes", async () => {
    // Arrange — đường chính không được gãy: session hết hạn thật vẫn phải xoá
    // Act
    const { error } = await admin.rpc("purge_sessions", { p_ids: [expiredSessionId] });

    // Assert
    expect(error).toBeNull();
    const { data } = await admin.from("sessions").select("id").eq("id", expiredSessionId).maybeSingle();
    expect(data).toBeNull();
  });
});
