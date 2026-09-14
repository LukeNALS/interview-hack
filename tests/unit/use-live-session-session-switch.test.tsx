import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UtteranceRow } from "@/hooks/use-backfill";
import { useSessionStore } from "@/stores/session-store";

/**
 * N5 — `useSessionStore` là singleton module-scope, KHÔNG reset theo session.
 * Rời màn live phiên A giữa chừng rồi vào phiên B trong CÙNG TAB: `utts` của A còn
 * nguyên, và vì `upsertUtterance` khớp theo `id` (= seq server, bắt đầu từ 1 ở MỌI
 * phiên) nên backfill của B PATCH ĐÈ lên dòng A thay vì thay sạch -> transcript B
 * lẫn dòng A ở những seq B chưa chạm tới.
 */

function fakeMediaStream(): MediaStream {
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
}

vi.mock("@/hooks/use-soniox", () => ({
  SonioxStreamController: class {
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
    useSession: (sessionId: string | null) => ({
      data: {
        id: sessionId,
        status: "live",
        mode: "direct",
        started_at: STARTED_AT,
        cap_seconds: 5400,
      },
    }),
    useEndSession: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  };
});

const { useLiveSession } = await import("@/hooks/use-live-session");

/** Row backfill tối thiểu — `applyBackfillRow` chỉ đọc các field dưới đây. */
function backfillRow(seq: number, textOrig: string): UtteranceRow {
  return {
    seq,
    speaker: "candidate",
    lang: "vi",
    text_orig: textOrig,
    translations: { vi: textOrig },
    question_id: null,
    t_start_ms: seq * 1000,
    client_utt_id: `mic:${seq * 1000}`,
  } as unknown as UtteranceRow;
}

/** Backfill trả rows khác nhau theo sessionId trong URL. */
function stubBackfill(rowsBySession: Record<string, UtteranceRow[]>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const matched = Object.keys(rowsBySession).find((id) => url.includes(`/api/sessions/${id}/`));
      const utterances = matched && url.includes("/utterances?after_seq=") ? rowsBySession[matched] : [];
      return { ok: true, status: 200, json: async () => ({ utterances, next_after_seq: null }) };
    }),
  );
}

/** Nhường event loop cho chuỗi await trong setup pipeline (backfill -> key -> capture). */
async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

beforeEach(() => {
  useSessionStore.getState().reset();
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
  useSessionStore.getState().reset();
});

test("test_live_session_switch_to_new_session_drops_previous_session_transcript", async () => {
  // Arrange — phiên A có transcript 3 dòng (seq 1..3) lấy từ backfill
  stubBackfill({ "sess-a": [backfillRow(1, "A1"), backfillRow(2, "A2"), backfillRow(3, "A3")], "sess-b": [backfillRow(1, "B1")] });
  const first = renderHook(() => useLiveSession("sess-a"), { wrapper });
  await flushAsync();
  expect(useSessionStore.getState().utts.map((u) => u.orig)).toEqual(["A1", "A2", "A3"]);

  // Act — rời màn live phiên A giữa chừng rồi vào phiên B trong CÙNG TAB (store là singleton)
  first.unmount();
  const second = renderHook(() => useLiveSession("sess-b"), { wrapper });
  await flushAsync();

  // Assert — transcript B KHÔNG được chứa dòng nào của A
  expect(useSessionStore.getState().utts.map((u) => u.orig)).toEqual(["B1"]);

  second.unmount();
});

test("test_live_session_remount_same_session_keeps_transcript", async () => {
  // Arrange — reload/điều hướng lại CÙNG phiên: transcript phải giữ nguyên, không bị dọn
  stubBackfill({ "sess-same": [backfillRow(1, "S1"), backfillRow(2, "S2")] });
  const first = renderHook(() => useLiveSession("sess-same"), { wrapper });
  await flushAsync();
  first.unmount();

  // Act
  const second = renderHook(() => useLiveSession("sess-same"), { wrapper });
  await flushAsync();

  // Assert
  expect(useSessionStore.getState().utts.map((u) => u.orig)).toEqual(["S1", "S2"]);

  second.unmount();
});

test("test_live_session_first_entry_keeps_state_prepared_before_session", async () => {
  // Arrange — state phiên đã có TRƯỚC khi vào live lần đầu (vd gợi ý còn treo từ mount trước
  // trong CÙNG tab — không có effect nào đồng bộ `suggs` từ session data nên phải giữ nguyên).
  stubBackfill({ "sess-first": [backfillRow(1, "F1")] });
  act(() => {
    useSessionStore.getState().patch({ suggs: [{ id: 1, text: "Gợi ý cũ" }] });
  });

  // Act — vào màn live lần đầu của tab (store chưa gắn với phiên nào)
  const only = renderHook(() => useLiveSession("sess-first"), { wrapper });
  await flushAsync();

  // Assert — vá N5 KHÔNG được cuốn theo dữ liệu đã có sẵn khi gắn phiên lần đầu
  expect(useSessionStore.getState().suggs).toEqual([{ id: 1, text: "Gợi ý cũ" }]);
  expect(useSessionStore.getState().utts.map((u) => u.orig)).toEqual(["F1"]);

  only.unmount();
});
