import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: vi.fn(() => ({})),
}));

import { isAdminEmail, parseAdminEmails } from "@/lib/admin/require-admin";

/** Unit các hàm thuần của guard admin (plan 20260904-1150 F1) — normalize + fail-closed. */
describe("isAdminEmail / parseAdminEmails", () => {
  test("test_is_admin_email_matches_case_insensitive_and_trimmed", () => {
    // Arrange
    const allowlist = " Admin@Example.com , second@example.com ";

    // Act + Assert
    expect(isAdminEmail("admin@example.com", allowlist)).toBe(true);
    expect(isAdminEmail("  ADMIN@EXAMPLE.COM  ", allowlist)).toBe(true);
    expect(isAdminEmail("second@example.com", allowlist)).toBe(true);
  });

  test("test_is_admin_email_rejects_email_outside_allowlist", () => {
    expect(isAdminEmail("other@example.com", "admin@example.com")).toBe(false);
  });

  test("test_is_admin_email_fails_closed_when_env_missing_or_empty", () => {
    // Env thiếu/rỗng → KHÔNG AI là admin (F2 fail-closed).
    expect(isAdminEmail("admin@example.com", undefined)).toBe(false);
    expect(isAdminEmail("admin@example.com", "")).toBe(false);
    expect(isAdminEmail("admin@example.com", " , ,")).toBe(false);
  });

  test("test_is_admin_email_rejects_missing_email", () => {
    expect(isAdminEmail(null, "admin@example.com")).toBe(false);
    expect(isAdminEmail(undefined, "admin@example.com")).toBe(false);
    expect(isAdminEmail("", "admin@example.com")).toBe(false);
  });

  test("test_parse_admin_emails_splits_trims_lowercases_and_drops_empty", () => {
    expect(parseAdminEmails(" A@x.vn , b@Y.vn ,, ")).toEqual(["a@x.vn", "b@y.vn"]);
    expect(parseAdminEmails(undefined)).toEqual([]);
  });
});
