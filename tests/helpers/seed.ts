import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createTestUser, throwOnError } from "../integration/db-test-support";
import { readLocalSupabase } from "./local-supabase";

/**
 * Seed dữ liệu cho E2E. TÁI DÙNG `tests/integration/db-test-support.ts` cho phần
 * user/cleanup (`createTestUser`, `deleteTestUsers`, `throwOnError` đều nhận client
 * qua tham số nên dùng lại được nguyên vẹn); chỉ client factory là riêng vì
 * db-test-support đọc biến `SUPABASE_TEST_*` (do `pnpm test:db` set), còn E2E đọc
 * thẳng `supabase status`.
 */

export { deleteTestUsers } from "../integration/db-test-support";
export { TEST_PASSWORD } from "../integration/db-test-support";

export const MINUTE_MS = 60_000;

export function createE2eAdminClient(): SupabaseClient {
  const { url, serviceKey } = readLocalSupabase();
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Email duy nhất cho mỗi test — spec chạy song song, không được đụng nhau. */
export function uniqueEmail(prefix: string): string {
  return `e2e-${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export interface SeededUser {
  userId: string;
  email: string;
}

/** Tạo user (email đã confirm) + set quota free. */
export async function seedUser(
  admin: SupabaseClient,
  prefix: string,
  opts: { freeSessionsLeft?: number; email?: string } = {},
): Promise<SeededUser> {
  // `email` cố định dùng cho spec admin (ADMIN_EMAILS trong playwright.config là env
  // tĩnh lúc server start — không khớp được email random).
  const email = opts.email ?? uniqueEmail(prefix);
  const userId = await createTestUser(admin, email);
  if (opts.freeSessionsLeft !== undefined) {
    const { error } = await admin
      .from("profiles")
      .update({ free_sessions_left: opts.freeSessionsLeft })
      .eq("id", userId);
    throwOnError(`set free_sessions_left cho ${email}`, error);
  }
  return { userId, email };
}

export interface SeedSessionOpts {
  userId: string;
  status?: "prep" | "live" | "processing" | "done" | "failed";
  mode?: "online" | "direct";
  candidateName?: string;
  position?: string;
  /** Lùi `started_at` về quá khứ (ms) — dùng để giả buổi đã chạm cap 90'. */
  startedAtOffsetMs?: number;
  durationSec?: number;
  shareToken?: string;
  /** Hạn share link. Mặc định +30 ngày khi có `shareToken` — DB có CHECK
   *  `sessions_share_token_requires_expiry` (M16, migration 0014) nên token KHÔNG được thiếu hạn. */
  shareExpiresAt?: string;
  capSeconds?: number;
  /** Chế độ buổi (0015) — mặc định 'candidate' (Interview Hack chỉ ứng viên). */
  kind?: "interviewer" | "candidate";
  /** Mô tả buổi (candidate mode) — lưu jd_text. */
  jdText?: string;
  quotaDebited?: boolean;
}

/**
 * Seed 1 session. Mốc thời gian tính theo ĐỒNG HỒ POSTGRES (đọc `created_at` vừa
 * insert) chứ không theo đồng hồ máy test — container Docker có thể lệch giờ, mà
 * `computeElapsedSeconds` phía app so với `now()`. Cùng lý do với `seedSession`
 * trong db-test-support.
 */
export async function seedSession(admin: SupabaseClient, opts: SeedSessionOpts): Promise<string> {
  const id = randomUUID();
  const { data, error } = await admin
    .from("sessions")
    .insert({
      id,
      user_id: opts.userId,
      status: opts.status ?? "prep",
      mode: opts.mode ?? "online",
      candidate_name: opts.candidateName ?? "Nguyễn Minh Tuấn",
      position: opts.position ?? "Kỹ sư Backend",
      duration_sec: opts.durationSec ?? null,
      share_token: opts.shareToken ?? null,
      share_expires_at: opts.shareToken
        ? (opts.shareExpiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())
        : null,
      quota_debited: opts.quotaDebited ?? false,
      kind: opts.kind ?? "candidate",
      ...(opts.jdText !== undefined ? { jd_text: opts.jdText } : {}),
      ...(opts.capSeconds !== undefined ? { cap_seconds: opts.capSeconds } : {}),
    })
    .select("created_at")
    .single();
  throwOnError(`seed session ${id}`, error);

  const dbNow = new Date(data!.created_at as string).getTime();
  const patch: Record<string, string> = {};
  if (opts.startedAtOffsetMs !== undefined) {
    patch.started_at = new Date(dbNow + opts.startedAtOffsetMs).toISOString();
  } else if (opts.status === "live" || opts.status === "processing" || opts.status === "done") {
    patch.started_at = new Date(dbNow).toISOString();
  }
  if (opts.status === "done" || opts.status === "processing") {
    patch.ended_at = new Date(dbNow).toISOString();
  }
  if (Object.keys(patch).length > 0) {
    const { error: patchError } = await admin.from("sessions").update(patch).eq("id", id);
    throwOnError(`set mốc thời gian session ${id}`, patchError);
  }
  return id;
}

