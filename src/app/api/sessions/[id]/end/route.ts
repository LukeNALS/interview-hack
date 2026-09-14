import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type AuthedContext } from "@/lib/api-handler";
import { withRateLimit } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { computeElapsedSeconds } from "@/lib/cap-clock";
import { endSessionSchema } from "@/schemas/rest";

export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

const REFUND_THRESHOLD_SEC = 300;

interface SessionEndRow {
  id: string;
  status: "prep" | "live" | "processing" | "done" | "failed";
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  ended_reason: "user" | "cap" | "error" | null;
}

// POST /api/sessions/:id/end → idempotent: chấp nhận status='live' HOẶC
// (status='processing' AND ended_reason='cap' — session bị cap ở P05 utterances
// route nhưng chưa qua /end). Chốt ended_at/duration_sec/status='done' NGAY —
// Interview Hack (chỉ ứng viên) không còn report job nào chạy sau khi kết thúc.
// Hoàn quota <5' (RPC tự guard double-refund). Gọi lại khi đã ended → 200 trạng
// thái hiện tại, KHÔNG side-effect kép.
//
// Rate limit 60/giờ/user [P07 M11] — CỐ Ý rộng: đây là đường thoát của buổi
// phỏng vấn thật (chốt ended_at, hoàn quota <5'). Chặn nhầm ở đây = buổi kẹt
// 'live', quota không hoàn — thiệt hại lớn hơn nhiều so với chi phí vài request
// thừa. Client gọi theo hành động người dùng/cap (không có vòng poll — xem
// use-live-session.ts) nên 60 lần/giờ đã là gấp hàng chục lần nhịp thật, chỉ
// chạm khi có loop hỏng.
export const POST = withAuth(
  withRateLimit(
    (_req: NextRequest, _ctx: RouteContext, auth: AuthedContext) => ({
      key: `session-end:${auth.userId}`,
      // fail-OPEN khi 42501 [P07 fix H-1]: chặn /end = buổi kẹt ở 'live', user
      // không kết thúc được, phải chờ sweeper auto-end sau cap+600s. Mất trần
      // rate limit nhẹ hơn nhiều so với treo buổi phỏng vấn thật.
      onPermissionDenied: "open",
      windowSeconds: 3600,
      limit: 60,
    }),
    async (req: NextRequest, ctx: RouteContext) => {
      const { id } = await ctx.params;
      // Body optional (caller cũ POST không body) — thiếu/không phải JSON coi như {}.
      const rawBody = await req.json().catch(() => null);
      const parsedBody = endSessionSchema.safeParse(rawBody ?? {});
      if (!parsedBody.success) {
        throw new AppError(parsedBody.error.issues[0]?.message ?? "Dữ liệu không hợp lệ", 400, "validation_error");
      }
      const supabase = await createServerSupabaseClient();

      const { data: session } = await supabase
        .from("sessions")
        .select("id, status, started_at, ended_at, duration_sec, ended_reason")
        .eq("id", id)
        .maybeSingle<SessionEndRow>();
      if (!session) {
        return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
      }

      const alreadyEnded = session.ended_at !== null && (session.status === "processing" || session.status === "done");
      if (alreadyEnded) {
        return NextResponse.json({
          ended_at: session.ended_at,
          duration_sec: session.duration_sec,
          status: session.status,
          ended_reason: session.ended_reason,
        });
      }

      const isFreshEnd = session.status === "live";
      const isCapPendingEnd =
        session.status === "processing" && session.ended_reason === "cap" && session.ended_at === null;
      if (!isFreshEnd && !isCapPendingEnd) {
        throw new AppError("Session không ở trạng thái có thể kết thúc", 409, "invalid_session_status");
      }

      // Interview Hack (chỉ ứng viên) không còn report job — kết thúc buổi luôn chốt
      // thẳng status='done', không có trạng thái 'processing' chờ report nữa.
      const nowIso = new Date().toISOString();
      const durationSec = Math.max(0, computeElapsedSeconds(session.started_at, new Date(nowIso)) ?? 0);
      const endedReason = session.ended_reason === "cap" ? "cap" : "user";

      const { error: updateError } = await supabase
        .from("sessions")
        .update({ ended_at: nowIso, duration_sec: durationSec, status: "done", ended_reason: endedReason })
        .eq("id", id);
      if (updateError) {
        console.error("[end] cập nhật session lỗi", { sessionId: id, error: updateError.message });
        throw new AppError("Không thể kết thúc buổi — thử lại", 500, "internal_error");
      }

      if (durationSec < REFUND_THRESHOLD_SEC) {
        const { error: refundError } = await supabase.rpc("refund_free_session", { p_session: id });
        if (refundError && !refundError.message.includes("không đủ điều kiện hoàn buổi free")) {
          // Non-fatal — refund lỗi không nên chặn response trả về; log để soát sau.
          console.error("[end] refund_free_session lỗi", { sessionId: id, error: refundError.message });
        }
      }

      return NextResponse.json({
        ended_at: nowIso,
        duration_sec: durationSec,
        status: "done",
        ended_reason: endedReason,
      });
    },
  ),
);
