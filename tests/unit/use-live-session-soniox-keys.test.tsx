import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "@/hooks/use-session";
import { KEY_SERVICE_UNAVAILABLE_MESSAGE } from "@/hooks/live-session/soniox-error-messages";
import { useSessionStore } from "@/stores/session-store";

/**
 * Key Soniox single-use theo connection (plan A P02): key xin SAU khi có quyền capture (TTL 60 s), 1 cặp
 * cho mỗi luồng audio, cặp MỚI mỗi lượt reconnect, KHÔNG renew định kỳ; lỗi server sau connect được nối
 * vào đường degrade/reconnect hoặc fatal thay vì chết câm.
 *
 * Controller giả bắt handler mà `attach` truyền vào để test kích hoạt `onDegraded`/`onFatal` đúng như
 * `SonioxStreamController` thật làm (controller thật có test riêng: use-soniox-server-error.test.ts).
 */

interface FakeHandlers {
  onDegraded?: () => void;
  onFatal?: (kind: string, err: Error) => void;
}
interface FakeController {
  handlers: FakeHandlers;
}

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
    mode: "direct" as "direct" | "online",
    order: [] as string[],
    keyCalls: 0,
    keysError: null as Error | null,
    captureGate: deferred<void>(),
    controllers: [] as Array<{ handlers: Record<string, unknown>; isStopped: boolean }>,
    opened: [] as Array<{ canonical: string; en: string }>,
    reconnected: [] as Array<{ canonical: string; en: string }>,
    onOpen: null as null | ((controller: { handlers: Record<string, unknown> }) => void),
    pcmStops: 0,
    pcmCalls: [] as string[],
    pcmStartError: null as Error | null,
    controllerStops: 0,
    tracksStarted: 0,
    tracksStopped: 0,
  };
});

function fakeMediaStream(): MediaStream {
  hoisted.tracksStarted += 1;
  const track = {
    stop: () => {
      hoisted.tracksStopped += 1;
    },
  };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

vi.mock("@/hooks/use-soniox", () => ({
  SonioxStreamController: class {
    handlers: Record<string, unknown>;
    constructor(opts: { handlers: Record<string, unknown> }) {
      this.handlers = opts.handlers;
      hoisted.controllers.push(this);
    }
    async open(keys: { canonical: string; en: string }) {
      hoisted.opened.push(keys);
      hoisted.onOpen?.(this);
    }
    async reconnect(keys: { canonical: string; en: string }) {
      hoisted.reconnected.push(keys);
      // Controller thật gọi onRestored khi reconnect thành công — bộ chặn vòng lặp dựa vào mốc này.
      (this.handlers.onRestored as (() => void) | undefined)?.();
    }
    isStopped = false;
    async stop() {
      this.isStopped = true;
      hoisted.controllerStops += 1;
    }
    feed() {}
    getEpochConnMs() {
      return 0;
    }
  },
}));

vi.mock("@/lib/audio/capture-direct", () => ({
  startDirectCapture: async () => {
    hoisted.order.push("capture");
    await hoisted.captureGate.promise;
    return fakeMediaStream();
  },
  stopDirectCapture: (stream: MediaStream) => {
    for (const t of stream.getTracks()) t.stop();
  },
}));

vi.mock("@/lib/audio/capture-online", () => ({
  startOnlineCapture: async () => {
    hoisted.order.push("capture");
    return { mic: fakeMediaStream(), tab: fakeMediaStream() };
  },
  stopOnlineCapture: (streams: { mic: MediaStream; tab: MediaStream }) => {
    for (const t of [...streams.mic.getTracks(), ...streams.tab.getTracks()]) t.stop();
  },
  TabAudioTrackMissingError: class extends Error {},
}));

vi.mock("@/lib/audio/pcm-worklet", () => ({
  PcmWorkletCapture: class {
    async start() {
      hoisted.pcmCalls.push("start");
      if (hoisted.pcmStartError) throw hoisted.pcmStartError;
    }
    stop() {
      hoisted.pcmStops += 1;
      hoisted.pcmCalls.push("stop");
    }
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
  fetchSonioxPairKeys: async () => {
    hoisted.order.push("keys");
    hoisted.keyCalls += 1;
    if (hoisted.keysError) throw hoisted.keysError;
    return { canonical: `canon-${hoisted.keyCalls}`, en: `en-${hoisted.keyCalls}` };
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
      data: { id: sessionId, status: "live", mode: hoisted.mode, started_at: STARTED_AT, cap_seconds: 5400 },
    }),
    useEndSession: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
  };
});

const { useLiveSession } = await import("@/hooks/use-live-session");

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  });
}

let sessionCounter = 0;
const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

function mountLive(mode: "direct" | "online") {
  hoisted.mode = mode;
  sessionCounter += 1;
  return renderHook(() => useLiveSession(`sess-keys-${sessionCounter}`), { wrapper });
}

function handlersOf(index: number): FakeController["handlers"] {
  return hoisted.controllers[index].handlers as FakeController["handlers"];
}

beforeEach(() => {
  hoisted.order = [];
  hoisted.keyCalls = 0;
  hoisted.keysError = null;
  hoisted.captureGate = hoisted.deferred<void>();
  hoisted.controllers = [];
  hoisted.opened = [];
  hoisted.reconnected = [];
  hoisted.onOpen = null;
  hoisted.pcmStops = 0;
  hoisted.pcmCalls = [];
  hoisted.pcmStartError = null;
  hoisted.controllerStops = 0;
  hoisted.tracksStarted = 0;
  hoisted.tracksStopped = 0;
  useSessionStore.getState().patch({ toast: "" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("test_live_capture_direct_fetches_pair_keys_only_after_capture_permission_granted", async () => {
  // Arrange — user còn đang ở prompt cấp quyền mic/chia sẻ (getUserMedia chưa resolve)
  const view = mountLive("direct");
  await flushAsync();

  // Assert (trước khi cấp quyền) — CHƯA xin key: TTL 60 s sẽ hết trước khi mở được nếu xin sớm
  expect(hoisted.order).toEqual(["capture"]);
  expect(hoisted.keyCalls).toBe(0);

  // Act — user cấp quyền
  hoisted.captureGate.resolve();
  await flushAsync();

  // Assert — xin ĐÚNG 1 cặp key, sau capture, và stream mở bằng cặp đó
  expect(hoisted.order).toEqual(["capture", "keys"]);
  expect(hoisted.opened).toEqual([{ canonical: "canon-1", en: "en-1" }]);
  view.unmount();
});

test("test_live_capture_online_fetches_two_pairs_and_never_schedules_key_renewal", async () => {
  // Arrange — fake timers TRƯỚC mount để bắt mọi timer renew (mốc cũ: TTL 3600 − 120 s = 58 phút)
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const view = mountLive("online");
  await flushAsync();

  // Assert — 2 request song song SAU capture, mỗi luồng (mic, tab) một cặp riêng
  expect(hoisted.order).toEqual(["capture", "keys", "keys"]);
  expect(hoisted.opened).toEqual([
    { canonical: "canon-1", en: "en-1" },
    { canonical: "canon-2", en: "en-2" },
  ]);

  // Act — trôi qua 58,3 phút (< cap 90'): renew cũ đã bắn ở mốc này
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_500_000);
  });

  // Assert — không xin thêm key nào (không còn renew định kỳ)
  expect(hoisted.keyCalls).toBe(2);
  expect(hoisted.reconnected).toEqual([]);
  view.unmount();
});

test("test_live_session_error_right_after_open_before_runtime_registered_still_reconnects", async () => {
  // Arrange — lỗi server (vd 401 ~230 ms sau connect, E1) đến TRONG lúc `attach` còn đang mở stream, khi
  // runtime CHƯA được đăng ký vào pipeline. Trước đây handler tra `findRuntime(label)` ⇒ trượt ⇒ bỏ qua ⇒ chết câm.
  hoisted.onOpen = (controller) => (controller.handlers as FakeController["handlers"]).onDegraded?.();
  const view = mountLive("direct");
  await flushAsync();

  // Act
  hoisted.captureGate.resolve();
  await flushAsync();

  // Assert — vẫn reconnect, với cặp key MỚI (lần 2), không dùng lại cặp đầu
  expect(hoisted.opened).toEqual([{ canonical: "canon-1", en: "en-1" }]);
  expect(hoisted.reconnected).toEqual([{ canonical: "canon-2", en: "en-2" }]);
  view.unmount();
});

test("test_live_session_reconnect_giveup_after_key_fetch_failures_shows_service_unavailable_toast", async () => {
  // Arrange — stream đang chạy, sau đó rớt; route fail-closed (503) mọi lượt xin key
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  hoisted.keysError = new ApiError("rate_limit_unavailable");
  const pcmStopsBefore = hoisted.pcmStops;

  // Act — rớt kết nối ⇒ reconnectWithBackoff 3 lượt (1 s, 2 s backoff) rồi bỏ cuộc
  act(() => handlersOf(0).onDegraded?.());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });

  // Assert — dừng thu âm luồng đó + toast NÓI RÕ dịch vụ không khả dụng (không "Không bật được micro")
  expect(hoisted.reconnected).toEqual([]);
  expect(hoisted.pcmStops).toBe(pcmStopsBefore + 1);
  expect(useSessionStore.getState().toast).toContain(KEY_SERVICE_UNAVAILABLE_MESSAGE);
  view.unmount();
});

test("test_live_capture_start_when_route_returns_503_stops_opened_capture_and_shows_service_unavailable", async () => {
  // Arrange — capture mở được nhưng route mint key trả 503 rate_limit_unavailable (fail-closed)
  hoisted.keysError = new ApiError("rate_limit_unavailable");
  const view = mountLive("direct");
  hoisted.captureGate.resolve();

  // Act
  await flushAsync();

  // Assert — không stream nào được mở, mic vừa bật được trả sạch, toast đúng nguyên nhân
  expect(hoisted.opened).toEqual([]);
  expect(hoisted.tracksStarted).toBe(1);
  expect(hoisted.tracksStopped).toBe(1);
  expect(useSessionStore.getState().toast).toBe(KEY_SERVICE_UNAVAILABLE_MESSAGE);
  view.unmount();
});

test("test_live_session_fatal_session_expired_stops_pcm_without_duplicate_toast", async () => {
  // Arrange
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  const pcmStopsBefore = hoisted.pcmStops;

  // Act — hết max_session_duration (cap phiên): cap countdown tự kết thúc buổi
  act(() => handlersOf(0).onFatal?.("session_expired", new Error("expired")));

  // Assert — dừng thu âm luồng đó nhưng KHÔNG toast (tránh trùng với cap countdown)
  expect(hoisted.pcmStops).toBe(pcmStopsBefore + 1);
  expect(useSessionStore.getState().toast).toBe("");
  view.unmount();
});

test("test_live_session_fatal_forbidden_stops_pcm_and_shows_access_denied_toast", async () => {
  // Arrange
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  const pcmStopsBefore = hoisted.pcmStops;

  // Act — 403 KHÁC hết duration (thiếu quyền)
  act(() => handlersOf(0).onFatal?.("forbidden", new Error("forbidden")));

  // Assert — khác session_expired: PHẢI có toast, không được chết câm
  expect(hoisted.pcmStops).toBe(pcmStopsBefore + 1);
  expect(useSessionStore.getState().toast).toContain("từ chối quyền truy cập");
  view.unmount();
});

test("test_live_session_pcm_start_failure_stops_the_orphan_controller_and_shows_mic_error", async () => {
  // Arrange — Soniox mở được nhưng worklet lỗi (addModule/AudioContext): controller CHƯA vào pipeline nên
  // closeAllStreamsOnce không đóng nó — nếu attach không tự dọn thì 2 WebSocket rò tới hết max_session_duration
  hoisted.pcmStartError = new Error("addModule failed");
  const view = mountLive("direct");
  hoisted.captureGate.resolve();

  // Act
  await flushAsync();

  // Assert — controller bị stop, mic vừa bật được trả sạch, toast đúng nguyên nhân (lỗi mic)
  expect(hoisted.opened).toHaveLength(1);
  expect(hoisted.controllerStops).toBeGreaterThanOrEqual(1);
  expect(hoisted.tracksStopped).toBe(hoisted.tracksStarted);
  expect(useSessionStore.getState().toast).toContain("Không bật được micro");
  view.unmount();
});

test("test_live_session_fatal_during_open_stops_pcm_before_it_starts", async () => {
  // Arrange — lỗi fatal (403 thiếu quyền) đến TRONG lúc open() còn chạy. pcmCapture phải tồn tại từ trước
  // open() để `stop()` đánh dấu stopped ⇒ `start()` (thật) thành no-op, mic không bật mồ côi.
  hoisted.onOpen = (controller) => (controller.handlers as FakeController["handlers"]).onFatal?.("forbidden", new Error("x"));
  const view = mountLive("direct");
  hoisted.captureGate.resolve();

  // Act
  await flushAsync();

  // Assert — `stop` xảy ra TRƯỚC `start`
  expect(hoisted.pcmCalls.indexOf("stop")).toBeGreaterThanOrEqual(0);
  expect(hoisted.pcmCalls.indexOf("stop")).toBeLessThan(hoisted.pcmCalls.indexOf("start"));
  view.unmount();
});

test("test_live_session_degraded_after_pipeline_disposed_does_not_mint_keys_or_leak_lost_banner", async () => {
  // Arrange — stream chạy bình thường (1 cặp key), rồi user rời màn live
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  const handlers = handlersOf(0);
  expect(hoisted.keyCalls).toBe(1);
  view.unmount();
  useSessionStore.getState().patch({ banner: null });

  // Act — controller còn sót một sự kiện rớt kết nối sau khi pipeline đã đóng
  act(() => handlers.onDegraded?.());
  await flushAsync();

  // Assert — không mint key thật cho pipeline chết, không reconnect, và banner "mất kết nối" (field TOÀN CỤC
  // trong session-store) không rò sang màn kế tiếp
  expect(hoisted.keyCalls).toBe(1);
  expect(hoisted.reconnected).toEqual([]);
  expect(useSessionStore.getState().banner).toBeNull();
});

test("test_live_session_reconnect_stops_silently_when_controller_already_stopped", async () => {
  // Arrange — controller đã stop/fatal nhưng còn một sự kiện degrade trễ
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  hoisted.controllers[0].isStopped = true;

  // Act
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();

  // Assert — không xin key, không reconnect, không toast "mất kết nối" giả
  expect(hoisted.keyCalls).toBe(1);
  expect(hoisted.reconnected).toEqual([]);
  expect(useSessionStore.getState().toast).toBe("");
  view.unmount();
});

test("test_live_session_repeated_quick_degrades_give_up_after_streak_limit_without_minting_more_keys", async () => {
  // Arrange — connection mở được rồi lại rớt/bị từ chối NGAY sau mỗi lần nối (vd 401/429 ~230 ms sau connect):
  // mỗi vòng reconnectWithBackoff có bộ đếm 3 lượt mới nên chỉ guard thất bại-nhanh mới chặn được vòng lặp
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  expect(hoisted.keyCalls).toBe(1);
  const pcmStopsBefore = hoisted.pcmStops;

  // Act + Assert — lần 1: reconnect ngay (chờ 0 s)
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();
  expect(hoisted.reconnected).toHaveLength(1);

  // lần 2: chờ 1 s trước lượt đầu
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();
  expect(hoisted.reconnected).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(hoisted.reconnected).toHaveLength(2);

  // lần 3: chờ 2 s
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1999);
  });
  expect(hoisted.reconnected).toHaveLength(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(hoisted.reconnected).toHaveLength(3);

  // lần 4: bỏ cuộc — không mint thêm key, dừng thu âm luồng đó, toast nói rõ
  const keyCallsBeforeGiveUp = hoisted.keyCalls;
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();
  // Đọc toast TRƯỚC khi tua timer: toast tự tắt sau 2,4 s (session-store)
  expect(useSessionStore.getState().toast).toContain("liên tục bị ngắt hoặc từ chối");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(hoisted.keyCalls).toBe(keyCallsBeforeGiveUp);
  expect(hoisted.reconnected).toHaveLength(3);
  expect(hoisted.pcmStops).toBe(pcmStopsBefore + 1);
  view.unmount();
});

test("test_live_session_connection_stable_for_window_resets_quick_degrade_streak", async () => {
  // Arrange — 1 lần thất bại nhanh, rồi kết nối sống ổn định > 10 s
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();
  expect(hoisted.reconnected).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

  // Act — mạng chập chờn bình thường: rớt sau khi đã ổn định
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();

  // Assert — reset: reconnect NGAY (không chờ 1 s như thất bại nhanh thứ 2)
  expect(hoisted.reconnected).toHaveLength(2);
  view.unmount();
});

test("test_live_session_degrade_right_after_restore_counts_as_quick_even_after_a_long_stable_run", async () => {
  // Arrange — stream chạy ổn định rất lâu, rớt 1 lần (reconnect ngay), rồi nối xong lại bị từ chối NGAY
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const view = mountLive("direct");
  hoisted.captureGate.resolve();
  await flushAsync();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();
  expect(hoisted.reconnected).toHaveLength(1);

  // Act — lỗi đến ngay sau lần restore
  act(() => handlersOf(0).onDegraded?.());
  await flushAsync();

  // Assert — đo "sống được bao lâu" từ lúc RESTORE (không phải từ lần mở đầu cách đó 60 s): thất bại nhanh thứ 2
  // nên phải chờ 1 s trước lượt đầu
  expect(hoisted.reconnected).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(hoisted.reconnected).toHaveLength(2);
  view.unmount();
});
