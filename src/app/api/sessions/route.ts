import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type AuthedContext } from "@/lib/api-handler";
import { withRateLimit } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createSessionSchema } from "@/schemas/rest";
import { computeExpiresAt, DEFAULT_RETENTION_DAYS } from "@/lib/retention";

const LIST_SELECT = "id, status, mode, candidate_name, position, created_at, started_at, ended_at";

// GET /api/sessions → danh sách session của user (RLS), mới nhất trước, kèm
// expires_at computed theo retention_days (P07, badge FE wave sau).
export const GET = withAuth(async (_req: NextRequest, _ctx, auth: AuthedContext) => {
  const supabase = await createServerSupabaseClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("retention_days")
    .eq("id", auth.userId)
    .maybeSingle();
  const retentionDays = profile?.retention_days ?? DEFAULT_RETENTION_DAYS;

  const { data, error } = await supabase
    .from("sessions")
    .select(LIST_SELECT)
    .order("created_at", { ascending: false });
  if (error) {
    throw new AppError("Không đọc được danh sách session", 500, "internal_error");
  }

  const sessions = (data ?? []).map((session) => ({
    ...session,
    expires_at: computeExpiresAt(session.ended_at ?? session.created_at, retentionDays),
  }));

  return NextResponse.json({ sessions });
});

// POST /api/sessions → tạo session (trừ quota free lúc /start, không phải lúc này).
// Rate limit 30/giờ/user [P07 M11]: chặn bot/loop client bơm rác `sessions`
// (mỗi row còn kéo theo storage/audit khi dùng tiếp). 30 rộng hơn nhiều
// lần nhịp người thật (tạo rồi vào buổi ~1-2 lần/giờ) nên không cản việc thật.
// Đặt ở HOC = chặn TRƯỚC cả parse body → request rác không chạm DB.
export const POST = withAuth(
  withRateLimit(
    (_req: NextRequest, _ctx: unknown, auth: AuthedContext) => ({
      key: `session-create:${auth.userId}`,
      windowSeconds: 3600,
      limit: 30,
    }),
    async (req: NextRequest, _ctx: unknown, auth: AuthedContext) => {
      const rawBody: unknown = await req.json().catch(() => null);
      const parsed = createSessionSchema.safeParse(rawBody);
      if (!parsed.success) {
        return NextResponse.json(
          errorResponseBody("validation_error", parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }

      const supabase = await createServerSupabaseClient();

      const { data, error } = await supabase
        .from("sessions")
        .insert({
          user_id: auth.userId,
          candidate_name: parsed.data.candidate_name,
          position: parsed.data.position,
          mode: parsed.data.mode,
          jd_text: parsed.data.jd_text,
          wish_text: parsed.data.wish_text,
          kind: parsed.data.kind,
          status: "prep",
        })
        .select("id, status, mode, candidate_name, position, created_at, kind")
        .single();

      if (error || !data) {
        throw new AppError("Tạo session thất bại", 500, "session_create_failed");
      }

      return NextResponse.json({ session: data }, { status: 201 });
    },
  ),
);
