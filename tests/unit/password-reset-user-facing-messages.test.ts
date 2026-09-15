import { expect, test } from "vitest";
import {
  describeUpdatePasswordError,
  SAME_PASSWORD_MESSAGE,
  UPDATE_PASSWORD_GENERIC_ERROR,
  WEAK_PASSWORD_MESSAGE,
} from "@/lib/password-reset-user-facing-messages";

test("test_describe_update_password_error_same_password_code_returns_must_differ_message", () => {
  // Arrange — đúng shape GoTrue trả khi nhập lại mật khẩu đang dùng (422)
  const error = {
    name: "AuthApiError",
    code: "same_password",
    message: "New password should be different from the old password.",
  };

  // Act
  const result = describeUpdatePasswordError(error);

  // Assert
  expect(result).toBe(SAME_PASSWORD_MESSAGE);
  expect(result).toBe("Mật khẩu mới phải khác mật khẩu hiện tại.");
});

test("test_describe_update_password_error_weak_password_code_returns_weak_message", () => {
  // Arrange
  const error = { name: "AuthWeakPasswordError", code: "weak_password", message: "Password should be at least 6 characters." };

  // Act
  const result = describeUpdatePasswordError(error);

  // Assert
  expect(result).toBe(WEAK_PASSWORD_MESSAGE);
});

test("test_describe_update_password_error_weak_password_name_without_code_returns_weak_message", () => {
  // Arrange
  const error = { name: "AuthWeakPasswordError", message: "Password is known to be weak and easy to guess" };

  // Act
  const result = describeUpdatePasswordError(error);

  // Assert
  expect(result).toBe(WEAK_PASSWORD_MESSAGE);
});

test("test_describe_update_password_error_legacy_message_without_code_falls_back_to_message", () => {
  // Arrange — GoTrue cũ không trả `code`, chỉ có message
  const samePassword = { name: "AuthApiError", message: "New password should be different from the old password." };
  const weakPassword = { name: "AuthApiError", message: "Password should contain at least one character of each: abc" };

  // Act
  const sameResult = describeUpdatePasswordError(samePassword);
  const weakResult = describeUpdatePasswordError(weakPassword);

  // Assert
  expect(sameResult).toBe(SAME_PASSWORD_MESSAGE);
  expect(weakResult).toBe(WEAK_PASSWORD_MESSAGE);
});

test("test_describe_update_password_error_other_code_ignores_message_and_returns_generic", () => {
  // Arrange — có code khác → phân loại theo code, KHÔNG so message
  const error = {
    name: "AuthApiError",
    code: "session_not_found",
    message: "New password should be different from the old password.",
  };

  // Act
  const result = describeUpdatePasswordError(error);

  // Assert
  expect(result).toBe(UPDATE_PASSWORD_GENERIC_ERROR);
});

test("test_describe_update_password_error_unknown_error_does_not_leak_raw_message", () => {
  // Arrange
  const error = { name: "AuthRetryableFetchError", message: "Failed to fetch" };

  // Act
  const result = describeUpdatePasswordError(error);

  // Assert
  expect(result).toBe(UPDATE_PASSWORD_GENERIC_ERROR);
  expect(result).not.toContain("Failed to fetch");
});
