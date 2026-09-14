import { execFileSync } from "node:child_process";

/**
 * Đọc credential LOCAL Supabase stack TẠI RUNTIME từ `supabase status -o json`.
 *
 * KHÔNG hardcode key vào bất kỳ file nào (kể cả key demo local): key local khớp
 * rule `jwt` của gitleaks → hardcode làm secret-gate đỏ vĩnh viễn. Cùng lý do +
 * cùng cách làm với `scripts/run-db-tests.mjs`.
 *
 * An toàn: chỉ chấp nhận API URL trỏ localhost — suite E2E TẠO/XOÁ user và
 * session, tuyệt đối không được lỡ trỏ vào project thật.
 */

export interface LocalSupabase {
  url: string;
  anonKey: string;
  serviceKey: string;
}

/** Cổng cố định cho E2E — tách khỏi `next dev` mặc định (3000) để chạy song song với dev thật. */
export const E2E_PORTS = {
  next: 3100,
  sonioxMock: 55391,
  claudeMock: 55392,
} as const;

export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORTS.next}`;

let cached: LocalSupabase | undefined;

export function readLocalSupabase(): LocalSupabase {
  if (cached) return cached;

  let status: Record<string, string>;
  try {
    status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }));
  } catch {
    throw new Error("E2E: không đọc được `supabase status`. Local stack chưa chạy? → `supabase start`");
  }

  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = status;
  if (!API_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error("E2E: `supabase status` thiếu API_URL/ANON_KEY/SERVICE_ROLE_KEY — stack chưa lên đủ.");
  }

  const host = new URL(API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`E2E: API_URL trỏ "${host}", không phải localhost. Suite này ghi/xoá dữ liệu — từ chối chạy.`);
  }

  cached = { url: API_URL, anonKey: ANON_KEY, serviceKey: SERVICE_ROLE_KEY };
  return cached;
}
