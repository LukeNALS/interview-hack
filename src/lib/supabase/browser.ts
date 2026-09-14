import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/db";
import { getPublicEnv } from "@/lib/env";

/** Client browser — dùng anon/publishable key, RLS luôn áp dụng. */
export function createBrowserSupabaseClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getPublicEnv();
  return createBrowserClient<Database>(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
