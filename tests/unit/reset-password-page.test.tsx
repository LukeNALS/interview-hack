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

test("test_reset_password_api_error_shows_message_and_does_not_redirect", async () => {
  // Arrange
  updateUserMock.mockResolvedValue({ data: null, error: { message: "Session hết hạn" } });

  // Act
  fillAndSubmit("longenough1", "longenough1");

  // Assert
  await waitFor(() => expect(screen.getByText("Session hết hạn")).toBeInTheDocument());
  expect(pushMock).not.toHaveBeenCalled();
});
