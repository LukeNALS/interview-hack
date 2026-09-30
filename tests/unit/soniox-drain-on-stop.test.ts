import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RealtimeToken, SttSessionConfig } from "@soniox/client";
import { SonioxStreamController, type CanonicalSegment, type EnSegment } from "@/hooks/use-soniox";
import { SonioxConnection, type SonioxSessionFactory, type SonioxSessionLike } from "@/lib/soniox/connection";
import { makeGatedSessionFactory, openImmediately, pairKeys, type GatedInstance } from "../helpers/gated-soniox-session-factory";

/**
 * Audit #7 — kết thúc buổi phải DRAIN: `finish()` từng connection (có timeout) để câu đang nói + bản dịch về kịp,
 * chốt accumulator cả khi chỉ có `finished` mà không có `endpoint` (E7), rồi mới đóng. Không bao giờ ném hay treo.
 */

const EPOCH = 1_000_000;
const CHUNK = new Uint8Array([1, 2]).buffer;
const DUMMY_CONFIG: SttSessionConfig = { model: "stt-rt-v5" };

function token(text: string, extra: Partial<RealtimeToken> = {}): RealtimeToken {
  return { text, is_final: true, start_ms: 0, end_ms: 1000, ...extra } as RealtimeToken;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Date, "now").mockReturnValue(EPOCH);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SonioxConnection.drain", () => {
  function connectionWith(finish: () => Promise<void>) {
    const state = { closed: false };
    const factory: SonioxSessionFactory = () => {
      const session: SonioxSessionLike = {
        async connect() {},
        sendAudio() {},
        finish,
        close() {
          state.closed = true;
        },
        on() {
          return session;
        },
      };
      return session;
    };
    return { conn: new SonioxConnection({ config: DUMMY_CONFIG, label: "t", sessionFactory: factory }), state };
  }

  test("test_soniox_connection_drain_when_finish_resolves_closes_after_finished", async () => {
    // Arrange
    let resolveFinish!: () => void;
    const { conn, state } = connectionWith(() => new Promise<void>((resolve) => (resolveFinish = resolve)));
    await conn.open("key");

    // Act
    const draining = conn.drain(2000);
    await Promise.resolve();
    expect(state.closed).toBe(false); // còn chờ `finished`
    resolveFinish();
    await draining;

    // Assert
    expect(state.closed).toBe(true);
  });

  test("test_soniox_connection_drain_when_finish_hangs_closes_after_timeout", async () => {
    // Arrange — mạng Soniox treo: finish() không bao giờ resolve (SDK không có timeout riêng)
    const { conn, state } = connectionWith(() => new Promise<void>(() => {}));
    await conn.open("key");

    // Act
    const draining = conn.drain(2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await draining;

    // Assert
    expect(state.closed).toBe(true);
  });

  test("test_soniox_connection_drain_when_session_already_errored_does_not_throw", async () => {
    // Arrange — session đã chết vì lỗi server: SDK ném StateError ở finish()
    const { conn, state } = connectionWith(() => Promise.reject(new Error('StateError: session is in "error" state')));
    await conn.open("key");

    // Act + Assert
    await expect(conn.drain(2000)).resolves.toBeUndefined();
    expect(state.closed).toBe(true);
  });

  test("test_soniox_connection_drain_before_open_does_not_throw", async () => {
    // Arrange
    const { conn } = connectionWith(async () => {});

    // Act + Assert
    await expect(conn.drain(2000)).resolves.toBeUndefined();
  });
});

describe("SonioxStreamController — drain khi dừng", () => {
  function setup(finish?: (record: GatedInstance) => Promise<void>) {
    const { factory, instances } = makeGatedSessionFactory({ finish });
    const canonical: CanonicalSegment[] = [];
    const en: EnSegment[] = [];
    const onDegraded = vi.fn();
    const controller = new SonioxStreamController({
      mode: "online",
      label: "mic",
      sessionFactory: factory,
      handlers: { onCanonicalFinal: (s) => canonical.push(s), onEnFinal: (s) => en.push(s), onDegraded },
    });
    return { controller, instances, canonical, en, onDegraded };
  }

  test("test_soniox_controller_finished_event_flushes_pending_final_tokens_without_endpoint", async () => {
    // Arrange — E7: finish() trả final nhưng KHÔNG có endpoint, chỉ có `finished`
    const { controller, instances, canonical } = setup();
    await openImmediately(controller, pairKeys("k"), instances);
    controller.feed(CHUNK, EPOCH);
    instances[0].handlers["token"]?.(token("câu dở"));

    // Act
    instances[0].handlers["finished"]?.();

    // Assert
    expect(canonical.map((s) => s.textOrig)).toEqual(["câu dở"]);
  });

  test("test_soniox_controller_drain_and_stop_flushes_final_tokens_returned_during_finish", async () => {
    // Arrange — trong finish(): canonical xả câu + `finished`; en xả token gốc + bản dịch + `finished`
    const { controller, instances, canonical, en } = setup(async (record) => {
      if (record.apiKey.endsWith("-canonical")) {
        record.handlers["token"]?.(token("xả khi finish", { language: "vi" }));
      } else {
        record.handlers["token"]?.(token("src"));
        record.handlers["token"]?.(token("flushed en", { translation_status: "translation" }));
      }
      record.handlers["finished"]?.();
    });
    await openImmediately(controller, pairKeys("k"), instances);
    controller.feed(CHUNK, EPOCH);

    // Act
    await controller.drainAndStop(2000);

    // Assert — cả hai bên đều phát, cả hai connection đã đóng
    expect(canonical.map((s) => s.textOrig)).toEqual(["xả khi finish"]);
    expect(en.map((s) => s.textEn)).toEqual(["flushed en"]);
    expect(instances.map((i) => i.closed)).toEqual([true, true]);
  });

  test("test_soniox_controller_drain_and_stop_when_finish_hangs_still_flushes_finals_after_timeout", async () => {
    // Arrange — đã có final, finish() treo; đuôi provisional KHÔNG được vào segment
    const { controller, instances, canonical } = setup(() => new Promise<void>(() => {}));
    await openImmediately(controller, pairKeys("k"), instances);
    controller.feed(CHUNK, EPOCH);
    instances[0].handlers["token"]?.(token("đã final"));
    instances[0].handlers["token"]?.(token(" chưa chắc", { is_final: false }));

    // Act
    const draining = controller.drainAndStop(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await draining;

    // Assert
    expect(canonical.map((s) => s.textOrig)).toEqual(["đã final"]);
    expect(instances[0].closed).toBe(true);
  });

  test("test_soniox_controller_drain_and_stop_called_twice_drains_only_once", async () => {
    // Arrange
    const finish = vi.fn(async () => {});
    const { controller, instances } = setup(finish);
    await openImmediately(controller, pairKeys("k"), instances);

    // Act
    await controller.drainAndStop(2000);
    await controller.drainAndStop(2000);

    // Assert — mỗi connection chỉ finish() 1 lần
    expect(finish).toHaveBeenCalledTimes(2);
  });

  test("test_soniox_controller_drain_and_stop_after_stop_is_noop", async () => {
    // Arrange — stop() là đường đóng ngay của unmount/lỗi
    const finish = vi.fn(async () => {});
    const { controller, instances } = setup(finish);
    await openImmediately(controller, pairKeys("k"), instances);
    await controller.stop();
    finish.mockClear();

    // Act
    await controller.drainAndStop(2000);

    // Assert
    expect(finish).not.toHaveBeenCalled();
  });

  test("test_soniox_controller_drain_and_stop_does_not_trigger_reconnect", async () => {
    // Arrange — close() của fake tự bắn `disconnected` (worst-case SDK)
    const { controller, instances, onDegraded } = setup();
    await openImmediately(controller, pairKeys("k"), instances);

    // Act
    await controller.drainAndStop(2000);

    // Assert
    expect(onDegraded).not.toHaveBeenCalled();
    expect(controller.isStopped).toBe(true);
  });
});
