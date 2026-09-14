"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSessionStore } from "@/stores/session-store";
import {
  acquireLivePipeline,
  releaseLivePipeline,
  type LivePipeline,
} from "./live-pipeline";
import { endLiveInterview } from "./live-session/end-interview";
import { startLiveCapture } from "./live-session/start-capture";
import { applyBackfillRowToStore } from "./live-session/backfill-apply";
import { bootstrapLivePipeline } from "./live-session/bootstrap-live-pipeline";
import { useBackfill, type UtteranceRow } from "./use-backfill";
import { useCapCountdown } from "./use-cap-countdown";
import { useConnectionBanner } from "./use-connection-banner";
import { useEndSession, useSession } from "./use-session";

/** Vòng đời pipeline (StreamRuntime + closeAllStreamsOnce) chuyển sang `./live-pipeline`
 *  vì phải sống ở module scope theo session, không theo instance hook (BUG #3).
 *  Re-export giữ nguyên đường import cũ cho caller/test. */
export { closeAllStreamsOnce, type StreamRuntime } from "./live-pipeline";

/** Phần thuần logic của màn live nằm ở `./live-session/*` (mốc 200 dòng/file). File này giữ
 *  vai trò MẶT TIỀN: re-export nguyên đường import cũ nên caller/test không phải đổi gì. */
export { resolveT0LocalMs, resyncAfterReconnect, handleSeqGap } from "./live-session/session-timeline";
export {
  flushIngestQueueBeforeEnd,
  reconnectWithBackoff,
  type ReconnectWithBackoffDeps,
  type ReconnectWithBackoffOptions,
} from "./live-session/live-session-lifecycle";

export interface LiveSessionApi {
  /** M3 fix (DRY): đường DUY NHẤT kết thúc buổi (thủ công qua LiveEndModal / cap auto-stop /
   *  409 session_ended) — đóng stream, flush ingest queue, POST /end best-effort, về /candidate. */
  endInterview: () => Promise<void>;
}

/**
 * Orchestrator màn live (phase-05 bước 12-16): capture 2 chế độ -> fan-out
 * Soniox -> align -> chuẩn hoá trục session -> ingest-queue -> Realtime
 * subscribe -> store.
 *
 * ĐÚNG 1 pipeline/SESSION (registry `./live-pipeline`), KHÔNG phải 1/mount: điều hướng
 * client-side có thể mount `LiveScreen` 2 lần cho cùng session, mount sau chỉ mượn lại
 * pipeline đang chạy (BUG #3 — trước đây mở connection Soniox thứ hai, transcript nhân
 * đôi và tính tiền gấp đôi).
 */
export function useLiveSession(sessionId: string | null): LiveSessionApi {
  const router = useRouter();
  const session = useSession(sessionId);
  const { backfillFrom } = useBackfill(sessionId);
  const endSessionMutation = useEndSession(sessionId);
  const banner = useConnectionBanner();

  // Vòng đời capture nằm ở registry theo sessionId (`./live-pipeline`) chứ KHÔNG theo
  // instance: 2 mount cùng session dùng chung 1 pipeline (BUG #3). Ref bên dưới chỉ giữ
  // state thuần client của riêng instance (map id tạm, cờ banner degraded).
  const clientUttIdToLocalIdRef = useRef(new Map<string, number>());
  const endingRef = useRef(false);
  const wasDegradedRef = useRef(false);
  const tempIdCounterRef = useRef(-1);

  // N5: store là singleton module-scope, KHÔNG tự reset theo phiên. Effect này phải đứng
  // TRƯỚC mọi effect bơm dữ liệu phiên vào store (sync backfill ở mount effect) — React
  // chạy effect theo thứ tự khai báo, nên dọn xong mới tới lượt bơm dữ liệu mới.
  useEffect(() => {
    if (!sessionId) return;
    // Map id tạm + bộ đếm id tạm là state client của PHIÊN: route param đổi mà component
    // không remount thì chúng còn mang id của phiên cũ (client_utt_id có thể trùng giữa
    // 2 phiên vì dựng từ label + t_start_ms).
    clientUttIdToLocalIdRef.current.clear();
    tempIdCounterRef.current = -1;
    useSessionStore.getState().enterSession(sessionId);
  }, [sessionId]);

  const applyBackfillRow = useCallback(
    (row: UtteranceRow) => applyBackfillRowToStore(row, { clientUttIdToLocalId: clientUttIdToLocalIdRef.current }),
    [],
  );

  // ===== End of interview (cap / 409 / manual — DUY NHẤT 1 đường, M3 fix DRY:
  // LiveEndModal's nút "Kết thúc" giờ gọi thẳng hàm này thay vì tự làm luồng riêng) =====
  const endInterview = useCallback(
    () =>
      endLiveInterview({
        sessionId,
        endingRef,
        endSession: () => endSessionMutation.mutateAsync(),
        navigateAfterEnd: () => {
          // reset() TRƯỚC toast — đồng bộ với nút "Buổi mới": buổi đã kết thúc thì form
          // phải TRẮNG, không giữ dữ liệu buổi cũ. Toast sau reset vì reset xoá field toast.
          useSessionStore.getState().reset();
          useSessionStore.getState().showToast("Đã kết thúc buổi phỏng vấn");
          router.push("/candidate");
        },
      }),
    [endSessionMutation, router, sessionId],
  );

  // Tên ứng viên + vị trí vào store để header/bubble dùng chung một nguồn (thay MOCK_SESSION).
  useEffect(() => {
    if (!session.data) return;
    useSessionStore.getState().patch({
      candidateName: session.data.candidate_name ?? "Ứng viên",
      position: session.data.position ?? "",
    });
  }, [session.data]);

  useCapCountdown({
    startedAt: session.data?.started_at ?? null,
    capSeconds: session.data?.cap_seconds ?? 5400,
    onTick: (elapsedSeconds) => useSessionStore.getState().patch({ elapsed: elapsedSeconds }),
    onWarn5Min: () => useSessionStore.getState().showToast("Còn 5 phút — buổi phỏng vấn sắp chạm giới hạn 90 phút"),
    onWarn1Min: () => useSessionStore.getState().showToast("Còn 1 phút — buổi sẽ tự kết thúc"),
    onCapReached: () => void endInterview(),
  });

  // ===== Capture pipeline =====
  const startCapture = useCallback(
    (pipeline: LivePipeline, mode: "online" | "direct", t0Local: number) =>
      startLiveCapture(
        { sessionId, clientUttIdToLocalIdRef, tempIdCounterRef, banner },
        pipeline,
        mode,
        t0Local,
      ),
    [banner, sessionId],
  );

  // ===== Mount effect =====
  // BUG #3 fix: pipeline thuộc về SESSION (registry module scope), không thuộc instance.
  // Mount thứ hai của cùng session (điều hướng client-side làm LiveScreen mount 2 lần)
  // chỉ "mượn" pipeline đang chạy -> KHÔNG mở connection Soniox thứ hai.
  useEffect(() => {
    if (!sessionId) return;
    if (!session.data || session.data.status !== "live" || !session.data.started_at) return;
    const currentSessionId = sessionId;
    const startedAtIso = session.data.started_at;
    const mode = session.data.mode;
    const { pipeline, created } = acquireLivePipeline(currentSessionId);

    if (created) {
      bootstrapLivePipeline(pipeline, currentSessionId, startedAtIso, mode, {
        endInterview,
        backfillFrom,
        applyBackfillRow,
        clientUttIdToLocalId: clientUttIdToLocalIdRef.current,
        banner,
        wasDegraded: wasDegradedRef,
        startCapture,
      });
    }

    // Instance cuối cùng rời màn mới đóng pipeline; instance "mượn" unmount là no-op.
    return () => releaseLivePipeline(pipeline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session.data?.status, session.data?.started_at]);

  return { endInterview };
}
