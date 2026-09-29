import type { PairKeys } from "@/lib/soniox/connection";
import { ApiError } from "../use-session";

/** Mã lỗi route soniox-key KHÔNG đáng thử lại — xin key mới cũng vô ích (buổi đã hết/không hợp lệ, user
 *  vượt hạn). `rate_limit_unavailable` (503, route fail-closed khi rate-limit lỗi) và `soniox_key_failed`
 *  (502) là lỗi thoáng qua ⇒ vẫn đi backoff. */
const NON_RETRYABLE_KEY_ERROR_CODES = new Set([
  "cap_reached",
  "invalid_session_status",
  "not_found",
  "email_not_confirmed",
  "rate_limit_exceeded",
]);

/** M3 fix: flush hàng đợi ingest TRƯỚC khi điều hướng khỏi màn live (mọi đường kết thúc buổi:
 *  thủ công/cap auto-stop/409 session_ended) — timeout ngắn (default 3s) để không treo
 *  navigate vô thời hạn nếu mạng đơ đúng lúc flush cuối. */
export async function flushIngestQueueBeforeEnd(
  queue: { flushNow: () => Promise<void> } | null,
  timeoutMs = 3000,
): Promise<void> {
  if (!queue) return;
  await Promise.race([queue.flushNow(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

export interface ReconnectWithBackoffDeps {
  /** Cặp key MỚI mỗi lượt — key single-use, key đã dùng ⇒ 401 sau connect. */
  getKeys: () => Promise<PairKeys>;
  reconnect: (keys: PairKeys) => Promise<void>;
  /** Hết lượt retry HOẶC lỗi không đáng thử lại — kèm lỗi cuối để caller chọn thông điệp; caller dừng
   *  capture luồng đó, giữ banner degraded. */
  onGiveUp: (err: unknown) => void;
  /** Kiểm ĐẦU mỗi lượt: `false` (controller đã stop/fatal hoặc pipeline đã dispose) ⇒ dừng im lặng, KHÔNG xin
   *  key (mint thật), KHÔNG `onGiveUp` (toast giả lên màn kế). Bỏ trống = luôn tiếp tục. */
  shouldContinue?: () => boolean;
}

export interface ReconnectWithBackoffOptions {
  /** Default 3 lần (C1 spec) — không loop vô hạn. */
  maxAttempts?: number;
  /** Backoff trước lần thử thứ N (1-indexed). Default exponential 1s/2s/4s. */
  backoffMs?: (attempt: number) => number;
  delayFn?: (ms: number) => Promise<void>;
}

/** C1 fix: xin cặp key mới rồi gọi `controller.reconnect()` với retry backoff giới hạn — thành công thì
 *  dừng ngay (banner restored đã tự bắn TRONG `SonioxStreamController.reconnect()`); hết `maxAttempts`
 *  hoặc gặp lỗi route không đáng thử lại thì gọi `onGiveUp(err)` đúng 1 lần, KHÔNG loop vô hạn. */
export async function reconnectWithBackoff(
  deps: ReconnectWithBackoffDeps,
  opts: ReconnectWithBackoffOptions = {},
): Promise<void> {
  const {
    maxAttempts = 3,
    backoffMs = (attempt) => 1000 * 2 ** (attempt - 1),
    delayFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.shouldContinue && !deps.shouldContinue()) return;
    try {
      await deps.reconnect(await deps.getKeys());
      return;
    } catch (err) {
      lastError = err;
      if (err instanceof ApiError && NON_RETRYABLE_KEY_ERROR_CODES.has(err.code)) return deps.onGiveUp(err);
      // xin key/mở lại hỏng (mạng, 503, 401 sau connect) -> thử lại theo backoff bên dưới
    }
    if (attempt < maxAttempts) await delayFn(backoffMs(attempt));
  }
  deps.onGiveUp(lastError);
}
