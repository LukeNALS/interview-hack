import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type AuthedContext } from "@/lib/api-handler";
import { withRateLimit } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { startSessionSchema } from "@/schemas/rest";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/sessions/:id/start → status='live', trừ quota — TẤT CẢ trong 1 RPC
// `start_session` (0018), atomic thật (không còn 2 bước debit+update tách rời như
// trước). RPC tự xử lý idempotent (đã live+debited → trả nguyên) và session cũ dở
// dang từ code pre-0018 (status='prep' nhưng đã debited) → hoàn tất KHÔNG debit lại.
//
// BUG #4: body {mode} (optional) chốt chế độ user chọn ở màn setup — truyền qua RPC
// cùng lượt chuyển status='live': mode chỉ có ý nghĩa đúng tại thời điểm vào buổi,
// gộp 1 request tránh cửa sổ "đã live nhưng mode còn cũ" mà màn live đọc trúng.
//
// Rate limit 60/giờ/user [P07 M11] đặt ở HOC — tức TRƯỚC `start_session`.
// Thứ tự này là bắt buộc: chặn SAU khi RPC đã trừ quota = user mất 1 buổi free
// mà buổi không hề bắt đầu (RPC guard double-debit nên không tự hoàn). Ngưỡng
// để rộng vì start là cửa vào buổi thật — quota free mới là trần chống lạm
// dụng, rate limit ở đây chỉ chặn loop client hỏng bơm RPC.
export const POST = withAuth(
  withRateLimit(
    (_req: NextRequest, _ctx: RouteContext, auth: AuthedContext) => ({
      key: `session-start:${auth.userId}`,
      // fail-OPEN khi 42501 [P07 fix H-1]: /start là BƯỚC ĐẦU của đường thu âm
      // (start → soniox-key → utterances → end). Fail-closed ở đây thì fix của
      // /soniox-key vô dụng vì không ai tới được đó. Trần chi phí thật của /start
      // là quota free (`debit_free_session`), KHÔNG phải rate limit này — rate
      // limit chỉ chặn loop client hỏng, mất nó không mở cửa cho lạm dụng tiền.
      onPermissionDenied: "open",
      windowSeconds: 3600,
      limit: 60,
    }),
    async (req: NextRequest, ctx: RouteContext) => {
      const { id } = await ctx.params;

      // Body rỗng vẫn hợp lệ (caller cũ POST không body) — thiếu `mode` thì giữ nguyên mode cũ.
      const rawBody: unknown = await req.json().catch(() => undefined);
      const parsed = startSessionSchema.safeParse(rawBody ?? {});
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ", 400, "validation_error");
      }
      const { mode } = parsed.data;

      const supabase = await createServerSupabaseClient();

      const { data: session } = await supabase.from("sessions").select("id, status").eq("id", id).maybeSingle();
      if (!session) {
        return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
      }
      if (session.status !== "prep") {
        throw new AppError("Session không ở trạng thái có thể bắt đầu buổi", 409, "invalid_session_status");
      }

      // `start_session` trả 1 row `sessions` (composite, không phải setof) — đọc
      // thẳng field từ `data`, KHÔNG chain `.select()/.single()` (dành cho setof).
      const { data: updated, error: startError } = await supabase.rpc("start_session", {
        p_session: id,
        ...(mode ? { p_mode: mode } : {}),
      });

      if (startError) {
        if (startError.message.includes("hết buổi free")) {
          throw new AppError("Đã dùng hết số buổi miễn phí", 409, "no_free_sessions");
        }
        if (startError.message.includes("không ở trạng thái có thể bắt đầu buổi")) {
          throw new AppError("Session không ở trạng thái có thể bắt đầu buổi", 409, "invalid_session_status");
        }
        console.error("[start] start_session lỗi", { sessionId: id, error: startError.message });
        throw new AppError("Không thể bắt đầu buổi — thử lại", 500, "internal_error");
      }
      if (!updated) {
        console.error("[start] start_session không trả dữ liệu", { sessionId: id });
        throw new AppError("Không thể bắt đầu buổi — thử lại", 500, "internal_error");
      }

      // Trả `mode` đã ghi để client seed lại cache session (màn live đọc mode từ server).
      return NextResponse.json({
        started_at: updated.started_at,
        cap_seconds: updated.cap_seconds,
        mode: updated.mode,
      });
    },
  ),
);
