import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";
import { computeExpiresAt, DEFAULT_RETENTION_DAYS } from "@/lib/retention";

vi.mock("server-only", () => ({}));

/**
 * Integration test cho GET /api/sessions (list) — mock Supabase bespoke
 * (profiles cho retention_days, sessions cho danh sách). AAA. Giá trị mong
 * đợi expires_at tính lại qua computeExpiresAt thật (kiểm route wiring đúng
 * anchor/retention_days, phép cộng ngày đã có unit test riêng ở retention.test.ts).
 */

interface SessionRow {
  id: string;
  status: string;
  mode: string;
  candidate_name: string | null;
  position: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

let profileFixture: { retention_days: number } | null;
let sessionRows: SessionRow[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profilesBuilder(): any {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: profileFixture, error: null }),
  };
  return builder;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionsBuilder(): any {
  const builder = {
    select: () => builder,
    order: () => Promise.resolve({ data: sessionRows, error: null }),
  };
  return builder;
}

function makeUserClient() {
  const from = vi.fn((table: string) => {
    if (table === "profiles") return profilesBuilder();
    if (table === "sessions") return sessionsBuilder();
    throw new Error(`bảng không mong đợi trong test: ${table}`);
  });
  const auth = {
    getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null })),
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

describe("GET /api/sessions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("test_sessions_list_expires_at_uses_ended_at_anchor_with_custom_retention_days", async () => {
    // Arrange — retention_days tùy chỉnh 30, session đã kết thúc (ended_at là anchor)
    profileFixture = { retention_days: 30 };
    sessionRows = [
      {
        id: "session-1",
        status: "done",
        mode: "online",
        candidate_name: "Nguyễn Văn A",
        position: "Backend Dev",
        created_at: "2026-08-01T00:00:00.000Z",
        started_at: "2026-08-01T00:05:00.000Z",
        ended_at: "2026-08-01T01:00:00.000Z",
      },
    ];
    const { GET } = await import("@/app/api/sessions/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].expires_at).toBe(computeExpiresAt("2026-08-01T01:00:00.000Z", 30));
  });

  test("test_sessions_list_expires_at_falls_back_to_created_at_when_ended_at_null", async () => {
    // Arrange — session chưa kết thúc (ended_at null) → anchor = created_at; profile null → dùng default 90.
    profileFixture = null;
    sessionRows = [
      {
        id: "session-2",
        status: "live",
        mode: "direct",
        candidate_name: null,
        position: null,
        created_at: "2026-08-01T00:00:00.000Z",
        started_at: "2026-08-01T00:05:00.000Z",
        ended_at: null,
      },
    ];
    const { GET } = await import("@/app/api/sessions/route");

    // Act
    const res = await GET(makeRequest(), makeCtx());
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.sessions[0].expires_at).toBe(computeExpiresAt("2026-08-01T00:00:00.000Z", DEFAULT_RETENTION_DAYS));
  });
});
