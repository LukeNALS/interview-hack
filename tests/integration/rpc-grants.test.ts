import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  createAdminClient,
  createAnonClient,
  createTestUser,
  deleteTestUsers,
  signInAsUser,
  throwOnError,
} from "./db-test-support";

/**
 * Lưới chống GRANT DRIFT trên RPC — nợ H-2 của phiên trả nợ P07.
 *
 * VÌ SAO CẦN: migration 0007 và 0008 tồn tại CHỈ vì grant bị mất im lặng
 * (`get_shared_report` mất execute cho `anon`, các hàm retention mất cho
 * `service_role`). Không có test nào bắt được — CI vẫn xanh, lỗi chỉ lộ ra ở
 * production. Fix H3 làm hậu quả của cùng regression đó NẶNG HƠN: trước là rate
 * limit tắt im lặng, nay là 503 hàng loạt. Nên phải có test.
 *
 * Kiểm theo HÀNH VI THẬT (gọi RPC bằng đúng role) chứ không đọc
 * `has_function_privilege`: test tầng db đi qua PostgREST nên không chạy được
 * SQL thô, và quan trọng hơn — hành vi thật phủ luôn cả role resolution + RLS,
 * tức đúng đường mà request production đi.
 *
 * Kiểm CẢ HAI CHIỀU drift:
 *  - role ĐÁNG CÓ quyền mà mất  -> app gãy (đây là 0007/0008 đã xảy ra).
 *  - role KHÔNG đáng có mà lại có -> lỗ hổng leo thang đặc quyền.
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

/** SQLSTATE `permission denied for function`. */
const PERMISSION_DENIED = "42501";

suite("GRANT của RPC — chống drift (H-2)", () => {
  const email = `rpc-grants-${Date.now()}@example.test`;
  const rateLimitKey = `rpc-grants-test:${Date.now()}`;
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const shareToken = `tok-rpc-grants-${Date.now()}`;

  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let authed: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    // Arrange — 3 client tương ứng 3 role thật: service_role / anon / authenticated.
    admin = createAdminClient();
    anon = createAnonClient();
    userId = await createTestUser(admin, email);
    authed = await signInAsUser(email);

    // Session có share_token — để kiểm anon THỰC SỰ gọi được get_shared_report.
    const seeded = await admin
      .from("sessions")
      .insert({
        id: sessionId,
        user_id: userId,
        status: "done",
        share_token: shareToken,
        // DB có CHECK `sessions_share_token_requires_expiry` (M16, migration 0014): có token thì
        // BẮT BUỘC có hạn. Thiếu dòng này là seed vi phạm constraint, cả suite skip.
        share_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    throwOnError("seed session cho share token", seeded.error);
  });

  afterAll(async () => {
    await admin.from("rate_limit_counters").delete().eq("key", rateLimitKey);
    await deleteTestUsers(admin, [userId]);
  });

  /**
   * ĐÂY là test then chốt của H-2: mất grant này thì fix H3 biến mọi endpoint
   * fail-closed thành 503 — user không tạo/xoá/chia sẻ được gì.
   */
  test("test_bump_rate_limit_grant_authenticated_can_execute", async () => {
    // Arrange — cửa sổ rộng + limit cao để không phụ thuộc lần chạy trước
    // Act
    const { data, error } = await authed.rpc("bump_rate_limit", {
      p_key: rateLimitKey,
      p_window: "3600 seconds",
      p_limit: 1000,
    });

    // Assert — chạy được VÀ trả boolean (không phải null do lỗi nuốt)
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  test("test_bump_rate_limit_grant_service_role_can_execute", async () => {
    // Arrange + Act — service_role dùng cho route public /r/[token] [P06 fix M1]
    const { data, error } = await admin.rpc("bump_rate_limit", {
      p_key: rateLimitKey,
      p_window: "3600 seconds",
      p_limit: 1000,
    });

    // Assert
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  test("test_bump_rate_limit_grant_anon_is_denied", async () => {
    // Arrange + Act — anon KHÔNG được grant (0003_functions.sql:192)
    const { error } = await anon.rpc("bump_rate_limit", {
      p_key: rateLimitKey,
      p_window: "3600 seconds",
      p_limit: 1000,
    });

    // Assert — chiều drift ngược: anon có quyền = ai cũng bơm được counter
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  /**
   * N1 mở rộng (đo 2026-08-21): prod tự GRANT `anon` cho CẢ 3 hàm quota, không chỉ
   * `bump_rate_limit`. Tái hiện ở local cho thấy anon trừ được quota tiền của người khác
   * (`free 3 -> 2`) vì guard `v_user_id <> auth.uid()` ra NULL khi anon gọi → `if NULL`
   * không raise. Migration 0012 vá 2 lớp: revoke anon + guard `is distinct from`.
   * Ca dưới khoá LỚP 1 (grant).
   */
  test.each(["debit_free_session", "refund_free_session", "next_utterance_seq"] as const)(
    "test_quota_rpc_grant_anon_is_denied_%s",
    async (fn) => {
      // Arrange + Act — anon KHÔNG được grant (0012)
      const { error } = await anon.rpc(fn, { p_session: sessionId });

      // Assert — anon gọi được = trừ/hoàn quota tiền của chủ session
      expect(error?.code).toBe(PERMISSION_DENIED);
    },
  );

  /**
   * LỚP 2 của 0012 (chốt chặn đúng `anon` đọc từ JWT claims) KHÔNG khoá được ở tầng này:
   * muốn kiểm nó phải GRANT lại execute cho anon rồi thu hồi, tức DDL — `test:db` chạy qua
   * supabase-js nên không làm được. Đã verify thủ công trên local (báo cáo phiên
   * n1-anon-grant-drift.md): grant lại anon => "anon không được gọi hàm này" 42501, quota
   * KHÔNG đổi; còn đường cron (claims NULL) vẫn hoàn quota bình thường.
   */

  /**
   * Chính là hàm mà migration 0008 phải viết ra để vá.
   *
   * Kiểm bằng token HỢP LỆ chứ không phải token sai: token sai làm hàm
   * `raise exception ... errcode = 'P0002'`, mà PostgREST 14.16 (local stack)
   * trả về HTTP 500 kèm body text thuần `"Something went wrong"` — supabase-js
   * không bóc ra được `error.code`, nên không phân biệt nổi "bị từ chối quyền"
   * với "token không tồn tại". Đường token hợp lệ thì dứt khoát: có grant -> có
   * data; mất grant -> 42501.
   */
  test("test_get_shared_report_grant_anon_can_execute_with_valid_token", async () => {
    // Arrange — session thật có share_token (seed ở beforeAll)
    // Act
    const { data, error } = await anon.rpc("get_shared_report", { p_token: shareToken });

    // Assert
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test("test_orphan_scan_grant_service_role_can_execute", async () => {
    // Arrange + Act — job cron dọn orphan chạy bằng service-role (migration 0009)
    const { error } = await admin.rpc("list_orphan_storage_objects", {
      p_older_than: "24 hours",
      p_limit: 1,
    });

    // Assert
    expect(error).toBeNull();
  });

  test("test_orphan_scan_grant_anon_and_authenticated_are_denied", async () => {
    // Arrange + Act — hàm liệt kê path file của MỌI user, chỉ service_role được đọc
    const anonResult = await anon.rpc("list_orphan_storage_objects", {
      p_older_than: "24 hours",
      p_limit: 1,
    });
    const authedResult = await authed.rpc("list_orphan_storage_objects", {
      p_older_than: "24 hours",
      p_limit: 1,
    });

    // Assert
    expect(anonResult.error?.code).toBe(PERMISSION_DENIED);
    expect(authedResult.error?.code).toBe(PERMISSION_DENIED);
  });

  test("test_retention_rpc_grants_are_service_role_only", async () => {
    // Arrange + Act — purge/list_expired xoá dữ liệu khách, tuyệt đối không cho user gọi
    const listExpired = await authed.rpc("list_expired_sessions");
    const purge = await authed.rpc("purge_sessions", { p_ids: [] });
    const sweep = await authed.rpc("sweep_abandoned_sessions");

    // Assert
    expect(listExpired.error?.code).toBe(PERMISSION_DENIED);
    expect(purge.error?.code).toBe(PERMISSION_DENIED);
    expect(sweep.error?.code).toBe(PERMISSION_DENIED);
  });
});
