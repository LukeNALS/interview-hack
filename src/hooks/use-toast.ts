"use client";

import { useSessionStore } from "@/stores/session-store";

/**
 * Toast pill giữa đáy màn — mọi hành động ghi nhận (lưu, xóa, thêm, copy link…).
 * Message nằm trong session store để component nào cũng bắn được; tự ẩn 2.4s.
 */
export function useToast(): {
  toast: string;
  showToast: (message: string) => void;
} {
  const toast = useSessionStore((s) => s.toast);
  const showToast = useSessionStore((s) => s.showToast);
  return { toast, showToast };
}
