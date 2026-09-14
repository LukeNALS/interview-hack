import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { isAdminEmail } from "@/lib/admin/require-admin";
import { getServerEnv } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Guard server-side cho toàn cây /admin (plan 20260904-1150 F2):
 * chưa đăng nhập → /login; đăng nhập nhưng không thuộc ADMIN_EMAILS
 * (hoặc env rỗng) → 404 — KHÔNG lộ sự tồn tại trang (fail-closed).
 * Guard này chỉ chặn UI — mọi thao tác dữ liệu vẫn phải qua requireAdmin
 * ở TỪNG route /api/admin/* (không tin client).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  if (!isAdminEmail(data.user.email, getServerEnv().ADMIN_EMAILS)) notFound();
  return <>{children}</>;
}
