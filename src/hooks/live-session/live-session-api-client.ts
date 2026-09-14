import {
  IngestRateLimitedError,
  IngestSessionEndedError,
  type IngestUtterancePayload,
} from "@/lib/transcript/ingest-queue";
import { ApiError, fetchJson } from "../use-session";

export async function fetchSonioxKey(sessionId: string): Promise<{ key: string; expiresAt: number }> {
  const res = await fetchJson<{ keys: string[]; expires_at: string }>(`/api/sessions/${sessionId}/soniox-key`, {
    method: "POST",
  });
  return { key: res.keys[0], expiresAt: Date.parse(res.expires_at) };
}

/** Xin gợi ý TRẢ LỜI sau câu hỏi của người phỏng vấn — best-effort, caller (suggestion-trigger) nuốt mọi lỗi. */
export async function postAnswerHint(
  sessionId: string,
  visibleHints: string[],
): Promise<{ suggested: boolean }> {
  return fetchJson<{ suggested: boolean }>(`/api/sessions/${sessionId}/answer-hint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visible_suggestions: visibleHints }),
  });
}

export async function postUtterancesBatch(
  sessionId: string,
  batch: IngestUtterancePayload[],
): Promise<{ results: { client_utt_id: string; seq: number }[] }> {
  try {
    return await fetchJson<{ results: { client_utt_id: string; seq: number }[] }>(
      `/api/sessions/${sessionId}/utterances`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ utterances: batch }) },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "rate_limit_exceeded") throw new IngestRateLimitedError();
      if (err.code === "session_ended") throw new IngestSessionEndedError();
    }
    throw err;
  }
}
