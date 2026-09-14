import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Regression test cho review P02 CRITICAL-2: debit_free_session phải khóa row
 * sessions (FOR UPDATE) trước khi check quota_debited — 2 request start song
 * song chỉ được trừ quota ĐÚNG 1 lần.
 *
 * Chạy trên đích trong env (local stack hoặc remote — giống rls.test.ts).
 * User + session tạo tạm qua admin API, dọn sạch ở afterAll.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const canRun = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const suite = canRun ? describe : describe.skip;

suite("debit_free_session — chống double-debit (remote project)", () => {
  const password = "TempPass123!aB";
  const email = `quota-race-${Date.now()}@example.com`;

  let admin: SupabaseClient;
  let userId: string;
  let client: SupabaseClient;
  let sessionId: string;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userErr || !created.user) throw new Error(`tạo user thất bại: ${userErr?.message}`);
    userId = created.user.id;

    // Đảm bảo profile tồn tại với 3 buổi free (service-role bypass RLS)
    const { error: profileErr } = await admin
      .from("profiles")
      .upsert({ id: userId, email, free_sessions_left: 3 }, { onConflict: "id" });
    if (profileErr) throw new Error(`upsert profile thất bại: ${profileErr.message}`);

    client = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`đăng nhập thất bại: ${signInErr.message}`);

    const { data: inserted, error: insertErr } = await client
      .from("sessions")
      .insert({ user_id: userId, candidate_name: "Quota race candidate", mode: "direct" })
      .select("id")
      .single();
    if (insertErr || !inserted) throw new Error(`tạo session thất bại: ${insertErr?.message}`);
    sessionId = inserted.id as string;
  }, 30000);

  afterAll(async () => {
    if (sessionId) await admin.from("sessions").delete().eq("id", sessionId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }, 30000);

  test(
    "test_debit_free_session_concurrent_calls_debits_exactly_once",
    async () => {
      // Arrange — profile 3 buổi free, session chưa debit (beforeAll)
      // Act — 2 lời gọi RPC song song trên cùng session
      const [r1, r2] = await Promise.all([
        client.rpc("debit_free_session", { p_session: sessionId }),
        client.rpc("debit_free_session", { p_session: sessionId }),
      ]);
      // Assert — đúng 1 thành công, 1 bị từ chối
      const succeeded = [r1, r2].filter((r) => r.error === null);
      const failed = [r1, r2].filter((r) => r.error !== null);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      const { data: profile } = await admin
        .from("profiles")
        .select("free_sessions_left")
        .eq("id", userId)
        .single();
      expect(profile?.free_sessions_left).toBe(2);
    },
    30000,
  );

  test(
    "test_debit_free_session_second_sequential_call_raises_already_debited",
    async () => {
      // Arrange — session đã debit ở test trước (chạy tuần tự trong suite)
      // Act
      const { error } = await client.rpc("debit_free_session", { p_session: sessionId });
      // Assert
      expect(error).not.toBeNull();
      expect(error?.message).toContain("đã trừ quota");
    },
    30000,
  );
});
