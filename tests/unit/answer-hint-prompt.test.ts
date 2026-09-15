import { expect, test } from "vitest";
import { buildAnswerHintPrompt, normalizeUtteranceText } from "@/lib/llm/prompts/answer-hint";

/** Gợi ý trả lời trả null cho "GPT là gì?" vì câu hỏi nằm ngoài mô tả buổi (2026-09-15).
 *  Ứng viên bị hỏi câu gì cũng cần trả lời được — brief chỉ để cá nhân hoá. */

test("test_answer_hint_system_prompt_never_uses_session_brief_as_reason_for_null", () => {
  // Arrange + Act
  const { system } = buildAnswerHintPrompt({ sessionBrief: "Tuyển thu ngân", utterances: [], visibleHints: [] });

  // Assert
  expect(system).not.toContain("THÀ trả null còn hơn gợi ý lạc đề");
  expect(system).toContain("KHÔNG BAO GIỜ là lý do để trả null");
});

test("test_answer_hint_prompt_transcript_whitespace_from_speech_to_text_is_normalized", () => {
  // Arrange
  const utterances = [{ speaker: "interviewer" as const, text: "  GPT   là gì?  " }];

  // Act
  const { user } = buildAnswerHintPrompt({ sessionBrief: "Tuyển thu ngân", utterances, visibleHints: [] });

  // Assert
  expect(user).toContain("PV: GPT là gì?");
  expect(normalizeUtteranceText("\n a   b \t")).toBe("a b");
});
