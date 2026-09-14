import { NextResponse, type NextRequest } from "next/server";
import { withAuth, type AuthedContext } from "@/lib/api-handler";
import { isAdminEmail } from "@/lib/admin/require-admin";
import { getServerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEFAULT_RETENTION_DAYS } from "@/lib/retention";

// GET /api/me → {free_sessions_left, plan, retention_days, is_admin} — data cho badge FE
// (quota/retention, P07) + nút vào /admin (chỉ boolean, KHÔNG lộ allowlist ADMIN_EMAILS).
export const GET = withAuth(async (_req: NextRequest, _ctx, auth: AuthedContext) => {
  const supabase = await createServerSupabaseClient();

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("free_sessions_left, plan, retention_days")
    .eq("id", auth.userId)
    .maybeSingle();
  if (error) {
    throw new AppError("Không đọc được hồ sơ người dùng", 500, "internal_error");
  }

  // Email lấy từ session auth (withAuth đã xác thực) — cùng nguồn với guard /admin.
  const { data: userData } = await supabase.auth.getUser();

  return NextResponse.json({
    free_sessions_left: profile?.free_sessions_left ?? 0,
    plan: profile?.plan ?? "free",
    retention_days: profile?.retention_days ?? DEFAULT_RETENTION_DAYS,
    is_admin: isAdminEmail(userData.user?.email, getServerEnv().ADMIN_EMAILS),
  });
});
