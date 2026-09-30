import { describe, expect, test, vi } from "vitest";
import { SonioxStreamController } from "@/hooks/use-soniox";
import type { SonioxSessionFactory } from "@/lib/soniox/connection";
import { makeGatedSessionFactory, openImmediately, pairKeys } from "../helpers/gated-soniox-session-factory";

/**
 * Code review C1 fix — coverage cho `SonioxStreamController.reconnect()` giờ ĐÃ được wire
 * (trước fix: 0 call site, banner vàng vĩnh viễn khi rớt Soniox WS giữa buổi). Key single-use: mỗi
 * connection một key riêng, mỗi lượt reconnect một cặp MỚI (`pairKeys`).
 *
 * Fake session factory (gate thủ công cho connect()) ở `tests/helpers/gated-soniox-session-factory.ts`.
 */

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
    await openImmediately(controller, pairKeys("initial"), instances);

    // Act — rớt kết nối NGOÀI Ý MUỐN (canonical = instances[0]) -> banner degraded
    instances[0].handlers["disconnected"]?.();
    expect(onDegraded).toHaveBeenCalledTimes(1);

    // reconnect() với cặp key MỚI (caller xin lại từ route) -> mở pair mới + swap
    const reconnectPromise = controller.reconnect(pairKeys("fresh"));
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnectPromise;

    // Assert — banner restored bắn TRONG reconnect() khi thành công, pair mới dùng key mới
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(instances[2].apiKey).toBe("fresh-canonical");
    expect(instances[3].apiKey).toBe("fresh-en");
  });

  test("test_soniox_stream_controller_reconnect_does_not_drop_chunks_fed_while_awaiting_ready", async () => {
    // Arrange — bug thứ cấp đã fix: drain() trước đây chạy TRƯỚC await openAllReady(), khiến
    // chunk tới trong lúc chờ ready (vẫn degraded=true nên vẫn buffer) bị bỏ sót vĩnh viễn.
    vi.spyOn(Date, "now").mockReturnValue(1100); // đồng hồ khớp captureTs giả (1000/1050): replay chỉ lấy audio trong 30 s gần nhất
    const { factory, instances } = makeGatedSessionFactory();
    const onCanonicalFinal = vi.fn();
    const controller = new SonioxStreamController({ mode: "online", label: "mic", sessionFactory: factory, handlers: { onCanonicalFinal } });
    await openImmediately(controller, pairKeys("initial"), instances);

    instances[0].handlers["disconnected"]?.(); // rớt -> feed() giờ buffer RAM, không fan-out
    const chunkBeforeAwait = new Uint8Array([1, 1, 1, 1]).buffer;
    controller.feed(chunkBeforeAwait, 1000);

    // Act — reconnect() bắt đầu mở pair mới, NHƯNG connect() bị treo (gate chưa resolve)
    const reconnectPromise = controller.reconnect(pairKeys("fresh"));

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
    // Mốc tuyệt đối của pair MỚI = epoch_conn (capture_ts chunk đầu = 1000) + start tương đối của token.
    instances[2].handlers["token"]?.({ text: "x", is_final: true, start_ms: 500, end_ms: 900 });
    instances[2].handlers["endpoint"]?.();
    expect(onCanonicalFinal).toHaveBeenCalledWith(expect.objectContaining({ startAbsMs: 1500, endAbsMs: 1900 }));
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
    await openImmediately(controller, pairKeys("key"), instances);

    // Act — đóng chủ động (endInterview()/unmount); fake session's close() TỰ bắn "disconnected"
    // (worst-case SDK thật) — controller phải lọc qua `stopped`, KHÔNG coi là rớt thật.
    await controller.stop();

    // Assert
    expect(onDegraded).not.toHaveBeenCalled();
  });

  test("test_soniox_stream_controller_reconnect_swap_ignores_late_disconnect_from_old_connection", async () => {
    // Arrange — reconnect() swap pair mới; pair CŨ bị đóng trễ (overlap 1s, xem swapConnections())
    // không được coi là rớt thật (stale-connection guard).
    const { factory, instances } = makeGatedSessionFactory();
    const onDegraded = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onDegraded },
    });
    await openImmediately(controller, pairKeys("key-1"), instances);
    instances[0].handlers["disconnected"]?.(); // rớt thật lần đầu -> degraded (1 lần)
    const oldCanonical = instances[0];

    // Act
    const reconnectPromise = controller.reconnect(pairKeys("key-2"));
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnectPromise;
    oldCanonical.handlers["disconnected"]?.(); // pair cũ rớt/đóng trễ sau khi đã bị swap ra

    // Assert — chỉ lần rớt thật đầu tiên được tính, lần đóng trễ của pair cũ KHÔNG
    expect(onDegraded).toHaveBeenCalledTimes(1);
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
    await openImmediately(controller, pairKeys("key"), instances);
    instances[0].handlers["disconnected"]?.();
    shouldFail = true;

    // Act + Assert — reconnect() lặp lại 3 lần đều reject (mô phỏng 3 lần thử của reconnectWithBackoff)
    await expect(controller.reconnect(pairKeys("retry-1"))).rejects.toThrow("network still down");
    await expect(controller.reconnect(pairKeys("retry-2"))).rejects.toThrow("network still down");
    await expect(controller.reconnect(pairKeys("retry-3"))).rejects.toThrow("network still down");
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("SonioxStreamController — code review round 2 NEW-1 fix: stop() giữa lúc reconnect() đang await openAllReady()", () => {
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
    await openImmediately(controller, pairKeys("initial"), instances);
    instances[0].handlers["disconnected"]?.(); // rớt ngoài ý muốn -> degraded

    // Act — reconnect() bắt đầu mở pair mới (instances[2]/[3]), gate CHƯA resolve
    const reconnectPromise = controller.reconnect(pairKeys("fresh"));

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
});
