import "server-only";
import { z } from "zod";

/** Lỗi khi output LLM parse/validate JSON thất bại — route quyết định retry. */
export class LlmJsonInvalidError extends Error {
  issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "LlmJsonInvalidError";
    this.issues = issues;
  }
}

/** Parse text → JSON → validate zod. Throw LlmJsonInvalidError khi lỗi (parse hoặc schema). */
export function parseStructuredJson<T>(schema: z.ZodType<T>, raw: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmJsonInvalidError("LLM trả JSON không hợp lệ (parse lỗi)");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new LlmJsonInvalidError("LLM trả JSON sai schema", issues);
  }
  return result.data;
}
