import { disposeLivePipeline, drainLivePipelineStreams, getLivePipeline } from "../live-pipeline";
import { flushIngestQueueBeforeEnd } from "./live-session-lifecycle";

/** Tối đa chờ `finish()` của Soniox khi kết thúc buổi (E7: câu dở + bản dịch về trong 0,3–0,5 s, 1,8 s nếu vừa replay). */
export const END_DRAIN_TIMEOUT_MS = 2000;

export interface EndLiveInterviewDeps {
  sessionId: string | null;
  /** Guard chặn gọi lại từ CHÍNH instance hook này (cap tick + 409 ingest + nút Kết thúc). */
  endingRef: { current: boolean };
  endSession: () => Promise<unknown>;
  /** Buổi đã dừng ghi — điều hướng về /candidate (Interview Hack không còn report/wait). */
  navigateAfterEnd: () => void;
}

/** Kết thúc buổi — DUY NHẤT 1 đường cho mọi lối ra (cap 90' / 409 session_ended / nút "Kết thúc",
 *  M3 fix DRY). Thứ tự drain → dispose → flush: drain Soniox trước (audit #7), rồi `disposeLivePipeline` phải chạy
 *  TRƯỚC `flushIngestQueueBeforeEnd` (bản vá N4/H-N4a, xem docs/security-notes.md §7) — ĐỪNG hoán vị. */
export async function endLiveInterview(deps: EndLiveInterviewDeps): Promise<void> {
  if (deps.endingRef.current || !deps.sessionId) return;
  // 2 lớp guard: `endingRef` chặn gọi lại từ CHÍNH instance này (cap tick + 409 ingest
  // + nút Kết thúc có thể bắn gần nhau), `pipeline.ending` chặn instance THỨ HAI của
  // cùng session (BUG #3) — pipeline sau khi dispose không còn tra được qua registry.
  const pipeline = getLivePipeline(deps.sessionId);
  if (pipeline?.ending) return;
  deps.endingRef.current = true;
  const queue = pipeline?.ingestQueue ?? null;
  if (pipeline) {
    pipeline.ending = true;
    // Drain TRƯỚC dispose (audit #7): dừng PCM rồi `finish()` Soniox để câu cuối còn bay về align buffer + ingest queue
    // khi pipeline còn sống. Dispose trước thì `handleAligned` chặn token về muộn và queue đã chết ⇒ mất câu cuối.
    try {
      await drainLivePipelineStreams(pipeline, END_DRAIN_TIMEOUT_MS);
    } catch {
      // không bao giờ để drain chặn luồng kết thúc (dispose + /end + navigate vẫn phải chạy)
    }
    // Đóng SẠCH: stream đã gắn + mic thô còn đang mở dở trong startCapture + key + Realtime.
    disposeLivePipeline(pipeline);
  }
  // M3 fix: flush hàng đợi ingest TRƯỚC /end + navigate — trước đây dựa hoàn toàn vào debounce
  // timer 300ms tự nhiên bắn, đóng tab ngay sau khi bấm "Kết thúc" có thể mất batch cuối.
  await flushIngestQueueBeforeEnd(queue);
  try {
    await deps.endSession();
  } catch {
    // /end best-effort — luồng cap 90'/409 vẫn PHẢI đưa được user về /candidate.
  }
  deps.navigateAfterEnd();
}
