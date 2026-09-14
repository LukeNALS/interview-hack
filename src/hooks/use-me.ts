"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/hooks/use-session";

/** Response `GET /api/me` — quota + retention thật của user đang đăng nhập (P07)
 *  + `is_admin` cho nút vào /admin (server tính từ ADMIN_EMAILS, chỉ boolean). */
export interface ApiMe {
  free_sessions_left: number;
  plan: string;
  retention_days: number;
  is_admin: boolean;
}

/**
 * Đọc hồ sơ quota/retention của user — nguồn cho badge "CÒN N BUỔI FREE".
 * `retry: false` như các hook đọc khác (use-session/use-report): lỗi mạng →
 * caller ẩn badge chứ không hiện số sai.
 */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => fetchJson<ApiMe>("/api/me"),
    retry: false,
  });
}
