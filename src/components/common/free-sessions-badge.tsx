"use client";

import { useMe } from "@/hooks/use-me";

/**
 * Badge "CÒN N BUỔI FREE" ở header màn prep — đọc `free_sessions_left` thật
 * từ `GET /api/me` (P07, thay mock).
 * Chưa có data (đang tải hoặc lỗi) → ẩn hẳn badge, KHÔNG render "CÒN 0 BUỔI
 * FREE" rồi nhảy số (user đọc nhầm là hết quota).
 */
export function FreeSessionsBadge() {
  const { data } = useMe();
  if (!data) return null;

  return (
    <span className="rounded-pill border border-label/35 bg-label/[.08] px-[13px] py-[5px] text-[11px] tracking-[.08em] text-link">
      CÒN {data.free_sessions_left} BUỔI FREE
    </span>
  );
}
