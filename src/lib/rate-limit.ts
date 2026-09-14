import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";

/**
 * Rate limit thật qua RPC `bump_rate_limit` (fixed window, xem
 * supabase/migrations/0003_functions.sql). Áp cho endpoint LLM-backed
 * (answer-hint), endpoint destructive (DELETE session) và endpoint theo
 * session/user (utterances, soniox-key, sessions create/start/end).
 */

/** SQLSTATE `permission denied for function` — lớp lỗi mà migration 0008 vừa phải vá cho `get_shared_report`. */
const PERMISSION_DENIED_SQLSTATE = "42501";

/**
 * Hành vi khi RPC bị TỪ CHỐI QUYỀN (42501) — tức rate limit thực chất đã TẮT.
 * - `"closed"` (mặc định): coi như vượt hạn, chặn request. Endpoint tốn tiền
 *   (LLM) hoặc phá huỷ (DELETE) phải chọn cái này — mất tính năng còn hơn mất
 *   trần chi phí trong im lặng.
 * - `"open"`: vẫn cho qua. CHỈ dùng khi chặn gây thiệt hại lớn hơn mất rate
 *   limit — hiện đúng 1 chỗ: `/utterances` (chặn = MẤT TRANSCRIPT đang thu).
 */
export type RateLimitFailMode = "open" | "closed";

export interface RateLimitOptions {
  key: string;
  windowSeconds: number;
  limit: number;
  /**
   * Client Supabase gọi RPC `bump_rate_limit`. Mặc định user-scoped
   * (`createServerSupabaseClient`, role `authenticated`) — đúng cho mọi route
   * đã đăng nhập hiện có. Route PUBLIC không có session (vd `/r/[token]`)
   * PHẢI truyền service-role client — RPC chỉ grant cho `authenticated,
   * service_role` (0003_functions.sql:192), KHÔNG nhận `anon` [P06 fix M1].
   */
  client?: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  /** Xem {@link RateLimitFailMode}. Mặc định `"closed"` — an toàn theo mặc định [P07 fix H3]. */
  onPermissionDenied?: RateLimitFailMode;
}

/**
 * Kết quả check — CỐ Ý không phải boolean: gọi được nhưng vượt hạn
 * (`limit_exceeded`, 429) khác hẳn về bản chất với "rate limit không chạy
 * được" (`backend_denied`, 503). Boolean cũ gộp cả hai vào `false`/`true` nên
 * lỗi phân quyền biến mất, chỉ còn 1 dòng `console.error` [P07 fix H3].
 */
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "limit_exceeded" | "backend_denied" };

/**
 * Bump counter và quyết định cho qua hay không.
 *
 * Lỗi HẠ TẦNG (timeout, connection reset, RPC 5xx) → fail-OPEN như cũ: hạ tầng
 * chập chờn không nên làm sập tính năng. Lỗi PHÂN QUYỀN (42501) → fail-CLOSED
 * theo mặc định, vì nó không phải sự cố thoáng qua mà là dấu hiệu grant bị mất
 * (đúng regression mà 0008 phải vá) — fail-open ở đây = rate limit tắt vĩnh
 * viễn trong im lặng cho tới khi có người đọc log [P07 fix H3].
 */
export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitDecision> {
  const supabase = options.client ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("bump_rate_limit", {
    p_key: options.key,
    p_window: `${options.windowSeconds} seconds`,
    p_limit: options.limit,
  });

  if (error) {
    const failMode = options.onPermissionDenied ?? "closed";
    if (error.code === PERMISSION_DENIED_SQLSTATE && failMode === "closed") {
      console.error("[rate-limit] bump_rate_limit bị từ chối quyền (42501) — fail-CLOSED", {
        key: options.key,
        error: error.message,
      });
      return { allowed: false, reason: "backend_denied" };
    }
    console.error("[rate-limit] RPC bump_rate_limit lỗi — fail-open", {
      key: options.key,
      code: error.code,
      error: error.message,
    });
    return { allowed: true };
  }

  return data === true ? { allowed: true } : { allowed: false, reason: "limit_exceeded" };
}

/**
 * AppError tương ứng lý do bị chặn — 429 khi user thật sự vượt hạn, 503 khi
 * rate limit backend không dùng được (lỗi phía ta, không phải lỗi user; client
 * cũng KHÔNG nên retry gấp như với 429).
 */
export function rateLimitError(reason: "limit_exceeded" | "backend_denied", message?: string): AppError {
  if (reason === "backend_denied") {
    return new AppError(
      "Dịch vụ tạm thời không khả dụng — thử lại sau",
      503,
      "rate_limit_unavailable",
    );
  }
  return new AppError(message ?? "Vượt giới hạn số lần gọi trong giờ — thử lại sau", 429, "rate_limit_exceeded");
}

/**
 * Wrap route handler với rate limit. `buildOptions` nhận cùng args với
 * handler để derive key theo user (userId chỉ có trong auth context lúc
 * request tới, không có ở module-load time).
 */
export function withRateLimit<Args extends unknown[], R>(
  buildOptions: (...args: Args) => RateLimitOptions,
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const decision = await checkRateLimit(buildOptions(...args));
    if (!decision.allowed) {
      throw rateLimitError(decision.reason);
    }
    return handler(...args);
  };
}

/**
 * IP client từ header `x-forwarded-for` (hop đầu — client thật, hop sau là
 * proxy trung gian), fallback `x-real-ip`, cuối cùng `"unknown"` (không throw
 * — route public vẫn phải phục vụ được, chỉ dồn chung 1 bucket rate-limit khi
 * thiếu cả 2 header, hiếm khi xảy ra sau proxy Vercel) [P06 fix M1].
 */
export function getClientIp(headersList: Headers): string {
  const forwardedFor = headersList.get("x-forwarded-for");
  const firstHop = forwardedFor?.split(",")[0]?.trim();
  if (firstHop) return firstHop;
  return headersList.get("x-real-ip")?.trim() || "unknown";
}
