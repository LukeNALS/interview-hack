import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type AuthedContext } from "@/lib/api-handler";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { computeExpiresAt, DEFAULT_RETENTION_DAYS } from "@/lib/retention";
import { writeAuditLog } from "@/lib/audit";
import { listAllObjectNames, removeObjects, SESSION_STORAGE_BUCKETS } from "@/lib/storage/session-files";
import { checkRateLimit, rateLimitError } from "@/lib/rate-limit";

type RouteContext = { params: Promise<{ id: string }> };

const SESSION_SELECT =
  "id, status, mode, kind, candidate_name, position, created_at, started_at, ended_at, recording_started_at, cap_seconds, ended_reason, translation_lang, last_seq";

/**
 * Cột được phép ghi vào `audit_log.before` khi xoá session — CỐ Ý KHÔNG có PII.
 *
 * VÌ SAO (code review P07, H2): entry audit của session-delete ghi `session_id = null`
 * (bắt buộc, nếu không FK on-delete-cascade tự xoá luôn chính entry vừa ghi). Nhưng
 * chính vì không có FK nào trỏ về `sessions`, entry đó KHÔNG bị `purge_sessions` cascade
 * dọn — nó sống vĩnh viễn. Trước đây `select("*")` nhét cả `candidate_name`, `jd_text`,
 * `cv_file_path`, `quick_eval` vào đó ⇒ phase retention lại tự tạo chỗ giữ PII không bao
 * giờ xoá, phá đúng AC6 của chính nó. Audit chỉ cần đủ để truy "ai xoá cái gì, lúc nào".
 */
const SESSION_AUDIT_SELECT =
  "id, user_id, status, mode, created_at, started_at, ended_at, duration_sec, cap_seconds, ended_reason, quota_debited, quota_refunded";

// GET /api/sessions/:id → chi tiết session (dùng cho SessionScreenGuard + reload giữa buổi, P05).
// Ownership qua RLS: sessions_select_own trả 0 dòng nếu không phải chủ session → 404.
// P07: thêm expires_at computed (retention_days của user) — additive, không breaking FE hiện có.
export const GET = withAuth(async (_req: NextRequest, ctx: RouteContext, auth: AuthedContext) => {
  const { id } = await ctx.params;
  const supabase = await createServerSupabaseClient();

  const { data: session } = await supabase.from("sessions").select(SESSION_SELECT).eq("id", id).maybeSingle();
  if (!session) {
    return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("retention_days")
    .eq("id", auth.userId)
    .maybeSingle();
  const retentionDays = profile?.retention_days ?? DEFAULT_RETENTION_DAYS;
  const expiresAt = computeExpiresAt(session.ended_at ?? session.created_at, retentionDays);

  return NextResponse.json({ session: { ...session, expires_at: expiresAt } });
});

// DELETE /api/sessions/:id → xóa session + file storage liên quan (P07 retention 2 pha:
// storage trước, DB sau — lỗi storage giữ nguyên row để user thử lại, KHÔNG xóa nửa chừng).
// Audit ghi SAU khi xóa row, session_id=null (audit_log.session_id FK on-delete-cascade
// sessions — ghi trước sẽ bị cascade xóa luôn chính entry vừa ghi, xem 0001_init.sql:166).
export const DELETE = withAuth(async (_req: NextRequest, ctx: RouteContext, auth: AuthedContext) => {
  const { id } = await ctx.params;

  // Trần cho endpoint phá huỷ nhất của app: mỗi lần gọi = N storage.list +
  // N storage.remove bằng service-role + 1 row audit_log sống vĩnh viễn [P07 M11].
  // Key theo USER chứ không theo session — theo session thì đổi id là né được trần.
  // Gọi thẳng checkRateLimit (không dùng HOC withRateLimit) vì id nằm trong
  // ctx.params Promise mà buildOptions của HOC là sync. Fail-CLOSED mặc định:
  // 42501 -> 503, không xoá gì.
  const decision = await checkRateLimit({ key: `session-delete:${auth.userId}`, windowSeconds: 3600, limit: 10 });
  if (!decision.allowed) {
    throw rateLimitError(decision.reason);
  }

  const supabase = await createServerSupabaseClient();

  const { data: session } = await supabase
    .from("sessions")
    .select(SESSION_AUDIT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!session) {
    return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
  }

  const serviceClient = createServiceRoleClient();
  const prefix = `${auth.userId}/${id}`;
  // Quét PHÂN TRANG rồi xoá theo lô (src/lib/storage/session-files.ts) — `.list()`
  // không option chỉ trả 100 object đầu, phần dư sẽ mồ côi vĩnh viễn [P07 fix H4].
  try {
    for (const bucket of SESSION_STORAGE_BUCKETS) {
      const names = await listAllObjectNames(serviceClient, bucket, prefix);
      if (names.length > 0) {
        await removeObjects(serviceClient, bucket, names.map((name) => `${prefix}/${name}`));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[session-delete] xoá storage lỗi", { sessionId: id, error: message });
    throw new AppError("Xóa file lưu trữ thất bại — thử lại", 500, "storage_delete_failed");
  }

  const { error: deleteError } = await supabase.from("sessions").delete().eq("id", id);
  if (deleteError) {
    throw new AppError("Xóa session thất bại — thử lại", 500, "internal_error");
  }

  await writeAuditLog({
    userId: auth.userId,
    sessionId: null,
    entity: "session",
    entityId: id,
    action: "delete",
    before: session,
    after: null,
  });

  return NextResponse.json({ deleted: true });
});
