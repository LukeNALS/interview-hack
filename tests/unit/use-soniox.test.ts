import { describe, expect, test, vi } from "vitest";
import { SonioxStreamController } from "@/hooks/use-soniox";
import type { SonioxSessionFactory, SonioxSessionLike } from "@/lib/soniox/connection";

/**
 * Code review C1 fix — coverage cho `SonioxStreamController.reconnect()` giờ ĐÃ được wire
 * (trước fix: 0 call site, banner vàng vĩnh viễn khi rớt Soniox WS giữa buổi).
 *
 * Fake session factory KHÔNG dùng chung với soniox-connection.test.ts vì cần kiểm soát ĐƯỢC
 * thời điểm connect() resolve (gate thủ công) để test đúng bug thứ cấp "drain() chạy trước
 * await openAllReady() -> mất chunk tới trong lúc chờ ready".
 */
function makeGatedSessionFactory() {
  const instances: Array<{
    apiKey: string;
    sentChunks: Uint8Array[];
    closed: boolean;
    handlers: Record<string, (...args: unknown[]) => void>;
    resolveConnect: () => void;
  }> = [];

  const factory: SonioxSessionFactory = (_config, apiKey) => {
    let resolveConnect!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const record = {
      apiKey,
      sentChunks: [] as Uint8Array[],
      closed: false,
      handlers: {} as Record<string, (...args: unknown[]) => void>,
      resolveConnect,
    };
    instances.push(record);
    const session: SonioxSessionLike = {
      async connect() {
        await gate;
      },
      sendAudio(data) {
        record.sentChunks.push(data as Uint8Array);
      },
      async finish() {},
      close() {
        record.closed = true;
        // Mô phỏng worst-case: SDK thật CÓ THỂ tự bắn "disconnected" ngay cả khi đóng chủ
        // động (chưa verify với SDK Soniox thật — code review Unresolved #3). Controller
        // PHẢI tự lọc qua guard stopped/stale-connection, không được dựa vào SDK "tử tế".
        record.handlers["disconnected"]?.();
      },
      on(event, handler) {
        record.handlers[event] = handler as (...args: unknown[]) => void;
        return session;
      },
    };
    return session;
  };

  return { factory, instances };
}

type Instances = ReturnType<typeof makeGatedSessionFactory>["instances"];

/** open() tạo 2 instance MỚI (canonical rồi en, đồng bộ trước await connect() đầu tiên) —
 *  mở khoá cả 2 gate rồi await cho xong. */
async function openImmediately(controller: SonioxStreamController, apiKey: string, instances: Instances): Promise<void> {
  const before = instances.length;
  const opened = controller.open(apiKey);
  instances[before].resolveConnect();
  instances[before + 1].resolveConnect();
  await opened;
}

describe("SonioxStreamController — C1 fix: reconnect() wired cho disconnect ngoài ý muốn", () => {
  test("test_soniox_stream_controller_unintentional_disconnect_reconnects_and_restores_banner", async () => {
    // Arrange
    const { factory, instances } = makeGatedSessionFactory();
    const onDegraded = vi.fn();
    const onRestored = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onDegraded, onRestored },
    });
    await openImmediately(controller, "initial-key", instances);

    // Act — rớt kết nối NGOÀI Ý MUỐN (canonical = instances[0]) -> banner degraded
    instances[0].handlers["disconnected"]?.();
    expect(onDegraded).toHaveBeenCalledTimes(1);

    // reconnect() với key mới (caller xin lease hiện có/renew) -> mở pair mới + swap
    const reconnectPromise = controller.reconnect("fresh-key");
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnectPromise;

    // Assert — banner restored bắn TRONG reconnect() khi thành công, pair mới dùng key mới
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(instances[2].apiKey).toBe("fresh-key");
    expect(instances[3].apiKey).toBe("fresh-key");
  });

  test("test_soniox_stream_controller_reconnect_does_not_drop_chunks_fed_while_awaiting_ready", async () => {
    // Arrange — bug thứ cấp đã fix: drain() trước đây chạy TRƯỚC await openAllReady(), khiến
    // chunk tới trong lúc chờ ready (vẫn degraded=true nên vẫn buffer) bị bỏ sót vĩnh viễn.
    const { factory, instances } = makeGatedSessionFactory();
    const controller = new SonioxStreamController({ mode: "online", label: "mic", sessionFactory: factory, handlers: {} });
    await openImmediately(controller, "initial-key", instances);

    instances[0].handlers["disconnected"]?.(); // rớt -> feed() giờ buffer RAM, không fan-out
    const chunkBeforeAwait = new Uint8Array([1, 1, 1, 1]).buffer;
    controller.feed(chunkBeforeAwait, 1000);

    // Act — reconnect() bắt đầu mở pair mới, NHƯNG connect() bị treo (gate chưa resolve)
    const reconnectPromise = controller.reconnect("fresh-key");

    // Trong lúc đang await openAllReady() (degraded vẫn true suốt hàm reconnect()) — chunk khác tới
    const chunkDuringAwait = new Uint8Array([2, 2, 2, 2]).buffer;
    controller.feed(chunkDuringAwait, 1050);

    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnectPromise;

    // Assert — CẢ 2 chunk được replay, ĐÚNG thứ tự, trên pair MỚI; epoch_conn = capture_ts
    // chunk ĐẦU (1000, fix B13 không đổi dù bug thứ cấp đã fix)
    expect(instances[2].sentChunks.map((c) => Array.from(c))).toEqual([
      [1, 1, 1, 1],
      [2, 2, 2, 2],
    ]);
    expect(instances[3].sentChunks.map((c) => Array.from(c))).toEqual([
      [1, 1, 1, 1],
      [2, 2, 2, 2],
    ]);
    expect(controller.getEpochConnMs()).toBe(1000);
  });

  test("test_soniox_stream_controller_intentional_stop_does_not_trigger_reconnect", async () => {
    // Arrange
    const { factory, instances } = makeGatedSessionFactory();
    const onDegraded = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onDegraded },
    });
    await openImmediately(controller, "key", instances);

    // Act — đóng chủ động (endInterview()/unmount); fake session's close() TỰ bắn "disconnected"
    // (worst-case SDK thật) — controller phải lọc qua `stopped`, KHÔNG coi là rớt thật.
    await controller.stop();

    // Assert
    expect(onDegraded).not.toHaveBeenCalled();
  });

  test("test_soniox_stream_controller_renew_swap_ignores_late_disconnect_from_old_connection", async () => {
    // Arrange — renew() (key TTL, KHÔNG phải rớt kết nối) swap pair mới; pair CŨ bị đóng trễ
    // (overlap 1s, xem swapConnections()) không được coi là rớt thật (stale-connection guard).
    const { factory, instances } = makeGatedSessionFactory();
    const onDegraded = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onDegraded },
    });
    await openImmediately(controller, "key-1", instances);
    const oldCanonical = instances[0];

    // Act
    const renewPromise = controller.renew("key-2");
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await renewPromise;
    oldCanonical.handlers["disconnected"]?.(); // pair cũ rớt/đóng trễ sau khi đã bị swap ra

    // Assert
    expect(onDegraded).not.toHaveBeenCalled();
  });

  test("test_soniox_stream_controller_reconnect_rejects_when_opening_new_pair_fails", async () => {
    // Arrange — mạng vẫn down, mở pair mới cũng fail -> reconnect() PHẢI reject (không nuốt lỗi
    // im lặng) để caller (use-live-session's reconnectWithBackoff, test riêng) retry/give-up đúng.
    const { factory, instances } = makeGatedSessionFactory();
    let shouldFail = false;
    const flakyFactory: SonioxSessionFactory = (config, apiKey) => {
      if (shouldFail) throw new Error("network still down");
      return factory(config, apiKey);
    };
    const onRestored = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: flakyFactory,
      handlers: { onRestored },
    });
    await openImmediately(controller, "key", instances);
    instances[0].handlers["disconnected"]?.();
    shouldFail = true;

    // Act + Assert — reconnect() lặp lại 3 lần đều reject (mô phỏng 3 lần thử của reconnectWithBackoff)
    await expect(controller.reconnect("retry-1")).rejects.toThrow("network still down");
    await expect(controller.reconnect("retry-2")).rejects.toThrow("network still down");
    await expect(controller.reconnect("retry-3")).rejects.toThrow("network still down");
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("SonioxStreamController — code review round 2 NEW-1 fix: stop() giữa lúc reconnect()/renew() đang await openAllReady()", () => {
  test("test_soniox_stream_controller_stop_during_reconnect_await_closes_new_pair_without_swap", async () => {
    // Arrange — mô phỏng endInterview()/unmount (stop()) xảy ra ĐÚNG lúc reconnectWithBackoff
    // còn in-flight (network hồi phục trễ hơn thời điểm user kết thúc buổi). Trước fix NEW-1,
    // pair mới (instances[2]/[3]) không bao giờ bị đóng -> leak WebSocket Soniox.
    const { factory, instances } = makeGatedSessionFactory();
    const onRestored = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onRestored },
    });
    await openImmediately(controller, "initial-key", instances);
    instances[0].handlers["disconnected"]?.(); // rớt ngoài ý muốn -> degraded

    // Act — reconnect() bắt đầu mở pair mới (instances[2]/[3]), gate CHƯA resolve
    const reconnectPromise = controller.reconnect("fresh-key");

    // stop() (endInterview()/unmount) xảy ra TRONG lúc reconnect() còn await openAllReady()
    await controller.stop();

    // Mạng hồi phục TRỄ hơn -> gate của pair mới mới resolve sau khi đã stop()
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnectPromise;

    // Assert — pair mới PHẢI bị đóng ngay, KHÔNG swap vào, KHÔNG bắn onRestored (fix NEW-1)
    expect(instances[2].closed).toBe(true);
    expect(instances[3].closed).toBe(true);
    expect(onRestored).not.toHaveBeenCalled();
  });

  test("test_soniox_stream_controller_stop_during_renew_await_closes_new_pair_without_swap", async () => {
    // Arrange — cùng shape race cho renew() (TTL key rotation) — stop() xảy ra giữa await.
    const { factory, instances } = makeGatedSessionFactory();
    const controller = new SonioxStreamController({ mode: "online", label: "mic", sessionFactory: factory, handlers: {} });
    await openImmediately(controller, "key-1", instances);

    // Act — renew() bắt đầu mở pair mới (instances[2]/[3]), gate CHƯA resolve
    const renewPromise = controller.renew("key-2");

    // stop() xảy ra TRONG lúc renew() còn await openAllReady()
    await controller.stop();

    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await renewPromise;

    // Assert — pair mới PHẢI bị đóng ngay, KHÔNG swap vào
    expect(instances[2].closed).toBe(true);
    expect(instances[3].closed).toBe(true);
  });
});
