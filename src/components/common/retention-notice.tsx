import { daysUntil } from "@/lib/retention";

/** Ngưỡng cảnh báo trước hạn xóa (plan P07 §Requirements: badge khi còn ≤7 ngày). */
export const RETENTION_WARN_DAYS = 7;

interface RetentionNoticeProps {
  /** `expires_at` ISO từ API session (list/detail). Thiếu → không cảnh báo gì. */
  expiresAt: string | null | undefined;
}

/**
 * Cảnh báo hạn lưu trữ buổi phỏng vấn — chỉ hiện khi còn ≤7 ngày.
 * Quá hạn (daysUntil ≤ 0) hiện câu "đã quá hạn", KHÔNG in số ngày âm.
 * Phép tính ngày dùng lại `daysUntil` (src/lib/retention.ts) — cùng công
 * thức với BE, không tính lại ở FE.
 */
export function RetentionNotice({ expiresAt }: RetentionNoticeProps) {
  if (!expiresAt) return null;

  const days = daysUntil(expiresAt);
  if (days > RETENTION_WARN_DAYS) return null;

  const message =
    days <= 0
      ? "Buổi này đã quá hạn lưu trữ — dữ liệu có thể bị xóa bất cứ lúc nào."
      : `Còn ${days} ngày trước khi buổi này bị xóa tự động theo hạn lưu trữ.`;

  return (
    <div
      role="alert"
      className="rounded-card border border-warning/35 bg-warning/[.08] px-4 py-3 text-[13px] leading-[1.6] text-warning"
    >
      {message}
    </div>
  );
}
