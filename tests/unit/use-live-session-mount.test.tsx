import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * BUG #3 (P0) — vào /live bằng điều hướng client-side (router.push từ /setup) làm
 * `LiveScreen` MOUNT 2 LẦN (guard bounce prep→live→prep→live khi cache react-query
 * còn status='prep'), mỗi mount là 1 INSTANCE mới nên `setupDoneRef` (ref theo
 * instance) không chặn được, còn cleanup của mount đầu thì no-op vì `streamsRef`
 * lúc đó CÒN RỖNG (`startCapture` vẫn đang await) -> 2 pipeline chạy song song:
 * transcript nhân đôi + hoá đơn Soniox gấp đôi.
 *
 * Test đo "pipeline CÒN SỐNG" = số controller đã open trừ số controller đã stop.
 */

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Đếm vòng đời pipeline dùng chung cho mọi mock (reset ở beforeEach). */
const spy = {
  opened: 0,
  stopped: 0,
  micStreamsStarted: 0,
  micTracksStopped: 0,
  captureGate: deferred<void>(),
};

function fakeMediaStream(): MediaStream {
  const track = {
    stop: () => {
      spy.micTracksStopped += 1;
    },
  };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

vi.mock("@/hooks/use-soniox", () => ({
  SonioxStreamController: class {
    async open() {
      spy.opened += 1;
    }
    async stop() {
      spy.stopped += 1;
    }
    async reconnect() {}
    async renew() {}
    feed() {}
    getEpochConnMs() {
      return 0;
    }
  },
}));

vi.mock("@/lib/audio/capture-direct", () => ({
  startDirectCapture: async () => {
    spy.micStreamsStarted += 1;
    await spy.captureGate.promise;
    return fakeMediaStream();
  },
  stopDirectCapture: (stream: MediaStream) => {
    for (const t of stream.getTracks()) t.stop();
  },
}));

vi.mock("@/lib/audio/capture-online", () => ({
  startOnlineCapture: async () => ({ mic: fakeMediaStream(), tab: fakeMediaStream() }),
  stopOnlineCapture: (streams: { mic: MediaStream; tab: MediaStream }) => {
    for (const t of [...streams.mic.getTracks(), ...streams.tab.getTracks()]) t.stop();
  },
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
        // started_at phải là "vừa mới bắt đầu" (mốc quá khứ cố định sẽ vượt cap 90'
        // -> useCapCountdown gọi endInterview đóng pipeline ngay khi mount) VÀ phải ổn
        // định giữa các render (nó là dep của effect setup).
        started_at: STARTED_AT,
        cap_seconds: 5400,
      },
    }),
    useEndSession: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  };
});

const { useLiveSession } = await import("@/hooks/use-live-session");

/** Nhường event loop cho chuỗi await trong setup pipeline (backfill -> key -> capture). */
async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

let sessionCounter = 0;
function nextSessionId(): string {
  sessionCounter += 1;
  return `sess-mount-${sessionCounter}`;
}

beforeEach(() => {
  spy.opened = 0;
  spy.stopped = 0;
  spy.micStreamsStarted = 0;
  spy.micTracksStopped = 0;
  spy.captureGate = deferred<void>();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ utterances: [], next_after_seq: null }),
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

test("test_live_session_remount_after_unmount_mid_start_capture_leaves_exactly_one_pipeline", async () => {
  // Arrange — mount #1 dừng lại đúng lúc `startCapture` còn đang await getUserMedia
  const sessionId = nextSessionId();
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const first = renderHook(() => useLiveSession(sessionId), { wrapper });
  await flushAsync();

  // Act — client-side nav: instance #1 unmount giữa chừng rồi instance #2 mount lại
  first.unmount();
  const second = renderHook(() => useLiveSession(sessionId), { wrapper });
  await flushAsync();
  spy.captureGate.resolve();
  await flushAsync();

  // Assert — chỉ CÒN 1 pipeline sống (mọi pipeline mồ côi phải bị đóng)
  expect(spy.opened - spy.stopped).toBe(1);
  expect(spy.micStreamsStarted - spy.micTracksStopped).toBe(1);

  second.unmount();
});

test("test_live_session_second_concurrent_mount_reuses_running_pipeline", async () => {
  // Arrange — 2 instance cùng session sống song song (mount mới trước khi cái cũ unmount)
  const sessionId = nextSessionId();
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const first = renderHook(() => useLiveSession(sessionId), { wrapper });
  await flushAsync();
  spy.captureGate.resolve();
  await flushAsync();

  // Act — instance #2 mount trong lúc #1 còn sống, sau đó #1 mới unmount
  const second = renderHook(() => useLiveSession(sessionId), { wrapper });
  await flushAsync();
  first.unmount();
  await flushAsync();

  // Assert — KHÔNG mở pipeline thứ 2; pipeline đang chạy vẫn sống cho instance còn lại
  expect(spy.opened).toBe(1);
  expect(spy.opened - spy.stopped).toBe(1);

  second.unmount();
});

test("test_live_session_unmount_during_start_capture_closes_orphan_pipeline", async () => {
  // Arrange — unmount xảy ra khi `startCapture` chưa gán xong stream (cửa sổ race cũ)
  const sessionId = nextSessionId();
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  const only = renderHook(() => useLiveSession(sessionId), { wrapper });
  await flushAsync();

  // Act
  only.unmount();
  spy.captureGate.resolve();
  await flushAsync();

  // Assert — không còn pipeline mồ côi nào chạy tiếp (mic + Soniox phải đóng)
  expect(spy.opened - spy.stopped).toBe(0);
  expect(spy.micStreamsStarted - spy.micTracksStopped).toBe(0);
});
