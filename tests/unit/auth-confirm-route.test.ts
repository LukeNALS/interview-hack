import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const { verifyOtpMock } = vi.hoisted(() => ({ verifyOtpMock: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ auth: { verifyOtp: verifyOtpMock } }),
}));

import { GET } from "@/app/auth/confirm/route";

const BASE = "https://interview-hack.example.test";

afterEach(() => {
  vi.clearAllMocks();
});

test("test_auth_confirm_missing_token_hash_redirects_to_login_link_invalid", async () => {
  // Arrange + Act
  const result = await GET(new NextRequest(`${BASE}/auth/confirm?type=recovery`));

  // Assert
  expect(result.headers.get("location")).toBe(`${BASE}/login?error=link_invalid&type=recovery`);
  expect(verifyOtpMock).not.toHaveBeenCalled();
});

test("test_auth_confirm_unsupported_type_redirects_to_login_link_invalid", async () => {
  // Arrange + Act — "invite" không nằm trong danh sách type được nhận
  const result = await GET(new NextRequest(`${BASE}/auth/confirm?token_hash=abc&type=invite`));

  // Assert
  expect(result.headers.get("location")).toBe(`${BASE}/login?error=link_invalid`);
  expect(verifyOtpMock).not.toHaveBeenCalled();
});

test("test_auth_confirm_verify_otp_error_redirects_to_login_link_invalid", async () => {
  // Arrange — token hết hạn/sai
  verifyOtpMock.mockResolvedValue({ error: { message: "Token has expired" } });

  // Act
  const result = await GET(new NextRequest(`${BASE}/auth/confirm?token_hash=expired&type=recovery`));

  // Assert — giữ type=recovery để /login hiện nút gửi lại email đặt lại mật khẩu
  expect(result.headers.get("location")).toBe(`${BASE}/login?error=link_invalid&type=recovery`);
});

test("test_auth_confirm_signup_verify_error_redirects_with_signup_type", async () => {
  // Arrange — link xác nhận đăng ký đã dùng/hết hạn
  verifyOtpMock.mockResolvedValue({ error: { message: "Token has expired" } });

  // Act
  const result = await GET(new NextRequest(`${BASE}/auth/confirm?token_hash=expired&type=signup`));

  // Assert — KHÔNG gắn type=recovery (không được gợi ý đặt lại mật khẩu)
  expect(result.headers.get("location")).toBe(`${BASE}/login?error=link_invalid&type=signup`);
});

test("test_auth_confirm_recovery_success_redirects_to_reset_password", async () => {
  // Arrange
  verifyOtpMock.mockResolvedValue({ error: null });

  // Act
  const result = await GET(new NextRequest(`${BASE}/auth/confirm?token_hash=valid-token&type=recovery`));

  // Assert
  expect(verifyOtpMock).toHaveBeenCalledWith({ type: "recovery", token_hash: "valid-token" });
  expect(result.headers.get("location")).toBe(`${BASE}/reset-password`);
});

test("test_auth_confirm_signup_success_redirects_to_home_fallback", async () => {
  // Arrange
  verifyOtpMock.mockResolvedValue({ error: null });

  // Act — không có `next` -> rơi về fallback của safeInternalPath (/candidate)
  const result = await GET(new NextRequest(`${BASE}/auth/confirm?token_hash=valid-token&type=signup`));

  // Assert
  expect(result.headers.get("location")).toBe(`${BASE}/candidate`);
});

test("test_auth_confirm_signup_success_respects_safe_next_param", async () => {
  // Arrange
  verifyOtpMock.mockResolvedValue({ error: null });

  // Act
  const result = await GET(
    new NextRequest(`${BASE}/auth/confirm?token_hash=valid-token&type=email&next=${encodeURIComponent("/sessions/1")}`),
  );

  // Assert
  expect(result.headers.get("location")).toBe(`${BASE}/sessions/1`);
});
