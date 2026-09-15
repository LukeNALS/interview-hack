import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const { searchParamsState } = vi.hoisted(() => ({ searchParamsState: { query: "" } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParamsState.query),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabaseClient: () => ({ auth: { signInWithPassword: vi.fn() } }),
}));

import LoginPage from "@/app/(auth)/login/page";

const LINK_INVALID_TEXT =
  "Đường dẫn không hợp lệ hoặc đã được dùng. Nếu bạn đã yêu cầu nhiều lần, chỉ đường dẫn trong email mới nhất còn dùng được.";
const RESEND_LABEL = "Gửi lại email đặt lại mật khẩu";

afterEach(() => {
  cleanup();
  searchParamsState.query = "";
});

test("test_login_page_recovery_link_invalid_shows_latest_email_message_and_resend_button", () => {
  // Arrange — /auth/confirm redirect về đây khi link đặt lại mật khẩu sai/đã dùng
  searchParamsState.query = "error=link_invalid&type=recovery";

  // Act
  render(<LoginPage />);

  // Assert
  expect(screen.getByText(LINK_INVALID_TEXT)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: RESEND_LABEL })).toHaveAttribute("href", "/forgot-password");
});

test("test_login_page_signup_link_invalid_shows_message_without_reset_button", () => {
  // Arrange — link xác nhận đăng ký hỏng: không được hướng user sang đặt lại mật khẩu
  searchParamsState.query = "error=link_invalid&type=signup";

  // Act
  render(<LoginPage />);

  // Assert
  expect(screen.getByText(LINK_INVALID_TEXT)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: RESEND_LABEL })).not.toBeInTheDocument();
});

test("test_login_page_without_error_param_hides_link_invalid_message", () => {
  // Arrange — vào /login bình thường
  searchParamsState.query = "";

  // Act
  render(<LoginPage />);

  // Assert
  expect(screen.queryByText(LINK_INVALID_TEXT)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: RESEND_LABEL })).not.toBeInTheDocument();
});
