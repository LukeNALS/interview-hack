import type { FatalKind } from "@/lib/soniox/classify-realtime-error";
import { ApiError } from "../use-session";

/** Route `soniox-key` trả 503 `rate_limit_unavailable` (fail-closed khi rate-limit không kiểm được) hoặc
 *  502 `soniox_key_failed` — lỗi phía dịch vụ, không phải lỗi mic/quyền của user. */
const KEY_SERVICE_UNAVAILABLE_CODES = new Set(["rate_limit_unavailable", "soniox_key_failed"]);

export const KEY_SERVICE_UNAVAILABLE_MESSAGE = "Dịch vụ thu âm tạm thời không khả dụng — thử lại sau";

export function isKeyServiceUnavailable(err: unknown): boolean {
  return err instanceof ApiError && KEY_SERVICE_UNAVAILABLE_CODES.has(err.code);
}

/** Toast khi 1 stream dừng vì lỗi Soniox không thử lại được. `session_expired` ⇒ null: cap countdown
 *  đang tự kết thúc buổi, toast thêm chỉ trùng lặp. `forbidden` (403 khác) PHẢI có toast — gộp chung với
 *  `session_expired` thì lỗi quyền chết câm. */
export function fatalToastMessage(kind: FatalKind): string | null {
  switch (kind) {
    case "session_expired":
      return null;
    case "forbidden":
      return "Dịch vụ nhận dạng giọng nói từ chối quyền truy cập — hãy tải lại trang, nếu vẫn lỗi hãy báo hỗ trợ";
    case "quota":
      return "Dịch vụ nhận dạng giọng nói từ chối (hết hạn mức) — hãy kết thúc buổi";
    case "fatal":
      return "Lỗi cấu hình thu âm — hãy tải lại trang";
  }
}

/** Toast khi reconnect bỏ cuộc (hết lượt backoff hoặc lỗi route không đáng thử lại). `null` = không toast:
 *  buổi đã hết giờ/kết thúc (cap countdown / endInterview tự lo) — báo "mất kết nối" lúc đó là sai nghĩa. */
export function giveUpToastMessage(label: string, err: unknown): string | null {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === "cap_reached" || code === "invalid_session_status") return null;
  if (isKeyServiceUnavailable(err)) {
    return `${KEY_SERVICE_UNAVAILABLE_MESSAGE} — đã dừng thu âm (${label}), hãy tải lại trang; transcript trước đó vẫn giữ nguyên`;
  }
  if (code === "rate_limit_exceeded") {
    return `Vượt giới hạn xin khoá thu âm trong giờ — đã dừng thu âm (${label}), hãy kết thúc buổi và tải lại trang`;
  }
  return `Mất kết nối thu âm (${label}) — đã dừng, transcript trước đó vẫn giữ nguyên`;
}
