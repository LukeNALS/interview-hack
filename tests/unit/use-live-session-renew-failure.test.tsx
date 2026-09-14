import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";

/**
 * N2 (wiring) — `TempKeyClient.renew()` ném thì hook PHẢI báo user, không được chết câm.
 * Bug gốc: `renew()` gọi trần trong `void (async () => …)()` KHÔNG catch, và lệnh hẹn lượt
 * renew kế tiếp là câu lệnh CUỐI của chính async đó -> rejection bị nuốt, chuỗi renew dừng,
 * temp key hết hạn vài phút sau, Soniox đóng WS, transcript im lặng GIỮA BUỔI PHỎNG VẤN
 * mà màn hình không đổi gì.
 *
 * Test này khoá phần NỐI DÂY (hook -> banner). Chính sách retry/bỏ cuộc test riêng ở
 * `renew-with-retry.test.ts` (sleep tiêm DI nên chạy tức thì).
 */

const hoisted = vi.hoisted(() => ({
  state: { renewCalls: 0, renewalCb: null as null | (() => void) },
}));

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
    /** Gia hạn HỎNG — đúng tình huống mạng chớp/429 giữa buổi. */
    async renew(): Promise<never> {
      hoisted.state.renewCalls += 1;
      throw new Error("renew failed: network down");
    }
    /** Giữ callback để test tự bắn đúng thời điểm đáo hạn, không phải chờ TTL thật. */
    scheduleRenewal(cb: () => void) {
      hoisted.state.renewalCb = cb;
    }
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
      data: { id: sessionId, status: "live", mode: "direct", started_at: STARTED_AT, cap_seconds: 5400 },
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
  hoisted.state.renewCalls = 0;
  hoisted.state.renewalCb = null;
  useSessionStore.getState().patch({ banner: null });
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
  vi.useRealTimers();
});

test("test_live_session_temp_key_renew_rejection_raises_degraded_banner_instead_of_dying_silently", async () => {
  // Arrange — pipeline chạy, đã hẹn được lượt gia hạn key
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-renew-1"), { wrapper });
  await flushAsync();
  expect(hoisted.state.renewalCb).not.toBeNull();
  expect(useSessionStore.getState().banner).toBeNull();

  // Act — key đáo hạn, renew() ném
  await act(async () => {
    hoisted.state.renewalCb?.();
  });
  await flushAsync();

  // Assert — user THẤY được sự cố (banner vàng), thay vì stream tắt trong im lặng
  expect(hoisted.state.renewCalls).toBeGreaterThanOrEqual(1);
  expect(useSessionStore.getState().banner).toBe("lost");

  view.unmount();
});

test("test_live_session_temp_key_renew_exhausting_all_retries_shows_giveup_toast_from_hook", async () => {
  // Arrange — MEDIUM-2 (code review): `renew-with-retry.test.ts` khoá CHÍNH SÁCH retry, còn
  // đây khoá WIRING: `onGiveUp` trong hook có thật sự bắn toast đúng nội dung không.
  // Fake timer để chạy hết 4 lượt (backoff thật 2s+4s+8s = 14s) mà không chờ 14s thật.
  vi.useFakeTimers();
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const view = renderHook(() => useLiveSession("sess-renew-2"), { wrapper });
  await flushAsync();
  expect(hoisted.state.renewalCb).not.toBeNull();

  // Act — key đáo hạn, renew ném CẢ 4 lượt
  await act(async () => {
    hoisted.state.renewalCb?.();
  });
  // 14_500 > 2000+4000+8000; toast tự ẩn sau TOAST_DURATION_MS=2400 nên còn kịp đọc.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_500);
  });

  // Assert — hết lượt thì user được BÁO bằng chữ, không phải chết câm
  expect(hoisted.state.renewCalls).toBe(4);
  expect(useSessionStore.getState().toast).toContain("Không gia hạn được khoá thu âm");
  expect(useSessionStore.getState().banner).toBe("lost");

  view.unmount();
});
