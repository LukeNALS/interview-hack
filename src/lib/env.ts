import { z } from "zod";

/**
 * Env validation fail-fast (zod). Tách publicEnv (an toàn ở client, prefix
 * NEXT_PUBLIC_) khỏi serverEnv (secret — service-role key, LLM/ASR key).
 * serverEnv KHÔNG parse eager ở module scope để tránh throw khi bundle này
 * vô tình bị kéo vào client (Next.js tự strip non-NEXT_PUBLIC_ var ở client
 * runtime nên giá trị luôn undefined ở đó — getServerEnv() chỉ nên gọi từ
 * `src/lib/supabase/server.ts` và route handlers, các file đó có `server-only`).
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url({ message: "NEXT_PUBLIC_SUPABASE_URL phải là URL hợp lệ" }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY bắt buộc"),
  /** OPTIONAL — chỉ E2E set, trỏ Soniox WS sang mock server local. Không set -> endpoint
   *  production thật (default nằm ở `src/lib/soniox/connection.ts`). */
  NEXT_PUBLIC_SONIOX_WS_URL: z.string().url().optional(),
});

const serverSchema = z.object({
  SONIOX_API_KEY: z.string().min(1, "SONIOX_API_KEY bắt buộc"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY bắt buộc"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY bắt buộc"),
  /** OPTIONAL — chỉ E2E set, trỏ Anthropic SDK sang mock server local. Không set ->
   *  undefined -> SDK tự dùng base URL thật (xem `src/lib/llm/client.ts`). */
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  /** OPTIONAL — allowlist email admin, phân cách dấu phẩy (server-only, KHÔNG
   *  NEXT_PUBLIC_). Không set/rỗng -> /admin 404 với MỌI người (fail-closed),
   *  app thường không ảnh hưởng. */
  ADMIN_EMAILS: z.string().optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function formatZodError(prefix: string, error: z.ZodError): string {
  const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return `${prefix} — thiếu/sai biến môi trường: ${issues}`;
}

let cachedPublicEnv: PublicEnv | undefined;

/** An toàn gọi ở cả client và server. */
export function getPublicEnv(): PublicEnv {
  if (cachedPublicEnv) return cachedPublicEnv;
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SONIOX_WS_URL: process.env.NEXT_PUBLIC_SONIOX_WS_URL,
  });
  if (!parsed.success) {
    throw new Error(formatZodError("publicEnv", parsed.error));
  }
  cachedPublicEnv = parsed.data;
  return cachedPublicEnv;
}

let cachedServerEnv: ServerEnv | undefined;

/** CHỈ gọi server-side (route handler, server component, `src/lib/supabase/server.ts`). */
export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() không được gọi ở client — rò rỉ service-role/LLM key.");
  }
  if (cachedServerEnv) return cachedServerEnv;
  const parsed = serverSchema.safeParse({
    SONIOX_API_KEY: process.env.SONIOX_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  });
  if (!parsed.success) {
    throw new Error(formatZodError("serverEnv", parsed.error));
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}
