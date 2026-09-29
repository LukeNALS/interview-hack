/**
 * Phân loại lỗi server Soniox phát qua event `error` SAU khi `connect()` đã resolve
 * (vd key single-use dùng lại ⇒ 401 ~230 ms sau connect, E1; hết `max_session_duration` ⇒ 403).
 *
 * SDK 2.3.0 gặp lỗi server thì `cleanup()` gỡ listener và KHÔNG bắn `disconnected` — không phân
 * loại ở đây thì stream chết câm. Hàm THUẦN: đọc field thô (`statusCode`, `raw.error_type`) thay vì
 * `instanceof` class SDK để test dùng object giả. KHÔNG so text `message` (dễ đổi câu chữ).
 *
 * - `retry`: 401 (key đã dùng/hết hạn), 408/5xx, ConnectionError (không `statusCode`), không rõ ⇒
 *   reconnect với cặp key MỚI.
 * - `session_expired`: 403 do `max_session_duration` hết (cap phiên) — E4, server cắt cứng.
 * - `forbidden`: 403 KHÁC (thiếu quyền). Không có `raw` ⇒ vẫn `forbidden`: mặc định an toàn là hiện
 *   lỗi cho user chứ không nuốt như hết cap.
 * - `quota`: 402/429. `fatal`: 400 (lỗi cấu hình phía ta).
 */
export type SonioxErrorKind = "retry" | "session_expired" | "forbidden" | "quota" | "fatal";
export type FatalKind = Exclude<SonioxErrorKind, "retry">;

const SESSION_EXPIRED_ERROR_TYPE = "temp_api_key_session_expired";

export function classifySonioxRealtimeError(err: unknown): SonioxErrorKind {
  const { statusCode, raw } = (err ?? {}) as { statusCode?: unknown; raw?: { error_type?: unknown } | null };
  switch (statusCode) {
    case 401:
      return "retry";
    case 403:
      return raw?.error_type === SESSION_EXPIRED_ERROR_TYPE ? "session_expired" : "forbidden";
    case 402:
    case 429:
      return "quota";
    case 400:
      return "fatal";
    default:
      return "retry";
  }
}
