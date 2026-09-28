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
 * `start_session` / `end_session` / `mark_session_capped` (migration 0018, port từ
 * interview-copilot fix/session-quota-lockdown 7e1bbc5) — RPC atomic thay cho
 * debit/update tách rời cũ. Server tự tính thời gian trong DB (không tin client/route),
 * tự guard double-debit/double-refund/double-end qua `for update` + idempotent check.
 * Additive-only ở 0018 (không revoke gì) — suite này chạy độc lập, không phụ thuộc
 * lockdown cột của 0019 (xem `session-lockdown.test.ts`).
 *
 * KHÁC BẢN COPILOT: Interview Hack không có report pipeline — `end_session` ở đây
 * KHÔNG nhận `p_skip_report`, mọi lần kết thúc hợp lệ (fresh-end HOẶC cap-pending)
 * đều chốt thẳng status='done' (không có nhánh 'processing' chờ report).
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

const CAP_SECONDS = 5400;
const HOOK_TIMEOUT_MS = 30_000;

async function readFreeSessionsLeft(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin.from("profiles").select("free_sessions_left").eq("id", userId).single();
  throwOnError(`đọc profile ${userId}`, error);
  return (data as { free_sessions_left: number }).free_sessions_left;
}

async function setFreeSessionsLeft(admin: SupabaseClient, userId: string, value: number): Promise<void> {
  const { error } = await admin.from("profiles").update({ free_sessions_left: value }).eq("id", userId);
  throwOnError(`set free_sessions_left cho ${userId}`, error);
}

suite("RPC vòng đời session (0018) — start/end/cap atomic", () => {
  const suffix = Date.now();
  const emailOwner = `rpc-lifecycle-owner-${suffix}@example.test`;
  const emailOther = `rpc-lifecycle-other-${suffix}@example.test`;

  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let other: SupabaseClient;
  let ownerId = "";
  let otherId = "";

  beforeAll(async () => {
    admin = createAdminClient();
    ownerId = await createTestUser(admin, emailOwner);
    otherId = await createTestUser(admin, emailOther);
    owner = await signInAsUser(emailOwner);
    other = await signInAsUser(emailOther);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await deleteTestUsers(admin, [ownerId, otherId]);
  }, HOOK_TIMEOUT_MS);

  describe("start_session — debit đúng 1 lần, idempotent, xử lý legacy dở dang", () => {
    test("test_start_session_normal_flow_debits_once_and_sets_live", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 3);
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep", cap_seconds: CAP_SECONDS } });

      // Act
      const { data, error } = await owner.rpc("start_session", { p_session: sessionId, p_mode: "direct" });

      // Assert
      expect(error).toBeNull();
      expect(data?.status).toBe("live");
      expect(data?.mode).toBe("direct");
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(2);
    });

    test("test_start_session_concurrent_double_call_debits_exactly_once", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 3);
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep", cap_seconds: CAP_SECONDS } });

      // Act — 2 request start song song (double-submit client) — `for update` serializes.
      const [r1, r2] = await Promise.all([
        owner.rpc("start_session", { p_session: sessionId }),
        owner.rpc("start_session", { p_session: sessionId }),
      ]);

      // Assert — 1 trong 2 thành công qua nhánh debit, cái còn lại idempotent (cũng thành
      // công, KHÔNG lỗi — vì sau khi cái đầu commit, cái sau thấy status='live'+debited).
      expect(r1.error).toBeNull();
      expect(r2.error).toBeNull();
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(2);
    });

    test("test_start_session_legacy_prep_with_debited_flag_completes_without_double_debit", async () => {
      // Arrange — mô phỏng session dở dang từ code PRE-0018 (route cũ debit rồi update
      // KHÔNG cùng transaction, crash giữa chừng): status='prep' NHƯNG quota_debited=true.
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 3);
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "prep", quota_debited: true, quota_refunded: false, cap_seconds: CAP_SECONDS },
      });
      const quotaBeforeStart = await readFreeSessionsLeft(admin, ownerId);

      // Act
      const { data, error } = await owner.rpc("start_session", { p_session: sessionId });

      // Assert — hoàn tất chuyển live, KHÔNG debit thêm lần nào.
      expect(error).toBeNull();
      expect(data?.status).toBe("live");
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(quotaBeforeStart);
    });

    test("test_start_session_when_zero_free_sessions_raises_p0001", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 0);
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep", cap_seconds: CAP_SECONDS } });

      // Act
      const { error } = await owner.rpc("start_session", { p_session: sessionId });

      // Assert
      expect(error?.message).toContain("hết buổi free");
      await setFreeSessionsLeft(admin, ownerId, 3);
    });

    test("test_start_session_non_owner_is_rejected", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep", cap_seconds: CAP_SECONDS } });

      // Act — user KHÁC gọi start_session lên session của owner.
      const { error } = await other.rpc("start_session", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("42501");
    });
  });

  describe("end_session — chốt thẳng 'done' (không report pipeline), refund <5', idempotent, guard vòng đời", () => {
    test("test_end_session_short_session_refunds_exactly_once", async () => {
      // Arrange — buổi live 1 phút, đã debit.
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 2);
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", quota_debited: true, cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -1 * MINUTE_MS },
      });
      const quotaBefore = await readFreeSessionsLeft(admin, ownerId);

      // Act — gọi end 2 lần: lần 1 refund thật, lần 2 idempotent.
      const r1 = await owner.rpc("end_session", { p_session: sessionId });
      const r2 = await owner.rpc("end_session", { p_session: sessionId });

      // Assert — Hack chốt thẳng 'done' (không có 'processing' chờ report).
      expect(r1.error).toBeNull();
      expect(r1.data?.status).toBe("done");
      expect(r2.error).toBeNull();
      expect(r2.data?.ended_at).toBe(r1.data?.ended_at);
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(quotaBefore + 1);
    });

    test("test_end_session_concurrent_double_call_refunds_exactly_once", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 2);
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", quota_debited: true, cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -1 * MINUTE_MS },
      });
      const quotaBefore = await readFreeSessionsLeft(admin, ownerId);

      // Act
      const [r1, r2] = await Promise.all([
        owner.rpc("end_session", { p_session: sessionId }),
        owner.rpc("end_session", { p_session: sessionId }),
      ]);

      // Assert — cả 2 thành công (idempotent), nhưng CHỈ 1 lần refund thật.
      expect(r1.error).toBeNull();
      expect(r2.error).toBeNull();
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(quotaBefore + 1);
    });

    test("test_end_session_long_session_does_not_refund", async () => {
      // Arrange — buổi 20 phút (>= ngưỡng 300s).
      const sessionId = crypto.randomUUID();
      await setFreeSessionsLeft(admin, ownerId, 2);
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", quota_debited: true, cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -20 * MINUTE_MS },
      });
      const quotaBefore = await readFreeSessionsLeft(admin, ownerId);

      // Act
      const { data, error } = await owner.rpc("end_session", { p_session: sessionId });

      // Assert
      expect(error).toBeNull();
      expect(data?.status).toBe("done");
      expect(data?.duration_sec).toBeGreaterThanOrEqual(300);
      expect(await readFreeSessionsLeft(admin, ownerId)).toBe(quotaBefore);
    });

    test("test_end_session_from_prep_without_started_at_is_rejected", async () => {
      // Arrange — session CHƯA từng start (audit #2: coalesce(duration,0) cũ cho phép
      // refund một session chưa hề chạy — guard mới reject tường minh).
      const sessionId = crypto.randomUUID();
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "prep", cap_seconds: CAP_SECONDS } });

      // Act
      const { error } = await owner.rpc("end_session", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("P0001");
    });

    test("test_end_session_cap_pending_also_sets_status_done", async () => {
      // Arrange — session đã bị cap ở route utterances (processing/cap, ended_at NULL) —
      // /end phải hoàn tất thành 'done' (khớp hành vi route hiện tại).
      const sessionId = crypto.randomUUID();
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "processing", ended_reason: "cap", cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -100 * MINUTE_MS },
      });

      // Act
      const { data, error } = await owner.rpc("end_session", { p_session: sessionId });

      // Assert
      expect(error).toBeNull();
      expect(data?.status).toBe("done");
      expect(data?.ended_reason).toBe("cap");
    });

    test("test_end_session_non_owner_is_rejected", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -1 * MINUTE_MS },
      });

      // Act
      const { error } = await other.rpc("end_session", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("42501");
    });
  });

  describe("mark_session_capped — server tự tính elapsed, không tin client", () => {
    test("test_mark_session_capped_before_cap_is_rejected", async () => {
      // Arrange — buổi mới chạy 1 phút, cap 90'.
      const sessionId = crypto.randomUUID();
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -1 * MINUTE_MS },
      });

      // Act
      const { error } = await owner.rpc("mark_session_capped", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("P0001");
    });

    test("test_mark_session_capped_after_cap_marks_processing", async () => {
      // Arrange — started_at 100' trước, cap 90' -> đã vượt.
      const sessionId = crypto.randomUUID();
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -100 * MINUTE_MS },
      });

      // Act
      const { data, error } = await owner.rpc("mark_session_capped", { p_session: sessionId });

      // Assert
      expect(error).toBeNull();
      expect(data?.status).toBe("processing");
      expect(data?.ended_reason).toBe("cap");
    });

    test("test_mark_session_capped_when_not_live_is_rejected", async () => {
      // Arrange — session đã 'done', không còn 'live' để mark cap.
      const sessionId = crypto.randomUUID();
      await seedSession(admin, { id: sessionId, userId: ownerId, fields: { status: "done" } });

      // Act
      const { error } = await owner.rpc("mark_session_capped", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("P0001");
    });

    test("test_mark_session_capped_non_owner_is_rejected", async () => {
      // Arrange
      const sessionId = crypto.randomUUID();
      await seedSession(admin, {
        id: sessionId,
        userId: ownerId,
        fields: { status: "live", cap_seconds: CAP_SECONDS },
        offsetsMs: { started_at: -100 * MINUTE_MS },
      });

      // Act
      const { error } = await other.rpc("mark_session_capped", { p_session: sessionId });

      // Assert
      expect(error?.code).toBe("42501");
    });
  });
});
