/**
 * Fixture output LLM cho mock Claude. Interview Hack (chỉ ứng viên) chỉ còn 1
 * tác vụ LLM: gợi ý trả lời (`POST /answer-hint`, schema `{ answer: string | null }`
 * ở `src/lib/llm/prompts/answer-hint.ts`).
 */

/** Chế độ candidate: fixture gợi ý TRẢ LỜI (route theo properties.answer — answer-hint route). */
export const ANSWER_HINT_FIXTURE_TEXT =
  "Nêu 2 ý chính: em từng tối ưu API giảm 40% thời gian phản hồi, và em chủ động đo lường trước khi sửa.";

export function answerHintFixture(): unknown {
  return { answer: ANSWER_HINT_FIXTURE_TEXT };
}
