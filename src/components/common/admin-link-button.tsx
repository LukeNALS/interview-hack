"use client";

import Link from "next/link";
import { useMe } from "@/hooks/use-me";

/**
 * Nút vào trang /admin — CHỈ render khi `GET /api/me` trả `is_admin=true`
 * (server tính từ ADMIN_EMAILS; guard thật vẫn nằm ở layout /admin + từng
 * route /api/admin/* — nút này thuần tiện dụng, ẩn/hiện không phải bảo mật).
 */
export function AdminLinkButton() {
  const { data } = useMe();
  if (!data?.is_admin) return null;
  return (
    <Link
      href="/admin"
      className="inline-flex h-[34px] items-center justify-center rounded-btn border border-control px-3.5 text-[12.5px] font-semibold text-bright hover:border-muted"
    >
      Admin
    </Link>
  );
}
