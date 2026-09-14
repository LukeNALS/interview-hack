import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/**
 * Integration test GET /api/admin/users + PATCH /api/admin/users/[id] (admin
 * phase 01): guard requireAdmin fail-closed 404, service-role sau guard,
 * validation zod chặt. Mock Supabase bespoke theo pattern session-end.test.ts.
 */

let currentUser: { id: string; email: string } | null;
let adminEmailsEnv: string | undefined;
const profilesUpdateSpy = vi.fn();
let profileRows: Array<{ id: string; email: string; plan: string; free_sessions_left: number; created_at: string }>;

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ ADMIN_EMAILS: adminEmailsEnv }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profilesBuilder(): any {
  let updatePayload: Record<string, unknown> | null = null;
  let eqId: string | null = null;
  const builder = {
    select: () => builder,
    order: () => builder,
    limit: async () => ({ data: profileRows, error: null }),
    update: (payload: Record<string, unknown>) => {
      updatePayload = payload;
      profilesUpdateSpy(payload);
      return builder;
    },
    eq: (_col: string, id: string) => {
      eqId = id;
      return builder;
    },
    maybeSingle: async () => {
      const row = profileRows.find((r) => r.id === eqId);
      if (!row) return { data: null, error: null };
      Object.assign(row, updatePayload ?? {});
      return { data: row, error: null };
    },
  };
  return builder;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionsBuilder(): any {
  const builder = {
    select: () => builder,
    eq: async () => ({ data: null, error: null, count: 2 }),
  };
  return builder;
}

function makeUserClient() {
  return {
    from: vi.fn(() => {
      throw new Error("route admin không được đọc dữ liệu qua user client");
    }),
    auth: {
      getUser: vi.fn(async () =>
        currentUser
          ? { data: { user: { id: currentUser.id, email: currentUser.email, email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null }
          : { data: { user: null }, error: null },
      ),
    },
  };
}

function makeServiceClient() {
  return {
    from: vi.fn((table: string) => {
      if (table === "profiles") return profilesBuilder();
      if (table === "sessions") return sessionsBuilder();
      throw new Error(`bảng không mong đợi trong test (service client): ${table}`);
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeUserClient()),
  createServiceRoleClient: vi.fn(() => makeServiceClient()),
}));

function makeRequest(body?: unknown): NextRequest {
  return { json: async () => body ?? {} } as unknown as NextRequest;
}

function makeCtx(id = "user-2") {
  return { params: Promise.resolve({ id }) };
}

describe("routes /api/admin/users", () => {
  beforeEach(() => {
    adminEmailsEnv = "admin@example.com";
    currentUser = { id: "user-1", email: "admin@example.com" };
    profilesUpdateSpy.mockClear();
    profileRows = [
      { id: "user-1", email: "admin@example.com", plan: "free", free_sessions_left: 3, created_at: "2026-09-01T00:00:00Z" },
      { id: "user-2", email: "someone@example.com", plan: "free", free_sessions_left: 0, created_at: "2026-09-02T00:00:00Z" },
    ];
  });

  test("test_admin_users_get_returns_profiles_with_session_count_for_admin", async () => {
    // Arrange
    const { GET } = await import("@/app/api/admin/users/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(2);
    expect(body.users[0]).toMatchObject({ email: "admin@example.com", session_count: 2 });
  });

  test("test_admin_users_get_returns_404_for_non_admin_email", async () => {
    // Arrange — user đăng nhập hợp lệ nhưng ngoài allowlist.
    currentUser = { id: "user-9", email: "mole@example.com" };
    const { GET } = await import("@/app/api/admin/users/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert — 404 not_found, không lộ sự tồn tại endpoint.
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  test("test_admin_users_get_fails_closed_when_admin_emails_env_missing", async () => {
    // Arrange — env rỗng: KHÔNG AI là admin, kể cả email từng hợp lệ.
    adminEmailsEnv = undefined;
    const { GET } = await import("@/app/api/admin/users/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());

    // Assert
    expect(res.status).toBe(404);
  });

  test("test_admin_users_patch_updates_quota_and_returns_user", async () => {
    // Arrange
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    // Act
    const res = await PATCH(makeRequest({ free_sessions_left: 9 }), makeCtx("user-2"));
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(profilesUpdateSpy).toHaveBeenCalledWith({ free_sessions_left: 9 });
    expect(body.user).toMatchObject({ id: "user-2", free_sessions_left: 9 });
  });

  test("test_admin_users_patch_rejects_quota_above_limit_with_validation_error", async () => {
    // Arrange
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    // Act — 1000 vượt trần 999 (F4 zod 0-999).
    const res = await PATCH(makeRequest({ free_sessions_left: 1000 }), makeCtx("user-2"));
    const body = await res.json();

    // Assert
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(profilesUpdateSpy).not.toHaveBeenCalled();
  });

  test("test_admin_users_patch_returns_404_for_non_admin_caller", async () => {
    // Arrange
    currentUser = { id: "user-9", email: "mole@example.com" };
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    // Act
    const res = await PATCH(makeRequest({ free_sessions_left: 9 }), makeCtx("user-2"));

    // Assert — guard chạy TRƯỚC mọi thao tác ghi.
    expect(res.status).toBe(404);
    expect(profilesUpdateSpy).not.toHaveBeenCalled();
  });

  test("test_admin_users_patch_returns_404_for_unknown_user_id", async () => {
    // Arrange
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    // Act
    const res = await PATCH(makeRequest({ free_sessions_left: 5 }), makeCtx("user-ghost"));
    const body = await res.json();

    // Assert
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});
