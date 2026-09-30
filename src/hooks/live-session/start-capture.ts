import type { MutableRefObject } from "react";
import { startDirectCapture } from "@/lib/audio/capture-direct";
import { startOnlineCapture } from "@/lib/audio/capture-online";
import { createAnalyserRmsReader, SilenceDetector } from "@/lib/audio/silence-detector";
import { disposeLivePipeline, type LivePipeline } from "../live-pipeline";
import type { useConnectionBanner } from "../use-connection-banner";
import { createStreamAttacher } from "./attach-stream";
import { fetchSonioxPairKeys } from "./live-session-api-client";

export interface StartLiveCaptureDeps {
  sessionId: string | null;
  /** Map client_utt_id -> id cục bộ; state client của PHIÊN (dọn khi đổi phiên, N5). */
  clientUttIdToLocalIdRef: MutableRefObject<Map<string, number>>;
  /** Bộ đếm id tạm (âm dần) cho utterance chưa có seq server. */
  tempIdCounterRef: MutableRefObject<number>;
  banner: ReturnType<typeof useConnectionBanner>;
}

/** Mở đường thu âm cho buổi live: capture (user cấp quyền/chọn tab) -> xin cặp key single-use -> attach
 *  stream -> silence detector. Key xin SAU capture vì TTL chỉ 60 s (trước prompt chọn tab/mic thì hết hạn
 *  trước khi mở được). Không còn renew định kỳ: stream sống tới `max_session_duration`, mỗi lượt reconnect
 *  xin cặp MỚI. Giữ các bản vá M8 (khe hở dispose giữa 2 lần attach) và BUG #3 (đăng ký runtime vào
 *  pipeline NGAY khi mở được) — đọc comment tại chỗ trước khi đổi thứ tự bất kỳ dòng nào. */
export async function startLiveCapture(
  deps: StartLiveCaptureDeps,
  pipeline: LivePipeline,
  mode: "online" | "direct",
  t0Local: number,
): Promise<void> {
  const { sessionId, banner } = deps;
  if (!sessionId) return;
  const getKeys = () => fetchSonioxPairKeys(sessionId);
  // Đọc runtime từ pipeline (KHÔNG phải mảng cục bộ): dispose clear mảng -> mọi handler
  // đến sau khi đóng tự no-op, không còn utterance "ma" từ pipeline đã chết.
  const attach = createStreamAttacher(deps, pipeline, mode, t0Local, getKeys);

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
    // 2 request song song — mỗi luồng một cặp key riêng (mic + tab = 4 key). Lỗi route (503/502) ném ra
    // catch của bootstrap: dispose trả sạch mic/tab vừa mở + toast "dịch vụ tạm thời không khả dụng".
    const [micKeys, tabKeys] = await Promise.all([getKeys(), getKeys()]);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    // Chế độ ứng viên: mic = chính bạn (candidate), tab = người phỏng vấn (interviewer).
    await attach("mic", "candidate", mic, micKeys);
    // M8 fix: khe hở dispose GIỮA hai lần attach (trước đây chỉ có check ở trước và sau cặp). Key đã
    // truyền sẵn nên `attach` KHÔNG tự ném khi pipeline đã dispose — chốt này là thứ duy nhất ngăn mở
    // stream thứ hai (đốt phút Soniox) cho một pipeline đã chết. Thoát sạch ở đây cũng đúng ngữ nghĩa
    // hơn toast lỗi GIẢ "Không bật được micro..." khi user chỉ rời màn live.
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    await attach("tab", "interviewer", tab, tabKeys);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    attachSilenceDetector(tab);
  } else {
    const stream = await startDirectCapture();
    pipeline.rawStreams.push(stream);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    const keys = await getKeys();
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    await attach("mixed", null, stream, keys);
    if (pipeline.disposed) return disposeLivePipeline(pipeline);
    attachSilenceDetector(stream);
  }
}
