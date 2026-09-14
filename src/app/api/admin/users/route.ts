import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-handler";
import { requireAdmin } from "@/lib/admin/require-admin";
import { AppError } from "@/lib/errors";
import { createServiceRoleClient } from "@/lib/supabase/server";

/** Phân trang đơn giản phase 01 (F3) — đủ cho quy mô hiện tại, chưa cần cursor. */
const PAGE_LIMIT = 100;

interface AdminProfileRow {
  id: string;
  email: string;
  plan: string;
  free_sessions_left: number;
  created_at: string;
}

// GET /api/admin/users — bảng user cho trang admin (email, plan, quota, ngày tạo,
// số buổi đã tạo). Service-role SAU requireAdmin — KHÔNG nới RLS/grant cho client
// (gotcha Hub: grant UPDATE mức bảng từng hở cột quota).
export const GET = withAuth(async () => {
  await requireAdmin();
  const service = createServiceRoleClient();

  const { data: profiles, error } = await service
    .from("profiles")
    .select("id, email, plan, free_sessions_left, created_at")
    .order("created_at", { ascending: false })
    .limit(PAGE_LIMIT);
  if (error) {
    console.error("[admin] đọc profiles lỗi", { error: error.message });
    throw new AppError("Không đọc được danh sách user", 500, "internal_error");
  }

  const rows = (profiles ?? []) as AdminProfileRow[];
  // Đếm buổi bằng head-count TỪNG user (PostgREST aggregate bị tắt — PGRST123;
  // select user_id gộp thì dính cap max_rows=1000 → đếm thiếu âm thầm).
  // Tối đa PAGE_LIMIT request song song nội bộ, chấp nhận cho trang admin.
  const counts = await Promise.all(
    rows.map(async (p) => {
      const { count } = await service
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", p.id);
      return count ?? 0;
    }),
  );

  return NextResponse.json({
    users: rows.map((p, i) => ({ ...p, session_count: counts[i] })),
  });
});
