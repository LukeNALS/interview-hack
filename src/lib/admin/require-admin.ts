import "server-only";
import { AppError } from "@/lib/errors";
import { getServerEnv } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Guard admin dùng chung cho layout /admin + MỌI route /api/admin/* (plan
 * 20260904-1150 phase 01, F1/F5). Nhận diện qua env ADMIN_EMAILS (server-only,
 * comma-separated) — env thiếu/rỗng = KHÔNG AI là admin (fail-closed).
 */

/** Parse allowlist: tách dấu phẩy, trim, lowercase, bỏ phần tử rỗng. */
export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** So sánh case-insensitive + trim (F1). Thuần để unit test không cần env đầy đủ. */
export function isAdminEmail(email: string | null | undefined, rawAllowlist: string | undefined): boolean {
  if (!email) return false;
  return parseAdminEmails(rawAllowlist).includes(email.trim().toLowerCase());
}

export interface AdminUser {
  userId: string;
  email: string;
}

/**
 * Đọc user hiện tại từ session Supabase và đối chiếu allowlist.
 * null = chưa đăng nhập HOẶC không phải admin — caller tự quyết redirect/404.
 */
export async function getAdminUser(): Promise<AdminUser | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email;
  if (!data.user || !email || !isAdminEmail(email, getServerEnv().ADMIN_EMAILS)) return null;
  return { userId: data.user.id, email };
}

/**
 * Guard cho route /api/admin/*: không phải admin → 404 not_found (không lộ
 * sự tồn tại endpoint — F2). Gọi SAU withAuth (401 cho chưa đăng nhập đã
 * được withAuth xử lý trước).
 */
export async function requireAdmin(): Promise<AdminUser> {
  const admin = await getAdminUser();
  if (!admin) throw new AppError("Không tìm thấy", 404, "not_found");
  return admin;
}
