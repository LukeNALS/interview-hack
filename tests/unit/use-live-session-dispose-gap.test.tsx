import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";

/**
 * M8 — chế độ `online` mở HAI kết nối Soniox tuần tự: `attach("mic")` rồi `attach("tab")`.
 * Có check `pipeline.disposed` TRƯỚC cặp attach và SAU cặp attach, nhưng KHÔNG có ở KHE
 * GIỮA hai lần.
 *
 * ⚠️ ĐÍNH CHÍNH mô tả nợ trong `docs/security-notes.md` §7 (bản trước ghi "vẫn mở thêm 2
 * WebSocket -> đốt quota 10 concurrent"): SAI. `disposeLivePipeline` set
 * `pipeline.tempKeyClient = null`, mà `attach` đọc lease từ `pipeline.tempKeyClient
 * ?.currentLease` NGAY TRƯỚC `controller.open()` (constructor chỉ dựng wrapper, chưa mở
 * socket) -> attach thứ hai NÉM trước khi mở được kết nối nào. KHÔNG có rò WebSocket.
 *
 * Tác hại THẬT của khe hở: exception đó rơi vào catch của mount effect -> bắn TOAST LỖI GIẢ
 * "Không bật được micro/chia sẻ âm thanh — thử lại" trong khi user chỉ đơn giản rời màn live.
 * Toast hiện trên màn KẾ TIẾP, khiến người dùng tưởng thu âm hỏng. Test khoá đúng vế này,
 * kèm bất biến "không mở thêm kết nối" để đề phòng ai đó đổi thứ tự lấy lease trong `attach`.
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
    async renew() {}
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
