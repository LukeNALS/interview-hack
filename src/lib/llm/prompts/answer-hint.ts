import { z } from "zod";
import { SYSTEM_PROMPTS } from "@/config/system-prompts";
import type { Speaker } from "@/types/events";

/**
 * Prompt "gợi ý trả lời" cho chế độ Ứng viên (plan 20260905-0820) — mirror
 * suggest-followup.ts: best-effort 1 call, schema tối giản {answer: string|null},
 * null khi lượt cuối của người phỏng vấn không phải câu hỏi.
 */

export interface AnswerHintPromptInput {
  /** Mô tả buổi phỏng vấn do ứng viên nhập lúc tạo (sessions.jd_text). */
  sessionBrief: string | null;
  /** Các lượt thoại gần nhất (cũ → mới). Builder tự cắt còn 10 lượt cuối. */
  utterances: { speaker: Speaker; text: string }[];
  /** Text các card gợi ý đang hiển thị — tránh trùng. */
  visibleHints: string[];
}

const MAX_UTTERANCES = 10;
const MAX_UTTERANCE_CHARS = 1000;
const MAX_BRIEF_CHARS = 2000;

function wrapDataBlock(label: string, content: string): string {
  return `<<<${label}_START>>>\n${content}\n<<<${label}_END>>>`;
}

export function buildAnswerHintPrompt(input: AnswerHintPromptInput): { system: string; user: string } {
  const recent = input.utterances.slice(-MAX_UTTERANCES);
  const transcript =
    recent.length > 0
      ? recent
          .map((u) => `${u.speaker === "interviewer" ? "PV" : "TÔI"}: ${u.text.slice(0, MAX_UTTERANCE_CHARS)}`)
          .join("\n")
      : "(chưa có lượt thoại)";
  const visible =
    input.visibleHints.length > 0 ? input.visibleHints.map((s) => `- ${s}`).join("\n") : "(không có)";

  const user = [
    wrapDataBlock("SESSION_BRIEF", (input.sessionBrief ?? "").slice(0, MAX_BRIEF_CHARS) || "(không có mô tả)"),
    wrapDataBlock("TRANSCRIPT", transcript),
    wrapDataBlock("VISIBLE_HINTS", visible),
    "Gợi ý tối đa 1 câu trả lời theo đúng yêu cầu ở system prompt.",
  ].join("\n\n");

  return { system: SYSTEM_PROMPTS.answerHint, user };
}

// ===== Schema validate output LLM =====

export const llmAnswerHintOutputSchema = z.object({
  /** null = lượt cuối không phải câu hỏi → route trả {suggested:false}, không broadcast. */
  answer: z.string().trim().min(1).max(600).nullable(),
});

export type LlmAnswerHintOutput = z.infer<typeof llmAnswerHintOutputSchema>;

/** JSON schema cho output_config.format — loose, ràng buộc thật ở zod trên. */
export const llmAnswerHintJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["answer"],
  additionalProperties: false,
};
