/**
 * Helper thuần túy tính hạn xóa session theo retention_days của user.
 * anchor = ended_at ?? created_at (session chưa kết thúc thì tính từ lúc tạo).
 * Không phụ thuộc DB/IO — unit-testable, dùng chung cho GET list + GET detail (P07).
 */

/** Retention mặc định khi profile không có/không đọc được retention_days (khớp default cột DB). */
export const DEFAULT_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** anchorIso + retentionDays (ngày) → ISO string thời điểm hết hạn. */
export function computeExpiresAt(anchorIso: string, retentionDays: number): string {
  const anchorMs = new Date(anchorIso).getTime();
  return new Date(anchorMs + retentionDays * MS_PER_DAY).toISOString();
}

/** Số ngày còn lại tới hạn (âm nếu đã quá hạn) — làm tròn lên, dùng cho badge FE. */
export function daysUntil(expiresAtIso: string): number {
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  return Math.ceil(diffMs / MS_PER_DAY);
}
