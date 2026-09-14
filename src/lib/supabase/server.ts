import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/types/db";
import { getPublicEnv, getServerEnv } from "@/lib/env";

/**
 * Client server-side theo session user (RLS áp dụng bình thường qua anon key
 * + cookie). Dùng trong route handler/server component cho mọi query thuộc
 * quyền user hiện tại.
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getPublicEnv();

  return createServerClient<Database>(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // gọi từ Server Component (không set được cookie) — middleware đã lo refresh session.
        }
      },
    },
  });
}

/**
 * Client service-role — BYPASS RLS. CHỈ dùng cho thao tác thật sự cần vượt
 * quyền user (audit log write, admin ops, retention job P07). KHÔNG import
 * file này (hoặc client này) từ bất kỳ "use client" component nào —
 * `server-only` sẽ throw build-time nếu vi phạm.
 */
let cachedServiceRoleClient: ReturnType<typeof createClient<Database>> | undefined;

export function createServiceRoleClient() {
  if (cachedServiceRoleClient) return cachedServiceRoleClient;
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();

  cachedServiceRoleClient = createClient<Database>(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedServiceRoleClient;
}
