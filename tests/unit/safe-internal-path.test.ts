import { describe, expect, test } from "vitest";
import { safeInternalPath } from "@/lib/safe-internal-path";

describe("safeInternalPath — chặn open-redirect ở auth callback", () => {
  test("test_safe_internal_path_accepts_plain_relative_path", () => {
    // Arrange
    const raw = "/sessions/abc";
    // Act
    const result = safeInternalPath(raw);
    // Assert
    expect(result).toBe("/sessions/abc");
  });

  test("test_safe_internal_path_rejects_protocol_relative_double_slash", () => {
    // Arrange + Act + Assert — "//evil.com" resolve thành host khác
    expect(safeInternalPath("//evil.com/phish")).toBe("/candidate");
  });

  test("test_safe_internal_path_rejects_backslash_variant", () => {
    // Arrange + Act + Assert — browser coi "/\" như "//"
    expect(safeInternalPath("/\\evil.com")).toBe("/candidate");
  });

  test("test_safe_internal_path_rejects_userinfo_at_host_trick", () => {
    // Arrange — "@evil.com" nối vào origin thành https://origin@evil.com (host=evil.com)
    const raw = "@evil.com";
    // Act + Assert — không bắt đầu bằng "/" → fallback
    expect(safeInternalPath(raw)).toBe("/candidate");
  });

  test("test_safe_internal_path_rejects_absolute_url_and_null_returns_fallback", () => {
    // Arrange + Act + Assert
    expect(safeInternalPath("https://evil.com")).toBe("/candidate");
    expect(safeInternalPath(null)).toBe("/candidate");
  });
});
