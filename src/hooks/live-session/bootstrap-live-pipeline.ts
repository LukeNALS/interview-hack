import { TabAudioTrackMissingError } from "@/lib/audio/capture-online";
import { subscribeSessionChannel } from "@/lib/realtime/subscribe-client";
import { IngestQueue } from "@/lib/transcript/ingest-queue";
import { SeqBuffer } from "@/lib/transcript/seq-buffer";
import { useSessionStore } from "@/stores/session-store";
import { disposeLivePipeline, type LivePipeline } from "../live-pipeline";
import type { BackfillResult, UtteranceRow } from "../use-backfill";
import type { useConnectionBanner } from "../use-connection-banner";
import { postAnswerHint, postUtterancesBatch } from "./live-session-api-client";
import { createRealtimeHandlers } from "./live-session-realtime";
import { createSuggestionTrigger } from "./suggestion-trigger";
import { handleSeqGap, resolveT0LocalMs } from "./session-timeline";

export interface BootstrapLivePipelineDeps {
  endInterview: () => Promise<void> | void;
  backfillFrom: (afterSeq: number) => Promise<BackfillResult>;
  applyBackfillRow: (row: UtteranceRow) => void;
  /** Nối bản local (id tạm âm, gán ở `attach-stream.ts`) với `seq` server — CÙNG map
   *  instance với `startCapture`/`attach-stream` (qua `use-live-session.ts`'s ref). */
  clientUttIdToLocalId: Map<string, number>;
  banner: ReturnType<typeof useConnectionBanner>;
  /** Cờ "đã từng rớt" của instance hook — hộp mutable, KHÔNG đọc lúc render. */
  wasDegraded: { current: boolean };
  startCapture: (pipeline: LivePipeline, mode: "online" | "direct", t0Local: number) => Promise<void>;
}

/** Dựng phần chạy của 1 pipeline vừa được tạo: hàng đợi ingest -> seq buffer -> backfill đầu ->
 *  kênh Realtime -> capture. Mỗi lần `await` là một cửa sổ unmount, nên các chốt `pipeline.disposed`
 *  ở giữa là bắt buộc (BUG #3) — đừng bỏ. */
export function bootstrapLivePipeline(
  pipeline: LivePipeline,
  sessionId: string,
  startedAtIso: string,
  mode: "online" | "direct",
  deps: BootstrapLivePipelineDeps,
): void {
  pipeline.ingestQueue = new IngestQueue({
    postFn: (batch) => postUtterancesBatch(sessionId, batch),
    onSessionEnded: () => void deps.endInterview(),
  });
  pipeline.seqBuffer = new SeqBuffer({
    onGapDetected: (fromExcl) => void handleSeqGap(fromExcl, deps.backfillFrom, deps.applyBackfillRow),
    onAccepted: () => {},
  });

  void (async () => {
    const t0Local = resolveT0LocalMs(sessionId, startedAtIso);
    const initial = await deps.backfillFrom(0);
    // Unmount xảy ra trong lúc còn await -> pipeline đã dispose, dừng hẳn tại đây.
    if (pipeline.disposed) return;
    initial.utterances.forEach(deps.applyBackfillRow);
    pipeline.seqBuffer?.reset(initial.utterances.at(-1)?.seq ?? 0);

    // N13b: trigger gợi ý trả lời — sống theo pipeline, dispose trong disposeLivePipeline.
    // visible_suggestions đọc từ store TẠI THỜI ĐIỂM bắn (không đóng băng lúc tạo trigger).
    pipeline.suggestionTrigger = createSuggestionTrigger({
      post: () =>
        postAnswerHint(
          sessionId,
          useSessionStore.getState().suggs.map((s) => s.text),
        ),
    });

    // Handler Realtime dựng ở đây (trong effect, không phải thân render): chúng đọc cờ
    // `wasDegraded`, mà đọc ref lúc render là sai idiom React — `react-hooks/refs` chặn đúng.
    const { handleRealtimeEvent, handleStatusChange } = createRealtimeHandlers({
      sessionId,
      clientUttIdToLocalId: deps.clientUttIdToLocalId,
      backfillFrom: deps.backfillFrom,
      applyBackfillRow: deps.applyBackfillRow,
      banner: deps.banner,
      hadDegraded: () => deps.wasDegraded.current,
      setDegraded: (value) => {
        deps.wasDegraded.current = value;
      },
      // Trigger theo lượt final của NGƯỜI PHỎNG VẤN — xin gợi ý TRẢ LỜI cho ứng viên.
      onCandidateFinal: () => pipeline.suggestionTrigger?.onCandidateFinal(),
      triggerSpeaker: "interviewer",
    });
    pipeline.unsubscribe = subscribeSessionChannel({
      sessionId: sessionId,
      onEvent: handleRealtimeEvent,
      onStatusChange: handleStatusChange,
    });
    if (pipeline.disposed) return disposeLivePipeline(pipeline);

    try {
      await deps.startCapture(pipeline, mode, t0Local);
    } catch (err) {
      if (err instanceof TabAudioTrackMissingError) {
        useSessionStore.getState().showToast(err.message);
      } else {
        useSessionStore.getState().showToast("Không bật được micro/chia sẻ âm thanh — thử lại");
      }
      // Hỏng giữa chừng (vd mic mở được nhưng tab thì không) vẫn phải trả sạch thứ đã
      // mở — không để mic bật mồ côi; lần mount sau sẽ dựng pipeline mới và thử lại.
      disposeLivePipeline(pipeline);
    }
  })();
}
