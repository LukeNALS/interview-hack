import { formatElapsed } from "@/components/live/live-utils";
import { PcmWorkletCapture } from "@/lib/audio/pcm-worklet";
import { AlignBuffer, type AlignedUtterance } from "@/lib/transcript/align";
import type { IngestUtterancePayload } from "@/lib/transcript/ingest-queue";
import { buildClientUtteranceId, normalizeToSessionAxis, type StreamLabel } from "@/lib/transcript/utterance-builder";
import { useSessionStore } from "@/stores/session-store";
import type { Speaker } from "@/types/events";
import { closeAllStreamsOnce, type LivePipeline, type StreamRuntime } from "../live-pipeline";
import { SonioxStreamController, type CanonicalSegment, type EnSegment } from "../use-soniox";
import { reconnectWithBackoff } from "./live-session-lifecycle";
import { resolveDirectSpeaker, upsertUtterance } from "./utterance-mapping";
import type { StartLiveCaptureDeps } from "./start-capture";

/** Dựng hàm `attach` cho một buổi capture: mở 1 stream Soniox + PCM worklet, nối align buffer,
 *  đăng ký runtime vào pipeline NGAY khi mở được (BUG #3) và cắm các handler
 *  canonical/en/partial/degraded. Tách khỏi `start-capture.ts` chỉ để giữ mốc 200 dòng/file —
 *  KHÔNG đổi hành vi, mọi comment bản vá tại chỗ vẫn là nguồn sự thật. */
export function createStreamAttacher(
  deps: StartLiveCaptureDeps,
  pipeline: LivePipeline,
  mode: "online" | "direct",
  t0Local: number,
): (label: StreamLabel, fixedRole: Speaker | null, mediaStream: MediaStream) => Promise<StreamRuntime> {
  const { clientUttIdToLocalIdRef, tempIdCounterRef, banner } = deps;
  const findRuntime = (label: StreamLabel) => pipeline.streams.current.find((r) => r.label === label);

  const handleAligned = (label: StreamLabel) => (aligned: AlignedUtterance) => {
    if (pipeline.disposed) return;
    const runtime = findRuntime(label);
    const epochConnMs = runtime?.controller.getEpochConnMs() ?? null;
    if (epochConnMs === null) return;
    const { t_start_ms, t_end_ms } = normalizeToSessionAxis({
      tSonioxStartMs: aligned.t_start_ms,
      tSonioxEndMs: aligned.t_end_ms,
      epochConnMs,
      t0LocalMs: t0Local,
    });
    const clientUttId = buildClientUtteranceId(label, t_start_ms);
    const localId = clientUttIdToLocalIdRef.current.get(clientUttId) ?? tempIdCounterRef.current--;
    clientUttIdToLocalIdRef.current.set(clientUttId, localId);
    const speaker = (aligned.speaker as Speaker | null) ?? "interviewer";

    upsertUtterance({
      id: localId,
      speaker,
      lang: aligned.lang,
      text_orig: aligned.text_orig,
      translations: aligned.translations,
      time: formatElapsed(Math.floor(t_start_ms / 1000)),
      partial: false,
      clientUttId,
    }, clientUttIdToLocalIdRef.current);
    // Final đã thay thế nội dung đang gõ — gỡ bubble partial (id -1/-2) của stream này,
    // nếu không nó nằm lại giữa transcript thành ô rỗng vô nghĩa (bug thấy 2026-08-24).
    useSessionStore.getState().removeUtt(label === "tab" ? -2 : -1);

    const payload: IngestUtterancePayload = {
      client_utt_id: clientUttId,
      speaker,
      lang: aligned.lang,
      text_orig: aligned.text_orig,
      translations: { vi: aligned.translations.vi, ja: aligned.translations.ja, en: aligned.translations.en },
      t_start_ms,
      t_end_ms,
      en_pending: aligned.en_pending,
    };
    pipeline.ingestQueue?.enqueue(payload);
  };

  const attach = async (label: StreamLabel, fixedRole: Speaker | null, mediaStream: MediaStream): Promise<StreamRuntime> => {
    const directSpeakerMap = new Map<string, Speaker>();
    const controller = new SonioxStreamController({
      mode,
      label,
      handlers: {
        onCanonicalFinal: (seg: CanonicalSegment) => {
          const runtime = findRuntime(label);
          const speaker = fixedRole ?? resolveDirectSpeaker(directSpeakerMap, seg.speaker);
          // TẠM (2026-08-25, gỡ sau khi chốt): direct mode 10/10 lượt ra interviewer — cần nhãn THÔ Soniox.
          if (!fixedRole) console.debug("[diarization]", { raw: seg.speaker ?? null, mapped: speaker, text: seg.textOrig.slice(0, 30) });
          runtime?.alignBuffer.addCanonicalFinal({
            client_utt_id: `${label}-raw:${seg.startMs}`,
            speaker,
            lang: seg.language,
            text_orig: seg.textOrig,
            translations: { vi: seg.translationVi, ja: seg.translationJa },
            t_start_ms: seg.startMs,
            t_end_ms: seg.endMs,
          });
        },
        onEnFinal: (seg: EnSegment) => {
          const runtime = findRuntime(label);
          runtime?.alignBuffer.addEnFinal({ text_en: seg.textEn ?? "", t_start_ms: seg.startMs, t_end_ms: seg.endMs });
        },
        onPartial: (text) => {
          const partialId = label === "tab" ? -2 : -1;
          if (text.trim() === "") {
            // Soniox flush partial rỗng khi chốt câu — vẽ nó là tạo ô trắng không timestamp.
            useSessionStore.getState().removeUtt(partialId);
            return;
          }
          const speaker: Speaker = fixedRole ?? "interviewer";
          upsertUtterance({
            id: partialId,
            speaker,
            lang: null,
            text_orig: text,
            translations: {},
            time: "",
            partial: true,
          });
        },
        // C1 fix: rớt Soniox WS ngoài ý muốn -> banner degraded + tự thử reconnect() với
        // backoff giới hạn (KHÔNG áp dụng cho đóng chủ động — controller tự lọc qua
        // stopped/stale-connection guard trong use-soniox.ts, xem handleDisconnected()).
        onDegraded: () => {
          banner.showDegraded();
          const runtime = findRuntime(label);
          if (!runtime) return;
          void reconnectWithBackoff({
            getApiKey: () => pipeline.tempKeyClient?.currentLease?.key ?? null,
            reconnect: (apiKey) => runtime.controller.reconnect(apiKey),
            onGiveUp: () => {
              runtime.pcmCapture.stop();
              useSessionStore
                .getState()
                .showToast(`Mất kết nối thu âm (${label}) — đã dừng, transcript trước đó vẫn giữ nguyên`);
            },
          });
        },
        // Banner restored đã tự bắn TRONG SonioxStreamController.reconnect() khi thành công.
        onRestored: () => banner.showRestored(),
        onError: () => useSessionStore.getState().showToast("Lỗi kết nối thu âm — đang thử lại"),
      },
    });

    const lease = pipeline.tempKeyClient?.currentLease;
    if (!lease) throw new Error("Không lấy được Soniox key");
    await controller.open(lease.key);
    const pcmCapture = new PcmWorkletCapture({ onChunk: (chunk) => controller.feed(chunk, Date.now()) });
    await pcmCapture.start(mediaStream);

    const runtime: StreamRuntime = {
      label,
      fixedRole,
      controller,
      alignBuffer: new AlignBuffer({ onEmit: handleAligned(label) }),
      pcmCapture,
      mediaStream,
      directSpeakerMap,
    };
    // BUG #3: đăng ký NGAY vào pipeline (không đợi mở hết mọi stream mới gán 1 lần) —
    // cleanup xảy ra giữa chừng vẫn đóng được đúng thứ đã mở.
    pipeline.streams.current.push(runtime);
    if (pipeline.disposed) closeAllStreamsOnce(pipeline.streams);
    return runtime;
  };

  return attach;
}
