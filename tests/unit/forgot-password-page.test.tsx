import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const { resetMock } = vi.hoisted(() => ({ resetMock: vi.fn() }));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabaseClient: () => ({ auth: { resetPasswordForEmail: resetMock } }),
}));

import ForgotPasswordPage from "@/app/(auth)/forgot-password/page";

const NEUTRAL_MESSAGE = /Nếu email này có tài khoản/;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function submit(email: string) {
  render(<ForgotPasswordPage />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /Gửi đường dẫn đặt lại/ }));
}

test("test_forgot_password_submit_success_shows_neutral_message", async () => {
  // Arrange
  resetMock.mockResolvedValue({ data: {}, error: null });

  // Act
  await submit("real-user@example.com");

  // Assert
  await waitFor(() => expect(screen.getByText(NEUTRAL_MESSAGE)).toBeInTheDocument());
  expect(resetMock).toHaveBeenCalledWith("real-user@example.com");
});

test("test_forgot_password_user_not_found_still_shows_neutral_message", async () => {
  // Arrange — GoTrue vẫn có thể trả lỗi "user not found" tuỳ version; UI KHÔNG được lộ nó
  resetMock.mockResolvedValue({
    data: null,
    error: { name: "AuthApiError", status: 400, code: "user_not_found", message: "User not found" },
  });

  // Act
  await submit("no-such-user@example.com");

  // Assert — vẫn hiện thông báo trung tính như case thành công
  await waitFor(() => expect(screen.getByText(NEUTRAL_MESSAGE)).toBeInTheDocument());
});

test("test_forgot_password_rate_limit_error_shows_retry_message_not_neutral", async () => {
  // Arrange
  resetMock.mockResolvedValue({
    data: null,
    error: { name: "AuthApiError", status: 429, code: "over_email_send_rate_limit", message: "rate limited" },
  });

  // Act
  await submit("real-user@example.com");

  // Assert — lỗi mạng/rate-limit là ngoại lệ DUY NHẤT được lộ, không hiện màn trung tính
  await waitFor(() => expect(screen.getByText("Không gửi được — thử lại sau ít phút.")).toBeInTheDocument());
  expect(screen.queryByText(NEUTRAL_MESSAGE)).not.toBeInTheDocument();
});
