import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api-handler";
import { requireAdmin } from "@/lib/admin/require-admin";
import { AppError } from "@/lib/errors";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { adminPatchUserSchema } from "@/schemas/rest";

type RouteContext = { params: Promise<{ id: string }> };

// PATCH /api/admin/users/:id — sửa quota/plan (admin phase 01 F4). requireAdmin
// TỪNG request rồi mới service-role; audit log chỉ userId + field đổi (không PII thừa).
export const PATCH = withAuth<{ id: string }>(async (req: NextRequest, ctx: RouteContext) => {
  const adminUser = await requireAdmin();
  const { id } = await ctx.params;

  const rawBody = await req.json().catch(() => null);
  const parsed = adminPatchUserSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ", 400, "validation_error");
  }

  const service = createServiceRoleClient();
  const { data: updated, error } = await service
    .from("profiles")
    .update(parsed.data)
    .eq("id", id)
    .select("id, email, plan, free_sessions_left, created_at")
    .maybeSingle();
  if (error) {
    console.error("[admin] sửa profile lỗi", { userId: id, error: error.message });
    throw new AppError("Không sửa được user", 500, "internal_error");
  }
  if (!updated) {
    throw new AppError("User không tồn tại", 404, "not_found");
  }

  // Audit: ai sửa, sửa user nào, đổi field gì (KHÔNG log giá trị email/PII thừa).
  console.info("[admin] cập nhật user", {
    by: adminUser.userId,
    userId: id,
    fields: Object.keys(parsed.data),
  });

  return NextResponse.json({ user: updated });
});
