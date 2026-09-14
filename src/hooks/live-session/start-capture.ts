import type { MutableRefObject } from "react";
import { startDirectCapture } from "@/lib/audio/capture-direct";
import { startOnlineCapture } from "@/lib/audio/capture-online";
import { createAnalyserRmsReader, SilenceDetector } from "@/lib/audio/silence-detector";
import { renewKeyWithRetry } from "@/lib/soniox/renew-with-retry";
import { TempKeyClient } from "@/lib/soniox/temp-key-client";
import { useSessionStore } from "@/stores/session-store";
import { disposeLivePipeline, type LivePipeline } from "../live-pipeline";
import type { useConnectionBanner } from "../use-connection-banner";
import { createStreamAttacher } from "./attach-stream";
import { fetchSonioxKey } from "./live-session-api-client";

export interface StartLiveCaptureDeps {
  sessionId: string | null;
  /** Map client_utt_id -> id cục bộ; state client của PHIÊN (dọn khi đổi phiên, N5). */
  clientUttIdToLocalIdRef: MutableRefObject<Map<string, number>>;
  /** Bộ đếm id tạm (âm dần) cho utterance chưa có seq server. */
  tempIdCounterRef: MutableRefObject<number>;
  banner: ReturnType<typeof useConnectionBanner>;
}

/** Mở đường thu âm cho buổi live: temp key -> attach stream -> silence detector -> hẹn renew key.
 *  Thân hàm giữ nguyên các bản vá M8 (khe hở dispose giữa 2 lần attach), N2 (renew có retry +
 *  banner) và BUG #3 (đăng ký runtime vào pipeline NGAY khi mở được) — đọc comment tại chỗ
 *  trước khi đổi thứ tự bất kỳ dòng nào. */
export async function startLiveCapture(
  deps: StartLiveCaptureDeps,
  pipeline: LivePipeline,
  mode: "online" | "direct",
  t0Local: number,
): Promise<void> {
  const { sessionId, banner } = deps;
  if (!sessionId) return;
  // Đọc runtime từ pipeline (KHÔNG phải mảng cục bộ): dispose clear mảng -> mọi handler
  // đến sau khi đóng tự no-op, không còn utterance "ma" từ pipeline đã chết.
  const attach = createStreamAttacher(deps, pipeline, mode, t0Local);
  pipeline.tempKeyClient = new TempKeyClient(() => fetchSonioxKey(sessionId));
  await pipeline.tempKeyClient.fetchInitial();
  if (pipeline.disposed) return;

  const attachSilenceDetector = (streamForBanner: MediaStream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(streamForBanner).connect(analyser);
    const detector = new SilenceDetector({
      onSilentBanner: () => banner.showSilent(),
      onSignalRestored: () => banner.clear(),
    });
    detector.start(createAnalyserRmsReader(analyser));
    pipeline.silenceDetector = detector;
  };

  if (mode === "online") {
    const { mic, tab } = await startOnlineCapture();
    // Ghi nhận mic/tab THÔ ngay khi có: dispose xảy ra trước lúc attach xong vẫn tắt được.
    pipeline.rawStreams.push(mic, tab);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    // Chế độ ứng viên: mic = chính bạn (candidate), tab = người phỏng vấn (interviewer).
    await attach("mic", "candidate", mic);
    // M8 fix: khe hở dispose GIỮA hai lần attach (trước đây chỉ có check ở trước và sau cặp).
    // Không phải rò WebSocket như §7 từng ghi — `attach` đọc lease từ `pipeline.tempKeyClient`
    // (đã bị dispose set null) NGAY TRƯỚC `open()` nên nó NÉM trước khi mở được socket nào.
    // Cái ném đó rơi vào catch của mount effect -> toast lỗi GIẢ "Không bật được micro..."
    // trong khi user chỉ rời màn live. Thoát sạch ở đây là đúng ngữ nghĩa hơn.
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    await attach("tab", "interviewer", tab);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    attachSilenceDetector(tab);
  } else {
    const stream = await startDirectCapture();
    pipeline.rawStreams.push(stream);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    await attach("mixed", null, stream);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    attachSilenceDetector(stream);
  }

  const scheduleNextRenewal = () => {
    pipeline.tempKeyClient?.scheduleRenewal(() => {
      // N2 fix: trước đây `client.renew()` gọi trần trong async KHÔNG catch, mà lệnh hẹn
      // lượt kế tiếp lại nằm CUỐI async đó -> renew ném 1 lần là chuỗi renew chết câm,
      // key hết hạn, stream tắt giữa buổi mà user không thấy banner nào.
      void (async () => {
        const client = pipeline.tempKeyClient;
        if (!client || pipeline.disposed) return;
        const renewed = await renewKeyWithRetry({
          renew: () => client.renew(),
          applyKey: async (lease) => {
            for (const s of pipeline.streams.current) await s.controller.renew(lease.key);
          },
          isDisposed: () => pipeline.disposed,
          onDegraded: () => banner.showDegraded(),
          onRestored: () => banner.showRestored(),
          onGiveUp: () => {
            banner.showDegraded();
            useSessionStore
              .getState()
              .showToast("Không gia hạn được khoá thu âm — thu âm sắp dừng, hãy kết thúc buổi và tải lại trang");
          },
        });
        // Chỉ hẹn lượt kế tiếp khi renew THẬT SỰ xong; bỏ cuộc thì dừng CÓ BÁO (banner + toast).
        if (renewed && !pipeline.disposed) scheduleNextRenewal();
      })().catch(() => {
        // Lưới cuối: renewKeyWithRetry đã bọc mọi lỗi, nhưng không để bất kỳ rejection nào
        // lọt thành unhandled (đúng cái đã làm N2 hỏng trong im lặng).
        banner.showDegraded();
      });
    });
  };
  scheduleNextRenewal();
}
