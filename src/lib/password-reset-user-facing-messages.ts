/**
 * Thông báo tiếng Việt cho luồng quên / đặt lại mật khẩu — dùng chung cho /login,
 * /forgot-password, /reset-password để câu chữ đồng nhất và unit test được.
 *
 * Bối cảnh (auth_logs prod 2026-09-15): mỗi lần yêu cầu đặt lại, GoTrue huỷ mọi link
 * cũ; Gmail gộp các mail cùng tiêu đề vào 1 thread nên user dễ bấm nhầm mail cũ.
 * Nhập lại đúng mật khẩu đang dùng thì GoTrue trả 422 `same_password` bằng tiếng Anh.
 */

export const LINK_INVALID_MESSAGE =
  "Đường dẫn không hợp lệ hoặc đã được dùng. Nếu bạn đã yêu cầu nhiều lần, chỉ đường dẫn trong email mới nhất còn dùng được.";

export const RESEND_RESET_EMAIL_LABEL = "Gửi lại email đặt lại mật khẩu";

export const OPEN_LATEST_EMAIL_HINT = "Hãy mở email mới nhất — các đường dẫn cũ sẽ không còn dùng được.";

export const SAME_PASSWORD_MESSAGE = "Mật khẩu mới phải khác mật khẩu hiện tại.";

export const WEAK_PASSWORD_MESSAGE =
  "Mật khẩu mới chưa đủ mạnh — hãy chọn mật khẩu dài hơn, có cả chữ và số, khó đoán hơn.";

export const UPDATE_PASSWORD_GENERIC_ERROR =
  "Không đổi được mật khẩu. Hãy thử lại — nếu vẫn lỗi, hãy yêu cầu email đặt lại mật khẩu mới.";

/** Tập con field của `AuthError` (supabase-js) cần để phân loại lỗi. */
export interface AuthErrorLike {
  code?: string;
  name?: string;
  message?: string;
}

// Chỉ dùng khi GoTrue KHÔNG trả `code` (bản cũ) — câu chữ tiếng Anh có thể đổi theo version.
const LEGACY_SAME_PASSWORD_PATTERN = /different from the old password/i;
const LEGACY_WEAK_PASSWORD_PATTERN = /password should (be at least|contain)|known to be weak/i;

/**
 * Dịch lỗi `auth.updateUser({ password })` sang tiếng Việt. Ưu tiên `error.code` (ổn định
 * giữa các version GoTrue); có code lạ thì trả thông báo chung — KHÔNG lộ message gốc.
 */
export function describeUpdatePasswordError(error: AuthErrorLike): string {
  if (error.code === "same_password") return SAME_PASSWORD_MESSAGE;
  if (error.code === "weak_password" || error.name === "AuthWeakPasswordError") return WEAK_PASSWORD_MESSAGE;

  if (!error.code) {
    const message = error.message ?? "";
    if (LEGACY_SAME_PASSWORD_PATTERN.test(message)) return SAME_PASSWORD_MESSAGE;
    if (LEGACY_WEAK_PASSWORD_PATTERN.test(message)) return WEAK_PASSWORD_MESSAGE;
  }

  return UPDATE_PASSWORD_GENERIC_ERROR;
}
