import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/** Integration test cho GET /api/me — mock Supabase bespoke (bảng profiles). AAA. */

interface ProfileFixture {
  free_sessions_left: number;
  plan: string;
  retention_days: number;
}

let profileFixture: ProfileFixture | null;
let currentEmail = "user@example.com";
let adminEmailsEnv: string | undefined;

// is_admin tính từ ADMIN_EMAILS — mock env để điều khiển per-test (không phụ thuộc .env.local).
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ ADMIN_EMAILS: adminEmailsEnv }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profilesBuilder(): any {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: profileFixture, error: null }),
  };
  return builder;
}

function makeUserClient() {
  const from = vi.fn((table: string) => {
    if (table === "profiles") return profilesBuilder();
    throw new Error(`bảng không mong đợi trong test: ${table}`);
  });
  const auth = {
    getUser: vi.fn(async () => ({
      data: { user: { id: "user-1", email: currentEmail, email_confirmed_at: "2026-01-01T00:00:00Z" } },
      error: null,
    })),
  };
  return { from, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeUserClient()),
}));

function makeRequest(): NextRequest {
  return {} as unknown as NextRequest;
}

function makeCtx() {
  return { params: Promise.resolve({}) };
}

describe("GET /api/me", () => {
  beforeEach(() => {
    vi.resetModules();
    currentEmail = "user@example.com";
    adminEmailsEnv = undefined;
  });

  test("test_me_returns_free_sessions_left_plan_retention_days_shape", async () => {
    // Arrange
    profileFixture = { free_sessions_left: 2, plan: "free", retention_days: 90 };
    const { GET } = await import("@/app/api/me/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body).toEqual({ free_sessions_left: 2, plan: "free", retention_days: 90, is_admin: false });
  });

  test("test_me_profile_missing_falls_back_to_default_values", async () => {
    // Arrange — trường hợp hiếm profile chưa kịp tạo (trigger lỗi tạm thời)
    profileFixture = null;
    const { GET } = await import("@/app/api/me/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body).toEqual({ free_sessions_left: 0, plan: "free", retention_days: 90, is_admin: false });
  });

  test("test_me_returns_is_admin_true_for_email_in_admin_allowlist", async () => {
    // Arrange
    profileFixture = { free_sessions_left: 2, plan: "free", retention_days: 90 };
    currentEmail = "admin@example.com";
    adminEmailsEnv = "Admin@example.com";
    const { GET } = await import("@/app/api/me/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — normalize hoa/thường như guard /admin.
    expect(body.is_admin).toBe(true);
  });

  test("test_me_returns_is_admin_false_when_admin_emails_env_missing", async () => {
    // Arrange — fail-closed đồng bộ với layout /admin.
    profileFixture = { free_sessions_left: 2, plan: "free", retention_days: 90 };
    currentEmail = "admin@example.com";
    adminEmailsEnv = undefined;
    const { GET } = await import("@/app/api/me/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(body.is_admin).toBe(false);
  });
});
