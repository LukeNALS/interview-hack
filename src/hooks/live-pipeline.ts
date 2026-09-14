"use client";

import { stopDirectCapture } from "@/lib/audio/capture-direct";
import { stopOnlineCapture } from "@/lib/audio/capture-online";
import type { PcmWorkletCapture } from "@/lib/audio/pcm-worklet";
import type { SilenceDetector } from "@/lib/audio/silence-detector";
import type { TempKeyClient } from "@/lib/soniox/temp-key-client";
import type { AlignBuffer } from "@/lib/transcript/align";
import type { IngestQueue } from "@/lib/transcript/ingest-queue";
import type { SeqBuffer } from "@/lib/transcript/seq-buffer";
import type { StreamLabel } from "@/lib/transcript/utterance-builder";
import type { Speaker } from "@/types/events";
import type { SuggestionTrigger } from "./live-session/suggestion-trigger";
import type { SonioxStreamController } from "./use-soniox";

export interface StreamRuntime {
  label: StreamLabel;
  /** online: cố định theo nguồn (mic=interviewer/tab=candidate); direct: null -> quyết theo diarization heuristic. */
  fixedRole: Speaker | null;
  controller: SonioxStreamController;
  alignBuffer: AlignBuffer;
  pcmCapture: PcmWorkletCapture;
  mediaStream: MediaStream;
  directSpeakerMap: Map<string, Speaker>;
}

/**
 * M2 fix: đóng toàn bộ stream trong `ref` (Soniox controller + pcmCapture + alignBuffer +
 * raw MediaStream track) MỘT LẦN rồi clear `ref.current = []` — dùng chung cho `endInterview()`
 * VÀ cleanup effect khi unmount, idempotent: gọi lần 2 (vd unmount xảy ra ngay sau
 * `endInterview()` do SPA `router.push`) là no-op vì ref đã rỗng — tránh double-close SDK
 * session (chưa verify idempotent với SDK Soniox thật) + double `stopOnlineCapture`/
 * `stopDirectCapture` trên track đã dừng. `.catch()` trên `controller.stop()` phòng SDK reject
 * khi đóng session đã đóng (không rơi thành unhandled promise rejection).
 */
export function closeAllStreamsOnce(
  ref: { current: StreamRuntime[] },
  deps: { stopOnline?: typeof stopOnlineCapture; stopDirect?: typeof stopDirectCapture } = {},
): void {
  const { stopOnline = stopOnlineCapture, stopDirect = stopDirectCapture } = deps;
  const streams = ref.current;
  if (streams.length === 0) return;
  ref.current = [];
  for (const s of streams) {
    s.pcmCapture.stop();
    void s.controller.stop().catch(() => {});
    s.alignBuffer.dispose();
  }
  if (streams.length === 2) stopOnline({ mic: streams[0].mediaStream, tab: streams[1].mediaStream });
  else if (streams.length === 1) stopDirect(streams[0].mediaStream);
}

/**
 * BUG #3 fix — pipeline thu âm của MỘT session, sống ở module scope chứ KHÔNG phải
 * ref theo instance `useLiveSession`. Lý do: vào /live bằng điều hướng client-side,
 * `LiveScreen` mount 2 lần (SessionScreenGuard bounce live→prep→live khi cache
 * react-query còn `status='prep'`), mỗi mount là 1 instance mới nên cờ "đã setup"
 * theo ref instance KHÔNG chặn được mount thứ hai -> 2 pipeline chạy song song
 * (transcript nhân đôi + gấp đôi phút Soniox tính tiền).
 *
 * - `refCount`: số instance đang mount dùng chung pipeline này; về 0 mới thật sự đóng.
 * - `disposed`: cờ huỷ cho phần `startCapture` đang await dở tự đóng thứ vừa mở rồi thoát.
 * - `rawStreams`: MediaStream ĐÃ lấy được nhưng CHƯA kịp gắn thành `StreamRuntime`
 *   (đúng cửa sổ race cũ khiến cleanup no-op và bỏ sót mic đang bật).
 */
export interface LivePipeline {
  sessionId: string;
  refCount: number;
  disposed: boolean;
  /** Đang chạy `endInterview()` — chặn double-end kể cả khi 2 instance cùng gọi. */
  ending: boolean;
  /** Box `{current}` để dùng lại nguyên `closeAllStreamsOnce`; đẩy runtime vào NGAY khi mở xong. */
  streams: { current: StreamRuntime[] };
  rawStreams: MediaStream[];
  ingestQueue: IngestQueue | null;
  seqBuffer: SeqBuffer | null;
  tempKeyClient: TempKeyClient | null;
  silenceDetector: SilenceDetector | null;
  unsubscribe: (() => void) | null;
  /** Trigger "gợi ý đào sâu" (N13b) — dispose cùng pipeline để timer debounce không sống mồ côi. */
  suggestionTrigger: SuggestionTrigger | null;
}

const livePipelines = new Map<string, LivePipeline>();

function createPipeline(sessionId: string): LivePipeline {
  return {
    sessionId,
    refCount: 1,
    disposed: false,
    ending: false,
    streams: { current: [] },
    rawStreams: [],
    ingestQueue: null,
    seqBuffer: null,
    tempKeyClient: null,
    silenceDetector: null,
    unsubscribe: null,
    suggestionTrigger: null,
  };
}

/**
 * Mount: dùng lại pipeline đang chạy của session (`created=false` -> instance này KHÔNG
 * được setup lần nữa) hoặc tạo mới (`created=true`). Pipeline đã `disposed` bị bỏ đi và
 * tạo lại — vào /live lần sau (sau khi rời hẳn màn) vẫn thu âm bình thường.
 */
export function acquireLivePipeline(sessionId: string): { pipeline: LivePipeline; created: boolean } {
  const existing = livePipelines.get(sessionId);
  if (existing && !existing.disposed) {
    existing.refCount += 1;
    return { pipeline: existing, created: false };
  }
  const pipeline = createPipeline(sessionId);
  livePipelines.set(sessionId, pipeline);
  return { pipeline, created: true };
}

export function getLivePipeline(sessionId: string): LivePipeline | null {
  const pipeline = livePipelines.get(sessionId);
  return pipeline && !pipeline.disposed ? pipeline : null;
}

/** Đóng sạch pipeline (idempotent) — stream đã gắn, mic thô chưa kịp gắn, banner, key, Realtime. */
export function disposeLivePipeline(pipeline: LivePipeline): void {
  // N4 fix — THỨ TỰ Ở ĐÂY LÀ MỘT PHẦN CỦA BẢN VÁ, đừng dồn xuống dưới:
  // `AlignBuffer.dispose()` giờ emit nốt canonical-final đang chờ EN, nhưng utterance đó chỉ
  // sống sót nếu đi qua được 2 chốt kế tiếp — `handleAligned` mở đầu bằng
  // `if (pipeline.disposed) return`, và `ingestQueue.enqueue` bị chặn sau `dispose()`. Nên đợt
  // flush ĐỒNG BỘ này phải chạy khi pipeline CÒN SỐNG, trước 2 lệnh dưới. Guard kia KHÔNG bị
  // nới: nó vẫn chặn utterance "ma" từ callback Soniox bay lạc SAU thời điểm này.
  // `closeAllStreamsOnce` bên dưới gọi `alignBuffer.dispose()` lần nữa — idempotent, no-op.
  for (const stream of pipeline.streams.current) stream.alignBuffer.dispose();
  pipeline.disposed = true;
  pipeline.unsubscribe?.();
  pipeline.unsubscribe = null;
  pipeline.suggestionTrigger?.dispose();
  pipeline.suggestionTrigger = null;
  // M9 fix: queue ingest thuộc pipeline nhưng trước đây dispose KHÔNG chạm tới -> vòng retry
  // 429 chạy tiếp suốt vòng đời SPA kể cả sau khi rời màn live. `dispose()` chỉ cắt hoạt động
  // NỀN; `endInterview()` giữ ref queue TRƯỚC khi dispose nên vẫn flush được batch cuối buổi.
  pipeline.ingestQueue?.dispose();
  // Track của stream đã gắn runtime do closeAllStreamsOnce lo; chỉ dừng phần CHƯA gắn
  // để không stop 2 lần (mất dấu vết thật khi đếm trong test vòng đời).
  const attached = new Set(pipeline.streams.current.map((s) => s.mediaStream));
  closeAllStreamsOnce(pipeline.streams);
  for (const stream of pipeline.rawStreams) {
    if (attached.has(stream)) continue;
    for (const track of stream.getTracks()) track.stop();
  }
  pipeline.rawStreams = [];
  pipeline.silenceDetector?.stop();
  pipeline.silenceDetector = null;
  pipeline.tempKeyClient?.dispose();
  pipeline.tempKeyClient = null;
}

/** Unmount: bớt 1 instance; instance cuối cùng rời màn mới đóng pipeline + xoá khỏi registry. */
export function releaseLivePipeline(pipeline: LivePipeline): void {
  pipeline.refCount -= 1;
  if (pipeline.refCount > 0) return;
  // H-N4a fix (code review WAVE B): đây là đường thứ HAI tới `disposeLivePipeline`, đi khi user
  // rời màn live mà KHÔNG bấm "Kết thúc" (back trình duyệt, điều hướng SPA, route guard đá ra).
  // Vòng flush align ở đầu `disposeLivePipeline` đẩy được câu cuối vào queue, nhưng đường này
  // KHÔNG có `flushIngestQueueBeforeEnd` nào theo sau như `endInterview()` — `dispose()` huỷ
  // debounce timer là item kẹt `pendingCount` vĩnh viễn, chết theo SPA. Cùng triệu chứng N4 gốc.
  const queue = pipeline.ingestQueue;
  disposeLivePipeline(pipeline);
  // Best-effort, KHÔNG `await`: cleanup effect của React phải đồng bộ. Gọi được sau `dispose()`
  // là nhờ bất biến WAVE A — `IngestQueue.dispose()` CỐ Ý không khoá `flushNow()`.
  // Gửi trùng vô hại: server idempotent theo `client_utt_id` (DB có `unique (session_id,
  // client_utt_id)`), và queue rỗng thì `flush()` là no-op, không đẻ request thừa.
  void queue?.flushNow().catch(() => {});
  if (livePipelines.get(pipeline.sessionId) === pipeline) livePipelines.delete(pipeline.sessionId);
}
