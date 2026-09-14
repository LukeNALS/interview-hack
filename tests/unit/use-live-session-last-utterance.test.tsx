import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";

/**
 * N4 (cấp pipeline) — câu CUỐI buổi phỏng vấn phải tới được server khi user bấm "Kết thúc"
 * đúng lúc canonical-final còn đang chờ bản dịch EN (cửa sổ `enWaitMs` = 1.2s).
 *
 * Đường đi: `endInterview()` → `disposeLivePipeline()` → `closeAllStreamsOnce()` →
 * `AlignBuffer.dispose()`. Sửa riêng `align.ts` cho `dispose()` biết emit là CHƯA đủ: bên trong
 * `disposeLivePipeline`, `pipeline.disposed = true` chạy TRƯỚC và `handleAligned` mở đầu bằng
 * `if (pipeline.disposed) return`, còn `ingestQueue.dispose()` thì chặn `enqueue` mới. Nghĩa là
 * utterance vừa emit vẫn bị vứt ở 2 chốt kế tiếp. Test này khoá TOÀN chuỗi (align → handleAligned
 * → ingestQueue → POST /utterances), không chỉ mắt xích đầu.
 *
 * Guard `pipeline.disposed` KHÔNG bị nới: nó vẫn chặn mọi utterance "ma" đến từ callback Soniox
 * bay lạc SAU khi pipeline chết. Thứ được phép đi qua chỉ là đợt flush ĐỒNG BỘ có chủ đích ngay
 * đầu `disposeLivePipeline`, lúc pipeline còn sống.
 */

interface CanonicalSegmentInput {
  textOrig: string;
  language: string | null;
  speaker: string | null;
  startMs: number;
  endMs: number;
  translationVi: string | null;
  translationJa: string | null;
}

const hoisted = vi.hoisted(() => {
  return {
    spy: {
      // Mảng vì mode "online" dựng HAI stream (mic + tab) -> hai AlignBuffer độc lập.
      handlersList: [] as Array<{ onCanonicalFinal: (seg: CanonicalSegmentInput) => void }>,
      mode: "direct" as "direct" | "online",
    },
  };
});

function fakeMediaStream(): MediaStream {
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
}

vi.mock("@/hooks/use-soniox", () => ({
  SonioxStreamController: class {
    constructor(opts: { handlers: { onCanonicalFinal: (seg: CanonicalSegmentInput) => void } }) {
      hoisted.spy.handlersList.push(opts.handlers);
    }
    async open() {}
    async stop() {}
    async reconnect() {}
    async renew() {}
    feed() {}
    getEpochConnMs() {
      return 0;
    }
  },
}));

vi.mock("@/lib/audio/capture-direct", () => ({
  startDirectCapture: async () => fakeMediaStream(),
  stopDirectCapture: () => {},
}));

vi.mock("@/lib/audio/capture-online", () => ({
  startOnlineCapture: async () => ({ mic: fakeMediaStream(), tab: fakeMediaStream() }),
  stopOnlineCapture: () => {},
  TabAudioTrackMissingError: class extends Error {},
}));

vi.mock("@/lib/audio/pcm-worklet", () => ({
  PcmWorkletCapture: class {
    async start() {}
    stop() {}
  },
}));

vi.mock("@/lib/audio/silence-detector", () => ({
  SilenceDetector: class {
    start() {}
    stop() {}
  },
  createAnalyserRmsReader: () => () => 0,
}));

vi.mock("@/lib/soniox/temp-key-client", () => ({
  TempKeyClient: class {
    currentLease = { key: "k-test", expiresAt: Date.now() + 60_000 };
    async fetchInitial() {
      return this.currentLease;
    }
    async renew() {
      return this.currentLease;
    }
    scheduleRenewal() {}
    dispose() {}
  },
}));

vi.mock("@/lib/realtime/subscribe-client", () => ({
  subscribeSessionChannel: () => () => {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const STARTED_AT = new Date().toISOString();

vi.mock("@/hooks/use-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-session")>();
  return {
    ...actual,
    // mode đọc từ spy: "direct" (1 attach — đủ dựng trạng thái N4 gọn) hoặc "online" (2 attach,
    // 2 AlignBuffer — cần cho ca khoá bất biến double-dispose).
    useSession: (sessionId: string | null) => ({
      data: { id: sessionId, status: "live", mode: hoisted.spy.mode, started_at: STARTED_AT, cap_seconds: 5400 },
    }),
    useEndSession: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  };
});

const { useLiveSession } = await import("@/hooks/use-live-session");

interface PostedUtterance {
  client_utt_id: string;
  text_orig: string;
  en_pending: boolean;
  translations: { vi: string | null; ja: string | null; en: string | null };
}

const posted: PostedUtterance[] = [];

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  hoisted.spy.handlersList = [];
  hoisted.spy.mode = "direct";
  posted.length = 0;
  useSessionStore.getState().patch({ toast: "" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      // Chặn ĐÚNG endpoint ingest và đọc body THẬT (không mock tầng IngestQueue/postUtterancesBatch)
      // — mock nông hơn sẽ xanh giả vì bỏ qua chính chốt `enqueue` bị chặn sau dispose.
      if (typeof input === "string" && input.includes("/utterances") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { utterances: PostedUtterance[] };
        posted.push(...body.utterances);
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: body.utterances.map((u, i) => ({ client_utt_id: u.client_utt_id, seq: i + 1 })) }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ utterances: [], next_after_seq: null }) };
    }),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser() {
        return {} as AnalyserNode;
      }
      createMediaStreamSource() {
        return { connect: () => {} };
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("test_live_session_end_while_last_utterance_waits_for_en_still_posts_it_to_server", async () => {
  // Arrange — pipeline live (direct), Soniox đã bắn canonical-final CUỐI nhưng chưa có bản dịch EN
  // khớp: nó nằm trong `pendingCanonical` của AlignBuffer, timer chờ 1.2s CHƯA trôi.
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-n4-1"), { wrapper });
  await flushAsync();
  expect(hoisted.spy.handlersList).toHaveLength(1);

  act(() => {
    hoisted.spy.handlersList[0].onCanonicalFinal({
      textOrig: "câu cuối của buổi phỏng vấn",
      language: "vi",
      speaker: "Speaker 1",
      startMs: 1000,
      endMs: 2000,
      translationVi: null,
      translationJa: "最後の一言",
    });
  });
  expect(posted).toHaveLength(0);

  // Act — user bấm "Kết thúc" NGAY sau câu nói cuối (rơi đúng cửa sổ chờ EN)
  await act(async () => {
    await view.result.current.endInterview();
  });
  await flushAsync();

  // Assert — câu cuối tới được server, đánh dấu chờ EN (server đã idempotent theo client_utt_id)
  expect(posted).toHaveLength(1);
  expect(posted[0].text_orig).toBe("câu cuối của buổi phỏng vấn");
  expect(posted[0].en_pending).toBe(true);
  expect(posted[0].translations.en).toBeNull();
});

test("test_live_session_canonical_final_arriving_after_dispose_is_still_dropped_as_ghost", async () => {
  // Arrange — pipeline đã đóng hẳn (user rời màn live), handler Soniox còn bay lạc sau đó.
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-n4-2"), { wrapper });
  await flushAsync();
  const handlers = hoisted.spy.handlersList[0];
  expect(handlers).toBeDefined();

  // Act — đóng pipeline TRƯỚC, callback muộn tới SAU
  view.unmount();
  await flushAsync();
  act(() => {
    handlers.onCanonicalFinal({
      textOrig: "utterance ma sau khi pipeline chết",
      language: "vi",
      speaker: "Speaker 1",
      startMs: 9000,
      endMs: 9500,
      translationVi: null,
      translationJa: null,
    });
  });
  await flushAsync();

  // Assert — guard `pipeline.disposed` vẫn còn răng: KHÔNG có utterance ma nào lọt lên server
  expect(posted).toHaveLength(0);
});

/**
 * H-N4a (code review WAVE B, CONFIRM bằng thực nghiệm) — `endInterview()` KHÔNG phải đường
 * DUY NHẤT tới `disposeLivePipeline`. Rời màn live mà không bấm "Kết thúc" (back trình duyệt,
 * điều hướng SPA, route guard đá ra) đi qua `releaseLivePipeline` — đường này KHÔNG có
 * `flushIngestQueueBeforeEnd` nào theo sau, nên `ingestQueue.dispose()` huỷ debounce timer là
 * câu cuối kẹt `pendingCount` vĩnh viễn: emit đúng, vào queue đúng, nhưng không ai gửi đi.
 * Cùng triệu chứng N4 gốc, khác cửa vào.
 */
test("test_live_session_unmount_without_pressing_end_still_posts_last_pending_utterance", async () => {
  // Arrange — canonical-final cuối đang chờ EN, timer 1.2s CHƯA trôi
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-n4-3"), { wrapper });
  await flushAsync();
  expect(hoisted.spy.handlersList).toHaveLength(1);

  act(() => {
    hoisted.spy.handlersList[0].onCanonicalFinal({
      textOrig: "câu cuối trước khi bấm back",
      language: "vi",
      speaker: "Speaker 1",
      startMs: 3000,
      endMs: 4000,
      translationVi: null,
      translationJa: "戻る前の最後の一言",
    });
  });
  expect(posted).toHaveLength(0);

  // Act — user rời màn live KHÔNG qua endInterview() (unmount thẳng)
  view.unmount();
  await flushAsync();

  // Assert — câu cuối vẫn tới server best-effort, không kẹt trong queue chết theo SPA
  expect(posted).toHaveLength(1);
  expect(posted[0].text_orig).toBe("câu cuối trước khi bấm back");
  expect(posted[0].en_pending).toBe(true);
});

/**
 * M-N4b (code review WAVE B) — mode `online` dựng HAI `AlignBuffer` (mic + tab). Bất biến
 * "double-dispose = no-op" mà comment `live-pipeline.ts` khẳng định mới chỉ được bảo đảm bằng
 * suy luận code (`closeAllStreamsOnce` gọi `dispose()` lần hai ngay sau vòng flush preamble).
 * Ca này khoá nó ở đúng cấu hình 2 stream: cả hai câu cuối phải tới server, và KHÔNG bản trùng.
 */
test("test_live_session_online_mode_end_flushes_both_align_buffers_without_duplicates", async () => {
  // Arrange — online: mic + tab, mỗi bên 1 canonical-final đang chờ EN
  hoisted.spy.mode = "online";
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-n4-4"), { wrapper });
  await flushAsync();
  expect(hoisted.spy.handlersList).toHaveLength(2);

  act(() => {
    hoisted.spy.handlersList[0].onCanonicalFinal({
      textOrig: "câu cuối phía người phỏng vấn",
      language: "vi",
      speaker: "Speaker 1",
      startMs: 5000,
      endMs: 6000,
      translationVi: null,
      translationJa: null,
    });
    hoisted.spy.handlersList[1].onCanonicalFinal({
      textOrig: "câu cuối phía ứng viên",
      language: "vi",
      speaker: "Speaker 2",
      startMs: 5200,
      endMs: 6200,
      translationVi: null,
      translationJa: null,
    });
  });
  expect(posted).toHaveLength(0);

  // Act
  await act(async () => {
    await view.result.current.endInterview();
  });
  await flushAsync();

  // Assert — đủ 2 câu, mỗi client_utt_id đúng MỘT lần (dispose lượt 2 là no-op thật)
  expect(posted).toHaveLength(2);
  expect(new Set(posted.map((u) => u.client_utt_id)).size).toBe(2);
  expect(posted.map((u) => u.text_orig).sort()).toEqual(
    ["câu cuối phía người phỏng vấn", "câu cuối phía ứng viên"].sort(),
  );
});
