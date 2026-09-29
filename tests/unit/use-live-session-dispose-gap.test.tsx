import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";

/**
 * M8 — chế độ `online` mở HAI kết nối Soniox tuần tự: `attach("mic")` rồi `attach("tab")`.
 * Có check `pipeline.disposed` TRƯỚC cặp attach và SAU cặp attach, nhưng KHÔNG có ở KHE
 * GIỮA hai lần.
 *
 * Cơ chế chặn HIỆN TẠI (sau khi bỏ lease key dùng chung trong pipeline): cặp key được xin TRƯỚC rồi truyền vào
 * `attach`, nên `attach` KHÔNG còn tự ném khi pipeline đã dispose — chốt `pipeline.disposed` ở KHE GIỮA
 * hai lần attach (`start-capture.ts`) là thứ DUY NHẤT ngăn mở kết nối thứ hai (đốt quota 10 concurrent
 * của org) cho một pipeline đã chết.
 *
 * Tác hại nếu thiếu chốt đó: `attach("tab")` mở thêm 2 WebSocket cho pipeline mồ côi. (Trước đây chốt phụ
 * là lease null làm `attach` ném ⇒ toast lỗi GIẢ "Không bật được micro..."; nay cơ chế đó không còn.)
 * Test khoá cả hai vế: không toast lỗi khi user chỉ rời màn live, và không mở thêm kết nối.
 */

const hoisted = vi.hoisted(() => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  return {
    deferred,
    spy: { openCalls: 0, openGate: deferred<void>() },
  };
});

function fakeMediaStream(): MediaStream {
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
}

vi.mock("@/hooks/use-soniox", () => ({
  SonioxStreamController: class {
    async open() {
      hoisted.spy.openCalls += 1;
      // Chỉ kết nối ĐẦU TIÊN (mic) bị chặn — test chủ động mở cổng để tạo đúng khe dispose.
      if (hoisted.spy.openCalls === 1) await hoisted.spy.openGate.promise;
    }
    async stop() {}
    async reconnect() {}
    feed() {}
    getEpochConnMs() {
      return 0;
    }
  },
}));

vi.mock("@/lib/audio/capture-online", () => ({
  startOnlineCapture: async () => ({ mic: fakeMediaStream(), tab: fakeMediaStream() }),
  stopOnlineCapture: () => {},
  TabAudioTrackMissingError: class extends Error {},
}));

vi.mock("@/lib/audio/capture-direct", () => ({
  startDirectCapture: async () => fakeMediaStream(),
  stopDirectCapture: () => {},
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

vi.mock("@/hooks/live-session/live-session-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/live-session/live-session-api-client")>()),
  // Key single-use xin SAU capture — test không đụng mạng thật.
  fetchSonioxPairKeys: async () => ({ canonical: "k-canonical", en: "k-en" }),
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
    // mode "online" — nhánh DUY NHẤT có 2 lần attach liên tiếp (khe hở M8).
    useSession: (sessionId: string | null) => ({
      data: { id: sessionId, status: "live", mode: "online", started_at: STARTED_AT, cap_seconds: 5400 },
    }),
    useEndSession: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  };
});

const { useLiveSession } = await import("@/hooks/use-live-session");

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  hoisted.spy.openCalls = 0;
  hoisted.spy.openGate = hoisted.deferred<void>();
  useSessionStore.getState().patch({ toast: "" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ utterances: [], next_after_seq: null }) }),
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

test("test_live_session_dispose_between_mic_and_tab_attach_shows_no_spurious_capture_error_toast", async () => {
  // Arrange — mount online; pipeline kẹt ở `attach("mic")` (open đang chờ bắt tay Soniox)
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-gap-1"), { wrapper });
  await flushAsync();
  expect(hoisted.spy.openCalls).toBe(1);

  // Act — user rời màn live ĐÚNG khe giữa 2 lần attach, rồi mic mới bắt tay xong
  view.unmount();
  hoisted.spy.openGate.resolve();
  await flushAsync();

  // Assert — rời màn live là hành vi BÌNH THƯỜNG: không toast lỗi, không mở thêm kết nối
  expect(useSessionStore.getState().toast).toBe("");
  expect(hoisted.spy.openCalls).toBe(1);
});
