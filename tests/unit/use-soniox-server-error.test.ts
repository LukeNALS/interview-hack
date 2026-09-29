import { describe, expect, test, vi } from "vitest";
import { SonioxStreamController } from "@/hooks/use-soniox";
import {
  makeGatedSessionFactory,
  openImmediately,
  pairKeys,
  serverError,
} from "../helpers/gated-soniox-session-factory";

/**
 * Lỗi server Soniox SAU khi `connect()` đã resolve (key single-use dùng lại ⇒ 401, hết
 * `max_session_duration` ⇒ 403...). SDK 2.3.0 chỉ bắn `error` (KHÔNG `disconnected`) rồi tự dọn session,
 * nên controller phải tự phân loại — nếu không stream chết câm dù UI ghi "đang thử lại".
 */

const SESSION_EXPIRED = "temp_api_key_session_expired";

function makeController(handlers: ConstructorParameters<typeof SonioxStreamController>[0]["handlers"]) {
  const { factory, instances } = makeGatedSessionFactory();
  const controller = new SonioxStreamController({ mode: "online", label: "mic", sessionFactory: factory, handlers });
  return { controller, instances };
}

describe("SonioxStreamController — key single-use theo connection", () => {
  test("test_soniox_stream_controller_open_uses_distinct_key_per_connection", async () => {
    // Arrange
    const { controller, instances } = makeController({});

    // Act
    await openImmediately(controller, pairKeys("k1"), instances);

    // Assert — canonical (instances[0]) và en (instances[1]) KHÔNG dùng chung key
    expect(instances.map((i) => i.apiKey)).toEqual(["k1-canonical", "k1-en"]);
  });

  test("test_soniox_stream_controller_reconnect_opens_new_pair_with_fresh_keys", async () => {
    // Arrange
    const { controller, instances } = makeController({});
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.();

    // Act
    const reconnecting = controller.reconnect(pairKeys("k2"));
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnecting;

    // Assert — pair mới mở bằng cặp MỚI, không tái dùng key đã đốt của pair cũ
    expect(instances.slice(2).map((i) => i.apiKey)).toEqual(["k2-canonical", "k2-en"]);
  });
});

describe("SonioxStreamController — lỗi server sau connect, thử lại được", () => {
  test("test_soniox_stream_controller_auth_error_after_connect_marks_degraded_once", async () => {
    // Arrange
    const onDegraded = vi.fn();
    const onFatal = vi.fn();
    const onError = vi.fn();
    const { controller, instances } = makeController({ onDegraded, onFatal, onError });
    await openImmediately(controller, pairKeys("k1"), instances);

    // Act — cả 2 connection cùng nhận 401, rồi WS rớt (disconnected) — như khi mạng/server rớt thật
    instances[0].handlers["error"]?.(serverError(401));
    instances[1].handlers["error"]?.(serverError(401));
    instances[0].handlers["disconnected"]?.();

    // Assert — báo degraded ĐÚNG 1 lần (⇒ reconnect với key mới), không fatal; mọi lỗi đều tới onError để log
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test("test_soniox_stream_controller_error_after_swap_on_current_pair_degrades_again", async () => {
    // Arrange — reconnect xong, pair mới đã là hiện tại
    const onDegraded = vi.fn();
    const onRestored = vi.fn();
    const { controller, instances } = makeController({ onDegraded, onRestored });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.();
    const reconnecting = controller.reconnect(pairKeys("k2"));
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnecting;
    expect(onRestored).toHaveBeenCalledTimes(1);

    // Act — 401 đến ~230 ms SAU connect (E1), lúc pair mới đã được swap vào
    instances[2].handlers["error"]?.(serverError(401));

    // Assert — degrade lần 2 ⇒ caller reconnect tiếp với cặp key mới nữa (không chết câm)
    expect(onDegraded).toHaveBeenCalledTimes(2);
  });

  test("test_soniox_stream_controller_error_from_swapped_out_connection_is_ignored", async () => {
    // Arrange
    const onDegraded = vi.fn();
    const onFatal = vi.fn();
    const { controller, instances } = makeController({ onDegraded, onFatal });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.(); // degraded lần 1 (rớt thật)
    const reconnecting = controller.reconnect(pairKeys("k2"));
    instances[2].resolveConnect();
    instances[3].resolveConnect();
    await reconnecting;

    // Act — pair CŨ (đã swap ra) báo lỗi muộn, kể cả loại fatal
    instances[0].handlers["error"]?.(serverError(403, SESSION_EXPIRED));
    instances[1].handlers["error"]?.(serverError(401));

    // Assert — không thêm degraded, không fatal: lỗi của connection cũ không được phá pair đang chạy
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  test("test_soniox_stream_controller_error_on_new_pair_before_swap_rejects_reconnect_without_swap", async () => {
    // Arrange — mất kết nối, đang reconnect
    const onRestored = vi.fn();
    const { controller, instances } = makeController({ onRestored });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.();
    const reconnecting = controller.reconnect(pairKeys("k2"));
    const attempt = expect(reconnecting).rejects.toMatchObject({ statusCode: 401 });

    // Act — canonical MỚI nhận 401 khi en MỚI còn đang mở (chưa swap ⇒ handler bỏ qua lỗi này)
    instances[2].resolveConnect();
    instances[2].handlers["error"]?.(serverError(401));
    instances[3].resolveConnect();

    // Assert — reconnect() ném để backoff xin cặp key MỚI; không swap, không báo restored, pair hỏng bị đóng
    await attempt;
    expect(onRestored).not.toHaveBeenCalled();
    expect(instances[2].closed).toBe(true);
    expect(instances[3].closed).toBe(true);
  });
});

describe("SonioxStreamController — lỗi server sau connect, KHÔNG thử lại được", () => {
  test("test_soniox_stream_controller_session_expired_error_reports_fatal_without_degraded", async () => {
    // Arrange
    const onDegraded = vi.fn();
    const onFatal = vi.fn();
    const { controller, instances } = makeController({ onDegraded, onFatal });
    await openImmediately(controller, pairKeys("k1"), instances);

    // Act — hết max_session_duration: cả 2 connection bị server cắt cứng cùng lúc
    const expired = serverError(403, SESSION_EXPIRED);
    instances[0].handlers["error"]?.(expired);
    instances[1].handlers["error"]?.(expired);

    // Assert — fatal ĐÚNG 1 lần với loại session_expired, KHÔNG degrade (không reconnect vô ích)
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith("session_expired", expired);
    expect(onDegraded).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(instances.every((i) => i.closed)).toBe(true));
  });

  test("test_soniox_stream_controller_forbidden_error_reports_fatal_forbidden_without_degraded", async () => {
    // Arrange
    const onDegraded = vi.fn();
    const onFatal = vi.fn();
    const { controller, instances } = makeController({ onDegraded, onFatal });
    await openImmediately(controller, pairKeys("k1"), instances);

    // Act — 403 KHÁC (không phải hết duration): thiếu quyền
    const forbidden = serverError(403, "some_other_forbidden_reason");
    instances[0].handlers["error"]?.(forbidden);

    // Assert — phân biệt với session_expired: loại forbidden ⇒ caller PHẢI hiện toast
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith("forbidden", forbidden);
    expect(onDegraded).not.toHaveBeenCalled();
  });

  test("test_soniox_stream_controller_quota_error_reports_fatal_quota", async () => {
    // Arrange
    const onFatal = vi.fn();
    const { controller, instances } = makeController({ onFatal });
    await openImmediately(controller, pairKeys("k1"), instances);

    // Act
    instances[1].handlers["error"]?.(serverError(429));

    // Assert
    expect(onFatal).toHaveBeenCalledWith("quota", expect.anything());
  });

  test("test_soniox_stream_controller_feed_after_fatal_buffers_without_touching_dead_connections", async () => {
    // Arrange — sau fatal SDK đã dọn session: sendAudio thật sẽ ném StateError
    const { controller, instances } = makeController({ onFatal: vi.fn() });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["error"]?.(serverError(403, SESSION_EXPIRED));

    // Act — pcm worklet còn bơm vài chunk trước khi caller kịp dừng
    expect(() => controller.feed(new Uint8Array([1, 2]).buffer, 1000)).not.toThrow();

    // Assert — chunk KHÔNG tới connection đã chết
    expect(instances[0].sentChunks).toHaveLength(0);
    expect(instances[1].sentChunks).toHaveLength(0);
  });

  test("test_soniox_stream_controller_error_on_new_pair_before_swap_fatal_class_reports_fatal_without_swap", async () => {
    // Arrange
    const onFatal = vi.fn();
    const onRestored = vi.fn();
    const { controller, instances } = makeController({ onFatal, onRestored });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.();
    const reconnecting = controller.reconnect(pairKeys("k2"));

    // Act — pair mới nhận 403 thiếu quyền trước khi swap
    instances[2].resolveConnect();
    instances[2].handlers["error"]?.(serverError(403));
    instances[3].resolveConnect();
    await reconnecting;

    // Assert — không thử lại được ⇒ fatal (reconnect() resolve, backoff không lặp vô ích), không restored
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith("forbidden", expect.anything());
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe("SonioxStreamController — dọn dẹp khi mở dở", () => {
  test("test_soniox_stream_controller_open_when_one_connection_fails_closes_the_other_and_stays_inert", async () => {
    // Arrange — canonical lên được, en timeout: open() ném, canonical WS mở mãi nếu không ai đóng
    const onDegraded = vi.fn();
    const { controller, instances } = makeController({ onDegraded });
    const opening = controller.open(pairKeys("k1"));
    const failure = expect(opening).rejects.toThrow("en connect timeout");
    instances[0].resolveConnect();
    instances[1].rejectConnect(new Error("en connect timeout"));

    // Act
    await failure;

    // Assert — cả 2 connection bị đóng, và close() tự bắn `disconnected` KHÔNG kích hoạt degrade/reconnect
    expect(instances.every((i) => i.closed)).toBe(true);
    expect(onDegraded).not.toHaveBeenCalled();
    expect(controller.isStopped).toBe(true);
  });

  test("test_soniox_stream_controller_reconnect_when_one_new_connection_fails_closes_both_new_connections", async () => {
    // Arrange — mất kết nối rồi reconnect: pair mới lên dở
    const onDegraded = vi.fn();
    const { controller, instances } = makeController({ onDegraded });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.();
    expect(onDegraded).toHaveBeenCalledTimes(1);
    const reconnecting = controller.reconnect(pairKeys("k2"));
    const failure = expect(reconnecting).rejects.toThrow("en connect timeout");

    // Act
    instances[2].resolveConnect();
    instances[3].rejectConnect(new Error("en connect timeout"));
    await failure;

    // Assert — không rò socket của pair mới; pair cũ vẫn là hiện tại (caller retry với cặp key khác)
    expect(instances[2].closed).toBe(true);
    expect(instances[3].closed).toBe(true);
    expect(controller.isStopped).toBe(false);
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });
});

describe("SonioxStreamController — chọn lỗi khi cả 2 connection của pair mới đều hỏng", () => {
  test("test_soniox_stream_controller_new_pair_with_retry_and_fatal_errors_reports_the_fatal_one", async () => {
    // Arrange — canonical mới nhận 401 (retry) nhưng en mới nhận 403 thiếu quyền (fatal)
    const onFatal = vi.fn();
    const { controller, instances } = makeController({ onFatal });
    await openImmediately(controller, pairKeys("k1"), instances);
    instances[0].handlers["disconnected"]?.();
    const reconnecting = controller.reconnect(pairKeys("k2"));

    // Act
    instances[2].resolveConnect();
    instances[2].handlers["error"]?.(serverError(401));
    instances[3].resolveConnect();
    instances[3].handlers["error"]?.(serverError(403));
    await reconnecting;

    // Assert — không che lỗi fatal bằng lỗi retry của connection kia (nếu che: thử lại vô ích rồi mới gặp fatal)
    expect(onFatal).toHaveBeenCalledWith("forbidden", expect.anything());
  });
});
