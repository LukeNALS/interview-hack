/**
 * Event contract cho Realtime pipeline (Supabase Realtime broadcast).
 * Kênh mỗi session: `session:{session_id}` (xem realtimeChannelName).
 * 7 server event + 2 client event — đủ ngay Phase 1 dù suggestion/insight
 * engine chưa chạy (contract-first, xem shared-understanding.md T8/AC8).
 */

export type Lang = "vi" | "ja" | "en";
export type Speaker = "interviewer" | "candidate";
export type SuggestionAckAction = "added" | "skipped";

/** vi/ja/en — thiếu bản dịch (vd lượt thuần en, xem caveat B5) → null. */
export type Translations = Partial<Record<Lang, string | null>>;

export interface UtterancePartialEvent {
  type: "utterance.partial";
  id: string;
  speaker: Speaker;
  lang: Lang | null;
  text: string;
}

export interface UtteranceFinalEvent {
  type: "utterance.final";
  id: string;
  /** utterances.seq — số duy nhất dùng backfill sau reconnect (T8). */
  seq: number;
  speaker: Speaker;
  lang: Lang | null;
  text_orig: string;
  translations: Translations;
  question_id: string | null;
  /** mm:ss hoặc hh:mm:ss tính từ started_at, vd "00:04:15". */
  time: string;
  /** Id do client sinh khi ghi âm. Client dùng nó để nhận ra lượt thoại này CHÍNH LÀ bản
   *  local id tạm của mình và đổi id thay vì chèn bản thứ hai (nguồn lỗi transcript nhân đôi). */
  client_utt_id: string | null;
  /** Mốc thời gian thô — client tự format, tránh hai định dạng khác nhau trên cùng danh sách. */
  t_start_ms: number | null;
}

export interface SuggestionNewEvent {
  type: "suggestion.new";
  id: string;
  text: string;
}

export interface InsightNewEvent {
  type: "insight.new";
  /** mm:ss kể từ đầu buổi, vd "12:40". */
  at: string;
  text: string;
}

export interface ConnDegradedEvent {
  type: "conn.degraded";
}

export interface ConnRestoredEvent {
  type: "conn.restored";
}

export type ServerEvent =
  | UtterancePartialEvent
  | UtteranceFinalEvent
  | SuggestionNewEvent
  | InsightNewEvent
  | ConnDegradedEvent
  | ConnRestoredEvent;

export interface SuggestionAckEvent {
  type: "suggestion.ack";
  id: string;
  action: SuggestionAckAction;
}

export interface QuestionSelectEvent {
  type: "question.select";
  id: string;
}

export type ClientEvent = SuggestionAckEvent | QuestionSelectEvent;

export function realtimeChannelName(sessionId: string): string {
  return `session:${sessionId}`;
}
