import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getServerEnv } from "@/lib/env";

/**
 * Wrapper mỏng quanh Anthropic SDK — 1 lời gọi Claude/lần, non-streaming.
 * timeout=25s (SLA route: hard cap 30s ở tầng route), SDK tự retry 1 lần
 * CHỈ khi lỗi mạng/5xx/429 (không retry lỗi 4xx khác) [SU AC9].
 * KHÔNG log jd/cv_text/nội dung — chỉ log task/model/stop_reason/usage token.
 */

/** Interview Hack chỉ còn 1 tác vụ LLM: gợi ý trả lời cho ứng viên (POST /answer-hint). */
export type LlmTask = "suggest";

/** Model mặc định theo task (suggest: Luke chốt Sonnet 5 ngày 2026-09-04, plan 20260904-1110). */
const DEFAULT_MODEL_BY_TASK: Record<LlmTask, string> = {
  suggest: "claude-sonnet-5",
};

/** Tên env var override model theo task — optional, có default hợp lý ở trên. */
const MODEL_ENV_VAR_BY_TASK: Record<LlmTask, string> = {
  suggest: "ANTHROPIC_MODEL_SUGGEST",
};

const THINKING_BY_TASK: Record<LlmTask, Anthropic.ThinkingConfigParam> = {
  suggest: { type: "disabled" },
};

const EFFORT_BY_TASK: Record<LlmTask, "low" | "medium" | "high"> = {
  suggest: "low",
};

const TIMEOUT_BY_TASK: Record<LlmTask, number> = {
  // payload nhỏ (~1-2k token vào / ~100-400 ra, Sonnet 5) — kỳ vọng 3-8s; route gọi ĐÚNG
  // 1 lần không retry, maxDuration 30 ⇒ 1 × 20s + biên DB/broadcast < 30 (quy tắc N×call).
  suggest: 20_000,
};
const MAX_TRANSPORT_RETRIES = 1;

let cachedClient: Anthropic | undefined;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const { ANTHROPIC_API_KEY } = getServerEnv();
  cachedClient = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    // KHÔNG đặt timeout ở đây — mỗi lời gọi tự truyền theo task (xem TIMEOUT_BY_TASK).
    maxRetries: MAX_TRANSPORT_RETRIES,
    // Override CHỈ có hiệu lực ngoài production — dành cho E2E trỏ sang mock server local.
    // Guard bắt buộc (code review P07, H1): không guard thì set 1 biến env trên Vercel là
    // đẩy toàn bộ request Claude — KÈM header ANTHROPIC_API_KEY — sang host bất kỳ mà
    // không cần deploy code. Prod luôn dùng base URL thật của SDK (undefined).
    baseURL: process.env.NODE_ENV === "production" ? undefined : process.env.ANTHROPIC_BASE_URL,
  });
  return cachedClient;
}

export function modelForTask(task: LlmTask): string {
  const override = process.env[MODEL_ENV_VAR_BY_TASK[task]]?.trim();
  return override && override.length > 0 ? override : DEFAULT_MODEL_BY_TASK[task];
}

export interface ClaudeCallParams {
  task: LlmTask;
  system: string;
  /** Nội dung user turn — string hoặc content block (text/image) cho vision. */
  userContent: string | Anthropic.MessageParam["content"];
  maxTokens: number;
  /** JSON schema cho output_config.format — bật structured output khi có. */
  outputSchema?: Record<string, unknown>;
}

export interface ClaudeCallResult {
  text: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/** 1 lời gọi Claude — throw lỗi SDK gốc khi network/5xx (đã retry 1 lần ở SDK). */
export async function callClaude(params: ClaudeCallParams): Promise<ClaudeCallResult> {
  const client = getClient();
  const model = modelForTask(params.task);

  const response = await client.messages.create({
    model,
    max_tokens: params.maxTokens,
    system: params.system,
    thinking: THINKING_BY_TASK[params.task],
    output_config: {
      effort: EFFORT_BY_TASK[params.task],
      ...(params.outputSchema ? { format: { type: "json_schema", schema: params.outputSchema } } : {}),
    },
    messages: [{ role: "user", content: params.userContent }],
  }, { timeout: TIMEOUT_BY_TASK[params.task] });

  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  console.info("[llm] call xong", {
    task: params.task,
    model,
    stop_reason: response.stop_reason,
    usage,
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );

  return { text: textBlock?.text ?? "", stopReason: response.stop_reason, usage };
}
