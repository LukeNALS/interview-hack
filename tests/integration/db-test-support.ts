import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Hạ tầng chung cho 3 test DB-backed (retention / sweeper / rls-matrix).
 *
 * OPT-IN TƯỜNG MINH: chỉ chạy khi có đủ SUPABASE_TEST_URL + SUPABASE_TEST_ANON_KEY
 * + SUPABASE_TEST_SERVICE_KEY (xem script `pnpm test:db` → LOCAL stack). CỐ TÌNH
 * KHÔNG đọc NEXT_PUBLIC_SUPABASE_* / SUPABASE_SERVICE_ROLE_KEY vì vitest.config.ts
 * nạp .env.local trỏ vào PROJECT THẬT — 3 test này seed session 91 ngày tuổi rồi
 * DELETE nên tuyệt đối không được chạm project thật. Thiếu biến → describe.skip.
 */

const TEST_URL = process.env.SUPABASE_TEST_URL;
const TEST_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const TEST_SERVICE_KEY = process.env.SUPABASE_TEST_SERVICE_KEY;

export const canRunDbTests = Boolean(TEST_URL && TEST_ANON_KEY && TEST_SERVICE_KEY);

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Mật khẩu user tạm — chỉ tồn tại trong local stack, xoá ở afterAll. */
export const TEST_PASSWORD = "TempPass123!aB";

/** Client service-role (bypass RLS) — dùng để seed + gọi RPC retention/sweeper. */
export function createAdminClient(): SupabaseClient {
  return createClient(TEST_URL!, TEST_SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Client anon chưa đăng nhập. `storageKey` riêng cho mỗi instance — jsdom dùng chung
 * localStorage nên nhiều GoTrueClient cùng key sẽ cảnh báo/ghi đè session lẫn nhau.
 */
let clientSeq = 0;
export function createAnonClient(): SupabaseClient {
  clientSeq += 1;
  return createClient(TEST_URL!, TEST_ANON_KEY!, {
    auth: { persistSession: false, storageKey: `db-test-client-${clientSeq}` },
  });
}

/** Tạo user thật qua admin API — trigger `on_auth_user_created` tự tạo profiles row. */
export async function createTestUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`tạo user ${email} thất bại: ${error?.message}`);
  return data.user.id;
}

/** Đăng nhập bằng anon key → client mang JWT của user (RLS áp dụng thật). */
export async function signInAsUser(email: string): Promise<SupabaseClient> {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`đăng nhập ${email} thất bại: ${error.message}`);
  return client;
}

/** Xoá user (cascade: profiles + sessions + toàn bộ bảng con) — dọn sạch sau test. */
export async function deleteTestUsers(admin: SupabaseClient, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
}

export function throwOnError(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

/**
 * Seed 1 session và set các mốc thời gian TƯƠNG ĐỐI theo ĐỒNG HỒ POSTGRES
 * (đọc `created_at` default now() vừa insert) thay vì đồng hồ máy test — container
 * Docker có thể lệch giờ so với host, mà `list_expired_sessions`/`sweep_abandoned_sessions`
 * so sánh với `now()` phía DB.
 *
 * @param offsetsMs ví dụ `{ ended_at: -91 * DAY_MS }` → ended_at = dbNow - 91 ngày.
 */
export async function seedSession(
  admin: SupabaseClient,
  params: {
    id: string;
    userId: string;
    fields?: Record<string, unknown>;
    offsetsMs?: Record<string, number>;
  },
): Promise<Date> {
  const { data, error } = await admin
    .from("sessions")
    .insert({ id: params.id, user_id: params.userId, ...(params.fields ?? {}) })
    .select("created_at")
    .single();
  throwOnError(`seed session ${params.id}`, error);

  const dbNow = new Date(data!.created_at as string);
  const offsets = params.offsetsMs ?? {};
  const patch: Record<string, string> = {};
  for (const [column, deltaMs] of Object.entries(offsets)) {
    patch[column] = new Date(dbNow.getTime() + deltaMs).toISOString();
  }
  if (Object.keys(patch).length > 0) {
    const { error: patchError } = await admin.from("sessions").update(patch).eq("id", params.id);
    throwOnError(`set mốc thời gian cho session ${params.id}`, patchError);
  }
  return dbNow;
}

/** Đếm row của 1 bảng con theo session_id (dùng service-role nên không bị RLS lọc). */
export async function countBySession(
  admin: SupabaseClient,
  table: string,
  sessionId: string,
): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("session_id", sessionId);
  throwOnError(`đếm ${table} của session ${sessionId}`, error);
  return count ?? 0;
}
