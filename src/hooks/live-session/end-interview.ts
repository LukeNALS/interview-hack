import { disposeLivePipeline, getLivePipeline } from "../live-pipeline";
import { flushIngestQueueBeforeEnd } from "./live-session-lifecycle";

export interface EndLiveInterviewDeps {
  sessionId: string | null;
  /** Guard chặn gọi lại từ CHÍNH instance hook này (cap tick + 409 ingest + nút Kết thúc). */
  endingRef: { current: boolean };
  endSession: () => Promise<unknown>;
  /** Buổi đã dừng ghi — điều hướng về /candidate (Interview Hack không còn report/wait). */
  navigateAfterEnd: () => void;
}

/** Kết thúc buổi — DUY NHẤT 1 đường cho mọi lối ra (cap 90' / 409 session_ended / nút "Kết thúc",
 *  M3 fix DRY). Thứ tự dispose-rồi-flush là bản vá N4/H-N4a: `disposeLivePipeline` phải chạy TRƯỚC
 *  `flushIngestQueueBeforeEnd` (xem docs/security-notes.md §7) — ĐỪNG hoán vị. */
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
