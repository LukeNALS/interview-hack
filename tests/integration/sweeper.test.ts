import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  countBySession,
  createAdminClient,
  createTestUser,
  deleteTestUsers,
  MINUTE_MS,
  seedSession,
  throwOnError,
} from "./db-test-support";

/**
 * Sweeper session bỏ rơi (AC3) — `sweep_abandoned_sessions()` của migration 0006,
 * chạy đối đầu local Supabase stack. Mỗi test có user + session RIÊNG nên gọi
 * sweep nhiều lần không lây trạng thái (session đã xử lý không còn 'live').
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

const CAP_SECONDS = 5400; // 90 phút — grace thêm 600s ⇒ quá hạn khi elapsed > 100 phút.

type SessionRow = {
  status: string;
  ended_at: string | null;
  ended_reason: string | null;
  duration_sec: number | null;
  quota_refunded: boolean;
};

async function readSession(admin: SupabaseClient, id: string): Promise<SessionRow> {
  const { data, error } = await admin
    .from("sessions")
    .select("status, ended_at, ended_reason, duration_sec, quota_refunded")
    .eq("id", id)
    .single();
  throwOnError(`đọc session ${id}`, error);
  return data as SessionRow;
}

async function readFreeSessionsLeft(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin
    .from("profiles")
    .select("free_sessions_left")
    .eq("id", userId)
    .single();
  throwOnError(`đọc profile ${userId}`, error);
  return (data as { free_sessions_left: number }).free_sessions_left;
}

suite("Sweeper — sweep_abandoned_sessions (local stack)", () => {
  const suffix = Date.now();
  const emails = {
    abandoned: `sweeper-abandoned-${suffix}@example.com`,
    within: `sweeper-within-${suffix}@example.com`,
    noUtterance: `sweeper-no-utt-${suffix}@example.com`,
  };

  let admin: SupabaseClient;
  const userIds: Record<keyof typeof emails, string> = { abandoned: "", within: "", noUtterance: "" };

  beforeAll(async () => {
    admin = createAdminClient();
    for (const key of Object.keys(emails) as Array<keyof typeof emails>) {
      userIds[key] = await createTestUser(admin, emails[key]);
    }
  }, 60000);

  afterAll(async () => {
    await deleteTestUsers(admin, Object.values(userIds));
  }, 60000);

  test("test_sweeper_abandoned_live_session_past_cap_is_auto_ended_with_report_job_and_refund", async () => {
    // Arrange — buổi live bỏ rơi 100' (> cap 90' + grace 10'), đã trừ quota, user hết buổi free,
    // utterance cuối dừng ở phút 2 ⇒ thời lượng thực = 120s.
    const userId = userIds.abandoned;
    const sessionId = crypto.randomUUID();
    const quotaZero = await admin.from("profiles").update({ free_sessions_left: 0 }).eq("id", userId);
    throwOnError("set free_sessions_left=0", quotaZero.error);

    await seedSession(admin, {
      id: sessionId,
      userId,
      fields: { status: "live", cap_seconds: CAP_SECONDS, quota_debited: true, last_seq: 1 },
      offsetsMs: { started_at: -100 * MINUTE_MS },
    });
    const utt = await admin.from("utterances").insert({
      session_id: sessionId,
      seq: 1,
      speaker: "candidate",
      lang: "vi",
      text_orig: "Em xin phép giới thiệu",
      t_start_ms: 0,
      t_end_ms: 120_000,
    });
    throwOnError("seed utterance", utt.error);

    // Act
    const swept = await admin.rpc("sweep_abandoned_sessions");
    throwOnError("rpc sweep_abandoned_sessions", swept.error);

    // Assert — session auto-end theo thời lượng THỰC (utterance), không phải elapsed wall-clock.
    const session = await readSession(admin, sessionId);
    expect(session.status).toBe("processing");
    expect(session.ended_reason).toBe("cap");
    expect(session.ended_at).not.toBeNull();
    expect(session.duration_sec).toBe(120);

    // Assert — job report bước 0 được tạo để user mở lại /wait là resume được.
    const { data: jobs, error: jobsError } = await admin
      .from("report_jobs")
      .select("step, step_status")
      .eq("session_id", sessionId);
    throwOnError("đọc report_jobs", jobsError);
    expect(jobs).toEqual([{ step: 0, step_status: "pending" }]);

    // Assert — quota hoàn đúng 1 buổi, cờ chống hoàn 2 lần đã bật.
    expect(await readFreeSessionsLeft(admin, userId)).toBe(1);
    expect(session.quota_refunded).toBe(true);
  }, 60000);

  test("test_sweeper_live_session_within_cap_is_untouched", async () => {
    // Arrange — buổi live mới 30' (chưa chạm cap 90' + grace).
    const userId = userIds.within;
    const sessionId = crypto.randomUUID();
    await seedSession(admin, {
      id: sessionId,
      userId,
      fields: { status: "live", cap_seconds: CAP_SECONDS, quota_debited: true },
      offsetsMs: { started_at: -30 * MINUTE_MS },
    });

    // Act
    const swept = await admin.rpc("sweep_abandoned_sessions");
    throwOnError("rpc sweep_abandoned_sessions", swept.error);

    // Assert — không bị đụng gì, cũng không sinh report job.
    const session = await readSession(admin, sessionId);
    expect(session.status).toBe("live");
    expect(session.ended_at).toBeNull();
    expect(session.ended_reason).toBeNull();
    expect(session.duration_sec).toBeNull();
    expect(session.quota_refunded).toBe(false);
    expect(await countBySession(admin, "report_jobs", sessionId)).toBe(0);
  }, 60000);

  test("test_sweeper_abandoned_session_without_utterance_falls_back_to_elapsed_and_skips_refund", async () => {
    // Arrange — buổi live bỏ rơi 100' nhưng KHÔNG có utterance nào (im lặng/không ingest).
    const userId = userIds.noUtterance;
    const sessionId = crypto.randomUUID();
    const quotaZero = await admin.from("profiles").update({ free_sessions_left: 0 }).eq("id", userId);
    throwOnError("set free_sessions_left=0", quotaZero.error);

    await seedSession(admin, {
      id: sessionId,
      userId,
      fields: { status: "live", cap_seconds: CAP_SECONDS, quota_debited: true },
      offsetsMs: { started_at: -100 * MINUTE_MS },
    });

    // Act
    const swept = await admin.rpc("sweep_abandoned_sessions");
    throwOnError("rpc sweep_abandoned_sessions", swept.error);

    // Assert — duration = elapsed wall-clock (~6000s), ≥300s nên KHÔNG hoàn quota.
    const session = await readSession(admin, sessionId);
    expect(session.status).toBe("processing");
    expect(session.ended_reason).toBe("cap");
    expect(session.duration_sec).toBeGreaterThanOrEqual(100 * 60);
    expect(session.duration_sec).toBeLessThan(101 * 60);
    expect(session.quota_refunded).toBe(false);
    expect(await readFreeSessionsLeft(admin, userId)).toBe(0);
    expect(await countBySession(admin, "report_jobs", sessionId)).toBe(1);
  }, 60000);
});
