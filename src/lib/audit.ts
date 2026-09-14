import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * writeAuditLog — ghi audit_log cho mutation phá huỷ (AC9), dùng service-role
 * client (RLS chỉ cho `authenticated` SELECT, INSERT phải qua server). Hiện
 * chỉ còn DELETE /api/sessions/:id (Interview Hack chỉ ứng viên — các route
 * question/report từng ghi audit đã bị xoá cùng tính năng người phỏng vấn)
 * gọi trực tiếp writeAuditLog sau khi có before/after cụ thể — withAudit
 * dưới đây là helper tùy chọn cho case đơn giản (before=null, chỉ cần result).
 */
export interface AuditEntry {
  userId: string;
  sessionId?: string | null;
  entity: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("audit_log").insert({
    user_id: entry.userId,
    session_id: entry.sessionId ?? null,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    action: entry.action,
    before: (entry.before as never) ?? null,
    after: (entry.after as never) ?? null,
  });
  if (error) {
    // Không throw — audit log lỗi không nên chặn response chính; chỉ log lại.
    console.error("[audit] ghi audit_log thất bại", { entity: entry.entity, action: entry.action, error: error.message });
  }
}

export function withAudit<Args extends unknown[], R>(
  buildEntry: (args: Args, result: R) => AuditEntry,
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const result = await handler(...args);
    await writeAuditLog(buildEntry(args, result));
    return result;
  };
}
