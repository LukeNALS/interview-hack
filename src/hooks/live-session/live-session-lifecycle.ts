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
  /** Key hiện có (KHÔNG ép renew toàn cục — 1 stream rớt sóng không có nghĩa key hết hạn). */
  getApiKey: () => string | null;
  reconnect: (apiKey: string) => Promise<void>;
  /** Hết lượt retry — caller dừng capture luồng đó, giữ banner degraded. */
  onGiveUp: () => void;
}

export interface ReconnectWithBackoffOptions {
  /** Default 3 lần (C1 spec) — không loop vô hạn. */
  maxAttempts?: number;
  /** Backoff trước lần thử thứ N (1-indexed). Default exponential 1s/2s/4s. */
  backoffMs?: (attempt: number) => number;
  delayFn?: (ms: number) => Promise<void>;
}

/** C1 fix: gọi `controller.reconnect()` với retry backoff giới hạn — thành công thì dừng ngay
 *  (banner restored đã tự bắn TRONG `SonioxStreamController.reconnect()`); hết `maxAttempts`
 *  thì gọi `onGiveUp()` đúng 1 lần, KHÔNG loop vô hạn. */
export async function reconnectWithBackoff(
  deps: ReconnectWithBackoffDeps,
  opts: ReconnectWithBackoffOptions = {},
): Promise<void> {
  const {
    maxAttempts = 3,
    backoffMs = (attempt) => 1000 * 2 ** (attempt - 1),
    delayFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = opts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const apiKey = deps.getApiKey();
    if (apiKey) {
      try {
        await deps.reconnect(apiKey);
        return;
      } catch {
        // rớt tiếp trong lúc mở lại -> thử lại theo backoff bên dưới
      }
    }
    if (attempt < maxAttempts) await delayFn(backoffMs(attempt));
  }
  deps.onGiveUp();
}
