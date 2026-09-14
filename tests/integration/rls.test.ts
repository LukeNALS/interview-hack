import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * RLS negative test — user B KHÔNG được đọc session của user A.
 *
 * Đường chạy: đọc URL/key từ env — mặc định LOCAL Supabase stack
 * (`supabase start`, port đã đổi sang 55321/55322/... trong
 * supabase/config.toml vì máy dev có sẵn 1 stack khác "nal-dx" chiếm port
 * mặc định 54321-54327). Set NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/
 * SUPABASE_SERVICE_ROLE_KEY trỏ tới local stack khi chạy (xem README).
 * Nếu không có local stack, dùng thẳng .env.local (project thật) — cũng
 * chạy đúng, chỉ khác đích kết nối.
 *
 * Tạo 2 user tạm qua admin API (service-role), test xong xoá sạch (afterAll)
 * — không đụng data thật.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRunRemote = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);

const suite = canRunRemote ? describe : describe.skip;

suite("RLS — sessions bảng chính (remote project)", () => {
  const password = "TempPass123!aB";
  const suffix = Date.now();
  const emailA = `rls-test-a-${suffix}@example.com`;
  const emailB = `rls-test-b-${suffix}@example.com`;

  let admin: SupabaseClient;
  let userAId: string;
  let userBId: string;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let sessionIdOwnedByA: string;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userA, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (errA || !userA.user) throw new Error(`tạo user A thất bại: ${errA?.message}`);
    userAId = userA.user.id;

    const { data: userB, error: errB } = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (errB || !userB.user) throw new Error(`tạo user B thất bại: ${errB?.message}`);
    userBId = userB.user.id;

    clientA = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    clientB = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });

    const { error: signInAErr } = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signInAErr) throw new Error(`đăng nhập user A thất bại: ${signInAErr.message}`);
    const { error: signInBErr } = await clientB.auth.signInWithPassword({ email: emailB, password });
    if (signInBErr) throw new Error(`đăng nhập user B thất bại: ${signInBErr.message}`);

    const { data: inserted, error: insertErr } = await clientA
      .from("sessions")
      .insert({ user_id: userAId, candidate_name: "RLS test candidate", mode: "direct" })
      .select("id")
      .single();
    if (insertErr || !inserted) throw new Error(`user A tạo session thất bại: ${insertErr?.message}`);
    sessionIdOwnedByA = inserted.id as string;
  }, 30000);

  afterAll(async () => {
    if (sessionIdOwnedByA) {
      await admin.from("sessions").delete().eq("id", sessionIdOwnedByA);
    }
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  }, 30000);

  test(
    "test_rls_user_b_cannot_select_user_a_session_returns_zero_rows",
    async () => {
      // Arrange — session đã tạo bởi user A ở beforeAll (sessionIdOwnedByA)
      // Act
      const { data, error } = await clientB.from("sessions").select("id").eq("id", sessionIdOwnedByA);
      // Assert — RLS chặn: không lỗi, chỉ 0 rows (default-deny, không match policy)
      expect(error).toBeNull();
      expect(data).toEqual([]);
    },
    30000,
  );

  test(
    "test_rls_user_a_can_select_own_session_returns_one_row",
    async () => {
      // Arrange — session đã tạo bởi chính user A
      // Act
      const { data, error } = await clientA.from("sessions").select("id").eq("id", sessionIdOwnedByA);
      // Assert
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    },
    30000,
  );

  test(
    "test_rls_anon_client_cannot_select_any_session",
    async () => {
      // Arrange — client không đăng nhập (anon key, không có JWT user)
      const anonClient = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
      // Act
      const { data, error } = await anonClient.from("sessions").select("id").eq("id", sessionIdOwnedByA);
      // Assert — anon KHÔNG có GRANT bảng nào (không chỉ thiếu policy) → Postgres từ chối
      // ngay ở tầng privilege (42501 permission denied), chặt hơn "0 rows" của RLS thường.
      expect(error).not.toBeNull();
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    },
    30000,
  );
});
