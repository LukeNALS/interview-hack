import { formatElapsed } from "@/components/live/live-utils";
import type { SubscribeStatus } from "@/lib/realtime/subscribe-client";
import { useSessionStore } from "@/stores/session-store";
import type { ServerEvent } from "@/types/events";
import { getLivePipeline } from "../live-pipeline";
import type { BackfillResult, UtteranceRow } from "../use-backfill";
import type { useConnectionBanner } from "../use-connection-banner";
import { resyncAfterReconnect } from "./session-timeline";
import { upsertUtterance } from "./utterance-mapping";

export interface RealtimeHandlerDeps {
  sessionId: string | null;
  /** Nối bản local (id tạm âm) với `seq` server qua `client_utt_id` — CHIA SẺ với
   *  `attach-stream.ts` (cùng instance Map, xem `upsertUtterance`), không tự tạo mới ở đây. */
  clientUttIdToLocalId: Map<string, number>;
  backfillFrom: (afterSeq: number) => Promise<BackfillResult>;
  applyBackfillRow: (row: UtteranceRow) => void;
  banner: ReturnType<typeof useConnectionBanner>;
  /** Đã từng rớt trong phiên này chưa — quyết định có resync sau khi SUBSCRIBED hay không (fix B15).
   *  Nhận getter/setter chứ KHÔNG nhận thẳng ref: hook gọi factory này trong thân render, mà đọc
   *  `.current` lúc render là thứ `react-hooks/refs` chặn (và đúng là sai về mặt React). */
  hadDegraded: () => boolean;
  setDegraded: (value: boolean) => void;
  /** N13b: báo trigger gợi ý mỗi khi có utterance.final của speaker được theo dõi (không bắn
   *  cho backfill) — chế độ ứng viên theo dõi lượt của NGƯỜI PHỎNG VẤN (xin gợi ý trả lời). */
  onCandidateFinal?: () => void;
  /** Speaker kích trigger. */
  triggerSpeaker: "interviewer" | "candidate";
}

/** Handler cho kênh Realtime của buổi live: utterance.final + đổi trạng thái kết nối.
 *  Tách khỏi hook chỉ để giữ mốc 200 dòng/file — thân hàm nguyên văn. */
export function createRealtimeHandlers(deps: RealtimeHandlerDeps): {
  handleRealtimeEvent: (event: ServerEvent) => void;
  handleStatusChange: (status: SubscribeStatus) => void;
} {
  const { sessionId, clientUttIdToLocalId, backfillFrom, applyBackfillRow, banner, hadDegraded, setDegraded } = deps;
  // Dedupe suggestion theo uuid server (Realtime có thể phát lại 1 event) — Set sống theo
  // pipeline (factory này gọi 1 lần/pipeline trong bootstrap).
  const seenSuggestionIds = new Set<string>();

  const handleRealtimeEvent =
  (event: ServerEvent) => {
    if (event.type === "utterance.final") {
      const e = event;
      upsertUtterance({
        id: e.seq,
        speaker: e.speaker,
        lang: e.lang,
        text_orig: e.text_orig,
        translations: e.translations,
        // Tự format thay vì dùng `e.time`: server format bằng `formatElapsedClock` (mm:ss),
        // client bằng `formatElapsed` (00:MM:SS) — trộn hai kiểu trên cùng danh sách thì
        // lệch trông thấy. Một nguồn format duy nhất cho mọi bubble.
        time: formatElapsed(Math.floor((e.t_start_ms ?? 0) / 1000)),
        partial: false,
        clientUttId: e.client_utt_id,
      }, clientUttIdToLocalId);
      getLivePipeline(sessionId ?? "")?.seqBuffer?.feed(e.seq);
      if (e.speaker === deps.triggerSpeaker) deps.onCandidateFinal?.();
    } else if (event.type === "suggestion.new") {
      if (seenSuggestionIds.has(event.id)) return;
      seenSuggestionIds.add(event.id);
      const store = useSessionStore.getState();
      // id UI = max + 1 (pure, như nextQuestionId) — id uuid server chỉ dùng để dedupe.
      const nextId = store.suggs.reduce((max, s) => Math.max(max, s.id), 0) + 1;
      store.addSuggestion({ id: nextId, text: event.text });
    }
  };

  const handleStatusChange =
  (status: SubscribeStatus) => {
    const pipeline = getLivePipeline(sessionId ?? "");
    if (status === "disconnected") {
      setDegraded(true);
      banner.showDegraded();
      return;
    }
    // SUBSCRIBED — chỉ resync nếu TRƯỚC ĐÓ có rớt (fix B15); lần subscribe đầu tiên không cần.
    if (hadDegraded()) {
      setDegraded(false);
      void resyncAfterReconnect({
        backfillFrom,
        lastSeq: pipeline?.seqBuffer?.current ?? 0,
        applyBackfillRow,
        syncSeqBuffer: (utterances) => {
          const maxSeq = utterances.at(-1)?.seq;
          if (maxSeq !== undefined) pipeline?.seqBuffer?.reset(maxSeq);
        },
        showRestored: banner.showRestored,
      });
    }
  };

  return { handleRealtimeEvent, handleStatusChange };
}
