import { describe, expect, test, vi } from "vitest";
import { SonioxConnection, type SonioxSessionFactory, type SonioxSessionLike } from "@/lib/soniox/connection";
import { openAllReady, fanOutChunk, closeAll } from "@/lib/soniox/fanout";
import type { SttSessionConfig } from "@soniox/client";

const DUMMY_CONFIG: SttSessionConfig = { model: "stt-rt-v5" };

/** Fake session — no real WebSocket/network, records calls for assertions. */
function makeFakeSessionFactory() {
  const instances: Array<{
    apiKey: string;
    sentChunks: Uint8Array[];
    connected: boolean;
    finished: boolean;
    closed: boolean;
    handlers: Record<string, (...args: unknown[]) => void>;
  }> = [];

  const factory: SonioxSessionFactory = (_config, apiKey) => {
    const record = { apiKey, sentChunks: [] as Uint8Array[], connected: false, finished: false, closed: false, handlers: {} as Record<string, (...args: unknown[]) => void> };
    instances.push(record);
    const session: SonioxSessionLike = {
      async connect() {
        record.connected = true;
      },
      sendAudio(data) {
        record.sentChunks.push(data as Uint8Array);
      },
      async finish() {
        record.finished = true;
      },
      close() {
        record.closed = true;
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

describe("SonioxConnection — epoch_conn tracking", () => {
  test("test_soniox_connection_feed_records_epoch_conn_on_first_chunk_only", async () => {
    // Arrange
    const { factory } = makeFakeSessionFactory();
    let tick = 1000;
    const conn = new SonioxConnection({ config: DUMMY_CONFIG, label: "test", sessionFactory: factory, now: () => tick });
    await conn.open("key");

    // Act
    conn.feed(new Uint8Array([1]));
    tick = 5000; // simulate wall-clock advancing
    conn.feed(new Uint8Array([2]));

    // Assert — epoch_conn set at FIRST feed only (1000), not updated on later feeds
    expect(conn.getEpochConnMs()).toBe(1000);
  });

  test("test_soniox_connection_set_epoch_conn_ms_overrides_for_replay_case", async () => {
    // Arrange — fix B13: reconnect-replay explicitly sets epoch_conn before feeding
    const { factory } = makeFakeSessionFactory();
    const conn = new SonioxConnection({ config: DUMMY_CONFIG, label: "test", sessionFactory: factory, now: () => 9999 });
    await conn.open("key");

    // Act
    conn.setEpochConnMs(20_000);
    conn.feed(new Uint8Array([1]));

    // Assert — feed() must NOT overwrite an explicitly-set epoch_conn
    expect(conn.getEpochConnMs()).toBe(20_000);
  });

  test("test_soniox_connection_feed_before_open_throws", () => {
    // Arrange
    const { factory } = makeFakeSessionFactory();
    const conn = new SonioxConnection({ config: DUMMY_CONFIG, label: "test", sessionFactory: factory });
    // Act + Assert
    expect(() => conn.feed(new Uint8Array([1]))).toThrow();
  });
});

describe("SonioxConnection — lỗi server sau connect", () => {
  test("test_soniox_connection_error_event_is_recorded_and_forwarded_to_handler", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const conn = new SonioxConnection({ config: DUMMY_CONFIG, label: "test", sessionFactory: factory });
    const seen: Error[] = [];
    conn.setHandlers({ onError: (err) => seen.push(err) });
    await conn.open("key");
    expect(conn.error).toBeNull();

    // Act — SDK phát `error` (vd 401 key single-use dùng lại) rồi tự dọn session
    const err = Object.assign(new Error("Invalid or expired temporary API key"), { statusCode: 401 });
    instances[0].handlers["error"]?.(err);

    // Assert — controller đọc được lỗi trên pair CHƯA swap; handler vẫn được gọi
    expect(conn.error).toBe(err);
    expect(seen).toEqual([err]);
  });
});

describe("fanout — open all ready + fan out chunk", () => {
  test("test_fanout_open_all_ready_opens_every_connection_with_its_own_key_before_resolving", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    const connB = new SonioxConnection({ config: DUMMY_CONFIG, label: "b", sessionFactory: factory });

    // Act
    await openAllReady([connA, connB], ["key-a", "key-b"]);

    // Assert — key single-use: mỗi connection một key riêng, đúng thứ tự
    expect(instances).toHaveLength(2);
    expect(instances.every((i) => i.connected)).toBe(true);
    expect(instances.map((i) => i.apiKey)).toEqual(["key-a", "key-b"]);
  });

  test("test_fanout_open_all_ready_when_key_count_mismatches_throws_without_opening_any", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    const connB = new SonioxConnection({ config: DUMMY_CONFIG, label: "b", sessionFactory: factory });

    // Act + Assert
    await expect(openAllReady([connA, connB], ["only-one-key"])).rejects.toThrow("2 connection nhưng 1 key");
    expect(instances).toHaveLength(0);
  });

  test("test_fanout_chunk_sends_identical_chunk_to_every_connection", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    const connB = new SonioxConnection({ config: DUMMY_CONFIG, label: "b", sessionFactory: factory });
    await openAllReady([connA, connB], ["key-a", "key-b"]);
    const chunk = new Uint8Array([1, 2, 3]);

    // Act
    fanOutChunk([connA, connB], chunk);

    // Assert — same chunk reference fanned out to both connections' sessions
    expect(instances[0].sentChunks).toEqual([chunk]);
    expect(instances[1].sentChunks).toEqual([chunk]);
  });

  test("test_fanout_close_all_finishes_then_closes_every_connection", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    await openAllReady([connA], ["key"]);

    // Act
    await closeAll([connA]);

    // Assert
    expect(instances[0].finished).toBe(true);
    expect(instances[0].closed).toBe(true);
  });

  test("test_fanout_close_all_when_one_connection_finish_rejects_still_closes_every_connection", async () => {
    // Arrange — connection A đã chết vì lỗi server (SDK ném StateError ở finish()), B còn sống
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    const connB = new SonioxConnection({ config: DUMMY_CONFIG, label: "b", sessionFactory: factory });
    await openAllReady([connA, connB], ["key-a", "key-b"]);
    vi.spyOn(connA, "finish").mockRejectedValue(new Error('Cannot finish: session is in "error" state'));

    // Act
    await closeAll([connA, connB]);

    // Assert — WebSocket của B không được rò dù finish() của A reject
    expect(instances[0].closed).toBe(true);
    expect(instances[1].closed).toBe(true);
  });
});
