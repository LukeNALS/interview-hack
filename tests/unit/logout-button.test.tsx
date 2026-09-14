import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const { replaceMock, refreshMock, signOutMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  signOutMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut: signOutMock } }),
}));

import { LogoutButton } from "@/components/common/logout-button";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("test_logout_button_click_signs_out_then_redirects_to_login", async () => {
  // Arrange
  render(<LogoutButton />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "ĐĂNG XUẤT" }));

  // Assert — dọn phiên TRƯỚC rồi mới rời trang, và refresh để server component
  // không phục vụ lại dữ liệu của người vừa thoát khi bấm back.
  await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
  expect(replaceMock).toHaveBeenCalledWith("/login");
  expect(refreshMock).toHaveBeenCalledTimes(1);
});

test("test_logout_button_disabled_while_signing_out_prevents_double_click", async () => {
  // Arrange — signOut treo để giữ trạng thái busy
  signOutMock.mockImplementationOnce(() => new Promise(() => {}));
  render(<LogoutButton />);
  const button = screen.getByRole("button", { name: "ĐĂNG XUẤT" });

  // Act
  fireEvent.click(button);
  fireEvent.click(button);

  // Assert
  await waitFor(() => expect(button).toBeDisabled());
  expect(signOutMock).toHaveBeenCalledTimes(1);
});

test("test_logout_button_signout_failure_still_redirects_to_login", async () => {
  // Arrange — GoTrue lỗi mạng; user vẫn phải thoát được trang
  signOutMock.mockRejectedValueOnce(new Error("fetch failed"));
  render(<LogoutButton />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "ĐĂNG XUẤT" }));

  // Assert
  await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  expect(refreshMock).toHaveBeenCalledTimes(1);
});
