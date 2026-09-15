import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const { pushMock, refreshMock, updateUserMock, showToastMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  updateUserMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabaseClient: () => ({ auth: { updateUser: updateUserMock } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: "", showToast: showToastMock }),
}));

import ResetPasswordPage from "@/app/(auth)/reset-password/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fillAndSubmit(password: string, confirmPassword: string) {
  render(<ResetPasswordPage />);
  fireEvent.change(screen.getByLabelText(/Mật khẩu mới \(tối thiểu/), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Nhập lại mật khẩu mới"), { target: { value: confirmPassword } });
  fireEvent.click(screen.getByRole("button", { name: /Đổi mật khẩu/ }));
}

test("test_reset_password_rejects_short_password_without_calling_api", async () => {
  // Arrange + Act
  fillAndSubmit("short1", "short1");

  // Assert
  await waitFor(() => expect(screen.getByText("Mật khẩu phải có ít nhất 8 ký tự.")).toBeInTheDocument());
  expect(updateUserMock).not.toHaveBeenCalled();
});

test("test_reset_password_rejects_mismatched_confirmation_without_calling_api", async () => {
  // Arrange + Act
  fillAndSubmit("longenough1", "longenough2");

  // Assert
  await waitFor(() => expect(screen.getByText("Mật khẩu nhập lại không khớp.")).toBeInTheDocument());
  expect(updateUserMock).not.toHaveBeenCalled();
});

test("test_reset_password_success_shows_toast_and_redirects_home", async () => {
  // Arrange
  updateUserMock.mockResolvedValue({ data: {}, error: null });

  // Act
  fillAndSubmit("longenough1", "longenough1");

  // Assert
  await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ password: "longenough1" }));
  expect(showToastMock).toHaveBeenCalledWith("Đã đổi mật khẩu");
  expect(pushMock).toHaveBeenCalledWith("/candidate");
  expect(refreshMock).toHaveBeenCalledTimes(1);
});

test("test_reset_password_unknown_api_error_shows_generic_vietnamese_message_and_does_not_redirect", async () => {
  // Arrange
  updateUserMock.mockResolvedValue({
    data: null,
    error: { name: "AuthSessionMissingError", message: "Auth session missing!" },
  });

  // Act
  fillAndSubmit("longenough1", "longenough1");

  // Assert — không lộ message tiếng Anh gốc
  await waitFor(() =>
    expect(
      screen.getByText("Không đổi được mật khẩu. Hãy thử lại — nếu vẫn lỗi, hãy yêu cầu email đặt lại mật khẩu mới."),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText("Auth session missing!")).not.toBeInTheDocument();
  expect(pushMock).not.toHaveBeenCalled();
});

test("test_reset_password_same_as_current_password_shows_must_differ_message", async () => {
  // Arrange — GoTrue trả 422 same_password khi nhập lại mật khẩu đang dùng
  updateUserMock.mockResolvedValue({
    data: null,
    error: {
      name: "AuthApiError",
      status: 422,
      code: "same_password",
      message: "New password should be different from the old password.",
    },
  });

  // Act
  fillAndSubmit("longenough1", "longenough1");

  // Assert
  await waitFor(() => expect(screen.getByText("Mật khẩu mới phải khác mật khẩu hiện tại.")).toBeInTheDocument());
  expect(showToastMock).not.toHaveBeenCalled();
  expect(pushMock).not.toHaveBeenCalled();
});

test("test_reset_password_weak_password_error_shows_weak_password_message", async () => {
  // Arrange
  updateUserMock.mockResolvedValue({
    data: null,
    error: { name: "AuthWeakPasswordError", status: 422, code: "weak_password", message: "Password is too weak" },
  });

  // Act
  fillAndSubmit("longenough1", "longenough1");

  // Assert
  await waitFor(() =>
    expect(
      screen.getByText("Mật khẩu mới chưa đủ mạnh — hãy chọn mật khẩu dài hơn, có cả chữ và số, khó đoán hơn."),
    ).toBeInTheDocument(),
  );
  expect(pushMock).not.toHaveBeenCalled();
});
