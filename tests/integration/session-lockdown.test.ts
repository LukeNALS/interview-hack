import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  createAdminClient,
  createTestUser,
  deleteTestUsers,
  MINUTE_MS,
  seedSession,
  signInAsUser,
  throwOnError,
} from "./db-test-support";

/**
 * Audit bảo mật 2026-09-28 (port từ interview-copilot fix/session-quota-lockdown
 * 956ed41) — `authenticated` có GRANT mức BẢNG trên `sessions` (0002/0017), policy
 * chỉ khoá DÒNG chứ không khoá CỘT. Khai thác xác nhận (tái hiện y hệt trên Interview
 * Hack — cùng schema gốc với copilot): forge `quota_debited=true, duration_sec=0` ->
 * gọi `refund_free_session` lặp lại (tự reset `quota_refunded=false` giữa 2 lần vì
 * UPDATE mở) -> free tăng vô hạn. `refund_free_session` cũ còn nhận session ĐANG SỐNG
 * (guard chỉ kiểm quota, không kiểm ended_at/status).
 *
 * Migration 0019 (lockdown, áp SAU 0018 — xem `session-rpc-lifecycle.test.ts` cho
 * hành vi RPC): khoá INSERT/UPDATE cột nhạy cảm của `sessions`, siết
 * `refund_free_session`/`debit_free_session` về service-role only + guard vòng đời.
 *
 * KHÁC BẢN COPILOT: rà `.from("sessions")` trong src/ của Hack (2026-09-28) không có
 * route non-lifecycle nào ghi cột khác (không CV, không share, không speaker-roles,
 * không generate-questions ghi quick_eval/candidate_name sau tạo) — nên KHÔNG có test
 * "cột X vẫn ghi được" kiểu `candidate_name` của bản copilot: ở Hack, UPDATE mức bảng
 * bị revoke HOÀN TOÀN (0019 không re-grant cột UPDATE nào) — test dưới xác nhận đúng
 * điều đó (`candidate_name` cũng bị chặn, khác hẳn copilot).
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

const PERMISSION_DENIED = "42501";
const CAP_SECONDS = 5400;
const HOOK_TIMEOUT_MS = 30_000;

interface SessionRow {
  id: string;
  status: string;
  quota_refunded: boolean;
}

async function readSession(admin: SupabaseClient, id: string): Promise<SessionRow> {
  const { data, error } = await admin.from("sessions").select("id, status, quota_refunded").eq("id", id).single();
  throwOnError(`đọc session ${id}`, error);
  return data as SessionRow;
}

async function readFreeSessionsLeft(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin.from("profiles").select("free_sessions_left").eq("id", userId).single();
  throwOnError(`đọc profile ${userId}`, error);
  return (data as { free_sessions_left: number }).free_sessions_left;
}

async function setFreeSessionsLeft(admin: SupabaseClient, userId: string, value: number): Promise<void> {
  const { error } = await admin.from("profiles").update({ free_sessions_left: value }).eq("id", userId);
  throwOnError(`set free_sessions_left cho ${userId}`, error);
}

suite("Session lockdown (0019) — cột nhạy cảm + refund/debit service-role only", () => {
  const suffix = Date.now();
  const emailOwner = `lockdown-owner-${suffix}@example.test`;

  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let ownerId = "";

  beforeAll(async () => {
    admin = createAdminClient();
    ownerId = await createTestUser(admin, emailOwner);
    owner = await signInAsUser(emailOwner);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await deleteTestUsers(admin, [ownerId]);
  }, HOOK_TIMEOUT_MS);

  describe("cột khoá trên sessions — PATCH trực tiếp bị từ chối", () => {
    const sessionId = crypto.randomUUID();

    beforeAll(async () => {
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep" } });
    }, HOOK_TIMEOUT_MS);

    test.each([
      ["status", { status: "live" }],
      ["quota_debited", { quota_debited: true }],
      ["quota_refunded", { quota_refunded: true }],
      ["cap_seconds", { cap_seconds: 1 }],
      ["duration_sec", { duration_sec: 0 }],
      ["started_at", { started_at: new Date().toISOString() }],
      ["ended_at", { ended_at: new Date().toISOString() }],
    ] as const)("test_sessions_authenticated_cannot_patch_%s_column_directly", async (_label, patch) => {
      // Arrange — chủ session CHÍNH CHỦ thử patch cột vòng đời/quota trực tiếp.
      // Act
      const { error } = await owner.from("sessions").update(patch).eq("id", sessionId);
      // Assert — chặn ở tầng GRANT cột (42501), không tới được RLS.
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    // KHÁC bản copilot: Hack không re-grant UPDATE cột nào (không route non-lifecycle
    // nào cần ghi trực tiếp) — `candidate_name` (cột INSERT-only ở Hack) cũng bị chặn UPDATE.
    test("test_sessions_authenticated_cannot_patch_candidate_name_column_either", async () => {
      // Arrange + Act — không có route nào update candidate_name sau khi tạo session ở Hack.
      const { error } = await owner.from("sessions").update({ candidate_name: "Đã sửa" }).eq("id", sessionId);
      // Assert
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    test("test_sessions_authenticated_insert_with_forged_status_live_is_denied", async () => {
      // Arrange + Act — forge session mới thẳng vào live, bỏ qua toàn bộ vòng đời.
      const { error } = await owner
        .from("sessions")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({ user_id: ownerId, status: "live", quota_debited: true } as any);
      // Assert
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    test("test_sessions_authenticated_insert_with_forged_cap_seconds_is_denied", async () => {
      // Arrange + Act
      const { error } = await owner
        .from("sessions")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({ user_id: ownerId, cap_seconds: 999999 } as any);
      // Assert
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    test("test_sessions_authenticated_plain_insert_still_works", async () => {
      // Arrange + Act — đường tạo session chính đáng (chỉ cột được cấp) vẫn chạy.
      const { data, error } = await owner
        .from("sessions")
        .insert({ user_id: ownerId, candidate_name: "Ứng viên mới", mode: "online", kind: "candidate" })
        .select("id, status")
        .single();
      // Assert — status ra default 'prep', KHÔNG phải do client set.
      expect(error).toBeNull();
      expect(data?.status).toBe("prep");
    });
  });

  describe("refund_free_session / debit_free_session — chỉ service-role", () => {
    const sessionId = crypto.randomUUID();

    beforeAll(async () => {
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep" } });
    }, HOOK_TIMEOUT_MS);

    test("test_refund_free_session_called_by_authenticated_is_denied", async () => {
      const { error } = await owner.rpc("refund_free_session", { p_session: sessionId });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    test("test_debit_free_session_called_by_authenticated_is_denied", async () => {
      const { error } = await owner.rpc("debit_free_session", { p_session: sessionId });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });
  });

  describe("khai thác audit #1 — forge cờ + refund lặp lại để tăng quota vô hạn", () => {
    const sessionId = crypto.randomUUID();

    beforeAll(async () => {
      await setFreeSessionsLeft(admin, ownerId, 3);
      // Seed y hệt payload khai thác: đã debit, duration=0, CHƯA refund, session vẫn 'prep'
      // (chưa hề chạy) — trước 0019 đây là forge hợp lệ qua PATCH trực tiếp.
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "prep", quota_debited: true, quota_refunded: false, duration_sec: 0 },
      });
    }, HOOK_TIMEOUT_MS);

    test("test_exploit_forge_debited_flag_then_direct_patch_is_blocked_end_to_end", async () => {
      // Arrange — trước khi khai thác: quota nguyên vẹn.
      const before = await readFreeSessionsLeft(admin, ownerId);

      // Act 1 — thử forge lại y hệt lần nữa qua PATCH trực tiếp (lớp 1: cột bị khoá).
      const patchAttempt = await owner
        .from("sessions")
        .update({ quota_debited: true, quota_refunded: false, duration_sec: 0 })
        .eq("id", sessionId);
      expect(patchAttempt.error?.code).toBe(PERMISSION_DENIED);

      // Act 2 — thử gọi refund trực tiếp (lớp 2: RPC chỉ service-role).
      const refundAttempt = await owner.rpc("refund_free_session", { p_session: sessionId });
      expect(refundAttempt.error?.code).toBe(PERMISSION_DENIED);

      // Assert — quota KHÔNG đổi qua toàn bộ chuỗi khai thác.
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(before);
    });
  });

  describe("khai thác audit #2 — refund session ĐANG SỐNG", () => {
    const sessionId = crypto.randomUUID();

    beforeAll(async () => {
      await setFreeSessionsLeft(admin, ownerId, 3);
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", quota_debited: true, quota_refunded: false, cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -2 * MINUTE_MS },
      });
    }, HOOK_TIMEOUT_MS);

    test("test_exploit_refund_while_session_still_live_is_blocked", async () => {
      // Arrange
      const before = await readFreeSessionsLeft(admin, ownerId);

      // Act — service-role gọi refund_free_session thẳng lên session ĐANG 'live'
      // (giả lập kịch bản caller cũ trước 0019 vẫn cố gọi) — guard vòng đời mới phải chặn.
      const { error } = await admin.rpc("refund_free_session", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("P0001");
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(before);
      const session = await readSession(admin, sessionId);
      expect(session.quota_refunded).toBe(false);
    });
  });

  describe("sweeper vẫn hoàn quota được sau lockdown (auth.uid() NULL đi qua guard mới)", () => {
    const sessionId = crypto.randomUUID();

    beforeAll(async () => {
      await setFreeSessionsLeft(admin, ownerId, 2);
      // Mô phỏng đúng trạng thái sweep_abandoned_sessions để lại TRƯỚC KHI gọi refund
      // (0006_retention_cron.sql:17-21): đã set ended_at/duration_sec/status='processing'.
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: {
          status: "processing",
          ended_reason: "cap",
          quota_debited: true,
          quota_refunded: false,
          duration_sec: 60,
        },
        offsetsMs: { started_at: -100 * MINUTE_MS, ended_at: -1 * MINUTE_MS },
      });
    }, HOOK_TIMEOUT_MS);

    test("test_sweeper_service_role_refund_with_null_auth_uid_still_succeeds_after_lockdown", async () => {
      // Arrange
      const before = await readFreeSessionsLeft(admin, ownerId);

      // Act — service-role client KHÔNG mang JWT user (auth.uid() NULL trong DB) — đúng
      // hợp đồng sweep_abandoned_sessions gọi refund_free_session nội bộ qua `perform`.
      const { error, data } = await admin.rpc("refund_free_session", { p_session: sessionId });

      // Assert — guard mới (0019) KHÔNG chặn nhầm đường sweep.
      expect(error).toBeNull();
      expect(data).toBe(before + 1);
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(before + 1);
    });
  });
});
