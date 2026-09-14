import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { withAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { broadcastEvent } from "@/lib/realtime/broadcast-server";
import { callClaude } from "@/lib/llm/client";
import { LlmJsonInvalidError, parseStructuredJson } from "@/lib/llm/json";
import {
  buildAnswerHintPrompt,
  llmAnswerHintJsonSchema,
  llmAnswerHintOutputSchema,
} from "@/lib/llm/prompts/answer-hint";
import { suggestRequestSchema } from "@/schemas/rest";
import type { Speaker } from "@/types/events";

/**
 * POST /api/sessions/:id/answer-hint — producer "gợi ý trả lời" cho chế độ ỨNG VIÊN
 * (plan 20260905-0820). Client-trigger debounce sau final của NGƯỜI
 * PHỎNG VẤN, best-effort toàn tuyến ({suggested:false} thay vì 5xx), rate-limit
 * fail-closed 6/phút, task LLM 'suggest' (cùng model/timeout). Chỉ chạy cho session
 * kind='candidate' — buổi interviewer gọi nhầm trả 404 không lộ chi tiết.
 */
export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

const RECENT_UTTERANCES = 10;
const ANSWER_MAX_TOKENS = 400;

export const POST = withAuth(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // Body rỗng hợp lệ — schema có default [].
  }
  const parsed = suggestRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ", 400, "validation_error");
  }

  const supabase = await createServerSupabaseClient();
  const { data: session } = await supabase
    .from("sessions")
    .select("id, status, kind, jd_text")
    .eq("id", id)
    .maybeSingle();
  if (!session || session.kind !== "candidate") {
    return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
  }
  if (session.status !== "live") {
    return NextResponse.json(errorResponseBody("session_ended", "Buổi phỏng vấn đã kết thúc"), { status: 409 });
  }

  // Fail-CLOSED: hint là phụ trợ — grant hỏng thì thà mất hint còn hơn mất trần chi phí.
  const limit = await checkRateLimit({ key: `answer-hint:min:${id}`, windowSeconds: 60, limit: 6 });
  if (!limit.allowed) {
    throw new AppError("Vượt giới hạn gợi ý — thử lại sau", 429, "rate_limit_exceeded");
  }

  const { data: uttRows } = await supabase
    .from("utterances")
    .select("speaker, text_orig")
    .eq("session_id", id)
    .order("seq", { ascending: false })
    .limit(RECENT_UTTERANCES);

  const utterances = (uttRows ?? [])
    .slice()
    .reverse()
    .map((row) => ({ speaker: row.speaker as Speaker, text: row.text_orig }));
  if (utterances.length === 0) return NextResponse.json({ suggested: false });

  const { system, user } = buildAnswerHintPrompt({
    sessionBrief: (session.jd_text as string | null) ?? null,
    utterances,
    visibleHints: parsed.data.visible_suggestions,
  });

  try {
    const result = await callClaude({
      task: "suggest",
      system,
      userContent: user,
      maxTokens: ANSWER_MAX_TOKENS,
      outputSchema: llmAnswerHintJsonSchema,
    });
    const output = parseStructuredJson(llmAnswerHintOutputSchema, result.text);
    if (output.answer === null) return NextResponse.json({ suggested: false });

    await broadcastEvent(id, { type: "suggestion.new", id: randomUUID(), text: output.answer });
    return NextResponse.json({ suggested: true });
  } catch (err) {
    if (err instanceof LlmJsonInvalidError) {
      console.warn("[suggest] answer-hint LLM trả sai schema — bỏ qua (best-effort)", { sessionId: id, issues: err.issues });
      return NextResponse.json({ suggested: false });
    }
    console.error("[suggest] answer-hint call LLM lỗi — bỏ qua (best-effort)", {
      sessionId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ suggested: false });
  }
});
