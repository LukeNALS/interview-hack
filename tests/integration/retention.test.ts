import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canRunDbTests,
  countBySession,
  createAdminClient,
  createTestUser,
  DAY_MS,
  deleteTestUsers,
  seedSession,
  throwOnError,
} from "./db-test-support";

/**
 * Retention (AC6) — chạy ĐÚNG luồng Edge Function `purge-expired` đối đầu DB thật
 * (local Supabase stack): RPC `list_expired_sessions()` → (Storage remove, ngoài
 * phạm vi test này) → RPC `purge_sessions(ids)`.
 *
 * Opt-in qua SUPABASE_TEST_* (xem db-test-support.ts) — `pnpm test:db`.
 */

const suite = canRunDbTests ? describe : describe.skip;

/** Signed URL export giả — chỉ cần khớp mẫu `/object/sign/exports/<path>?token=` mà migration 0006 bóc path. */
function fakeExportSignedUrl(path: string): string {
  return `https://fake-project.supabase.co/storage/v1/object/sign/exports/${path}?token=fake-jwt-token`;
}

type ChildCounts = Record<"questions" | "utterances" | "reports" | "report_jobs" | "export_jobs", number>;

async function childCounts(admin: SupabaseClient, sessionId: string): Promise<ChildCounts> {
  const tables = ["questions", "utterances", "reports", "report_jobs", "export_jobs"] as const;
  const entries = await Promise.all(
    tables.map(async (table) => [table, await countBySession(admin, table, sessionId)] as const),
  );
  return Object.fromEntries(entries) as ChildCounts;
}

/** Seed đủ 5 bảng con cho 1 session — để chứng minh cascade xoá sạch. */
async function seedChildRows(
  admin: SupabaseClient,
  sessionId: string,
  opts: { exportPath?: string } = {},
): Promise<void> {
  const q = await admin
    .from("questions")
    .insert({ session_id: sessionId, order_idx: 0, text: "Kể về một dự án khó nhất bạn từng làm" });
  throwOnError(`seed questions ${sessionId}`, q.error);

  const u = await admin.from("utterances").insert({
    session_id: sessionId,
    seq: 1,
    speaker: "candidate",
    lang: "vi",
    text_orig: "Tổng quan về Chuyển đổi số",
    t_start_ms: 0,
    t_end_ms: 1500,
  });
  throwOnError(`seed utterances ${sessionId}`, u.error);

  const r = await admin.from("reports").insert({ session_id: sessionId, status: "ready" });
  throwOnError(`seed reports ${sessionId}`, r.error);

  const rj = await admin
    .from("report_jobs")
    .insert({ session_id: sessionId, step: 0, step_status: "done" });
  throwOnError(`seed report_jobs ${sessionId}`, rj.error);

  const ej = await admin.from("export_jobs").insert({
    session_id: sessionId,
    mode: "combined",
    langs: ["vi", "ja"],
    status: "ready",
    files: opts.exportPath ? [fakeExportSignedUrl(opts.exportPath)] : [],
  });
  throwOnError(`seed export_jobs ${sessionId}`, ej.error);
}

suite("Retention — list_expired_sessions + purge_sessions (local stack)", () => {
  const suffix = Date.now();
  const emailDefault = `retention-90-${suffix}@example.com`;
  const emailShort = `retention-30-${suffix}@example.com`;

  let admin: SupabaseClient;
  let userDefaultId: string; // retention_days = 90
  let userShortId: string; // retention_days = 30

  // Mỗi test dùng session RIÊNG — không test nào phụ thuộc trạng thái test khác.
  const expiredId = crypto.randomUUID(); // 91 ngày, user 90d → hết hạn
  const keptId = crypto.randomUUID(); // 89 ngày, user 90d → CÒN
  const midAgeDefaultId = crypto.randomUUID(); // 40 ngày, user 90d → CÒN
  const midAgeShortId = crypto.randomUUID(); // 40 ngày, user 30d → hết hạn
  const storagePathsId = crypto.randomUUID(); // 91 ngày, có cv + export file

  let cvPath: string;
  let exportPath: string;

  beforeAll(async () => {
    admin = createAdminClient();

    userDefaultId = await createTestUser(admin, emailDefault);
    userShortId = await createTestUser(admin, emailShort);

    const shortRetention = await admin
      .from("profiles")
      .update({ retention_days: 30 })
      .eq("id", userShortId);
    throwOnError("set retention_days=30", shortRetention.error);

    cvPath = `${userDefaultId}/${storagePathsId}/cv.pdf`;
    exportPath = `${userDefaultId}/${storagePathsId}/1700000000000-report_ung-vien_2026-08-04_combined.pdf`;

    await seedSession(admin, {
      id: expiredId,
      userId: userDefaultId,
      fields: { status: "done", candidate_name: "Hết hạn 91 ngày", cv_file_path: `${userDefaultId}/${expiredId}/cv.pdf` },
      offsetsMs: { ended_at: -91 * DAY_MS },
    });
    await seedChildRows(admin, expiredId, { exportPath: `${userDefaultId}/${expiredId}/report.pdf` });

    await seedSession(admin, {
      id: keptId,
      userId: userDefaultId,
      fields: { status: "done", candidate_name: "Còn hạn 89 ngày" },
      offsetsMs: { ended_at: -89 * DAY_MS },
    });
    await seedChildRows(admin, keptId);

    await seedSession(admin, {
      id: midAgeDefaultId,
      userId: userDefaultId,
      fields: { status: "done", candidate_name: "40 ngày / giữ 90 ngày" },
      offsetsMs: { ended_at: -40 * DAY_MS },
    });

    await seedSession(admin, {
      id: midAgeShortId,
      userId: userShortId,
      fields: { status: "done", candidate_name: "40 ngày / giữ 30 ngày" },
      offsetsMs: { ended_at: -40 * DAY_MS },
    });

    await seedSession(admin, {
      id: storagePathsId,
      userId: userDefaultId,
      fields: { status: "done", candidate_name: "Kiểm tra storage_paths", cv_file_path: cvPath },
      offsetsMs: { ended_at: -91 * DAY_MS },
    });
    await seedChildRows(admin, storagePathsId, { exportPath });
  }, 60000);

  afterAll(async () => {
    // Xoá user → cascade sạch profiles + sessions + mọi bảng con đã seed.
    await deleteTestUsers(admin, [userDefaultId, userShortId]);
  }, 60000);

  test("test_retention_job_deletes_session_older_than_retention_days_and_cascades", async () => {
    // Arrange — session 91 ngày (expiredId) + session 89 ngày (keptId), cả hai đủ 5 bảng con.
    expect(await childCounts(admin, expiredId)).toEqual({
      questions: 1,
      utterances: 1,
      reports: 1,
      report_jobs: 1,
      export_jobs: 1,
    });

    // Act — pha 1 Edge Function: liệt kê session hết hạn.
    const listed = await admin.rpc("list_expired_sessions");
    throwOnError("rpc list_expired_sessions", listed.error);
    const listedIds = (listed.data as Array<{ session_id: string }>).map((row) => row.session_id);

    // Assert — session 91 ngày bị liệt kê, session 89 ngày KHÔNG.
    expect(listedIds).toContain(expiredId);
    expect(listedIds).not.toContain(keptId);

    // Act — pha 2: xoá cứng đúng id đã liệt kê (Storage đã xoá trước ở Edge Function thật).
    const purged = await admin.rpc("purge_sessions", { p_ids: [expiredId] });
    throwOnError("rpc purge_sessions", purged.error);

    // Assert — session hết hạn biến mất + cascade sạch cả 5 bảng con.
    const gone = await admin.from("sessions").select("id").eq("id", expiredId);
    throwOnError("select session đã xoá", gone.error);
    expect(gone.data).toEqual([]);
    expect(await childCounts(admin, expiredId)).toEqual({
      questions: 0,
      utterances: 0,
      reports: 0,
      report_jobs: 0,
      export_jobs: 0,
    });

    // Assert — session 89 ngày còn nguyên kèm toàn bộ bảng con.
    const kept = await admin.from("sessions").select("id").eq("id", keptId);
    throwOnError("select session còn hạn", kept.error);
    expect(kept.data).toHaveLength(1);
    expect(await childCounts(admin, keptId)).toEqual({
      questions: 1,
      utterances: 1,
      reports: 1,
      report_jobs: 1,
      export_jobs: 1,
    });
  }, 60000);

  test("test_retention_uses_per_user_retention_days_not_hardcoded_90", async () => {
    // Arrange — 2 session cùng 40 ngày tuổi, khác chủ: user giữ 90 ngày vs user giữ 30 ngày.

    // Act
    const listed = await admin.rpc("list_expired_sessions");
    throwOnError("rpc list_expired_sessions", listed.error);
    const listedIds = (listed.data as Array<{ session_id: string }>).map((row) => row.session_id);

    // Assert — chỉ session của user retention_days=30 hết hạn.
    expect(listedIds).toContain(midAgeShortId);
    expect(listedIds).not.toContain(midAgeDefaultId);
  }, 60000);

  test("test_list_expired_sessions_returns_storage_paths_prefixed_by_bucket", async () => {
    // Arrange — session hết hạn có cv_file_path (path trần) + export_jobs.files (signed URL đầy đủ).

    // Act
    const listed = await admin.rpc("list_expired_sessions");
    throwOnError("rpc list_expired_sessions", listed.error);
    const row = (listed.data as Array<{ session_id: string; storage_paths: string[] }>).find(
      (r) => r.session_id === storagePathsId,
    );

    // Assert — đúng quy ước "<bucket>:<path>", export path đã bóc khỏi signed URL (bỏ query token).
    expect(row).toBeDefined();
    expect(row!.storage_paths).toEqual([`cv:${cvPath}`, `exports:${exportPath}`]);
  }, 60000);
});
