import { describe, expect, test } from "vitest";
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

describe("fanout — open all ready + fan out chunk", () => {
  test("test_fanout_open_all_ready_opens_every_connection_before_resolving", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    const connB = new SonioxConnection({ config: DUMMY_CONFIG, label: "b", sessionFactory: factory });

    // Act
    await openAllReady([connA, connB], "shared-key");

    // Assert
    expect(instances).toHaveLength(2);
    expect(instances.every((i) => i.connected)).toBe(true);
    expect(instances.every((i) => i.apiKey === "shared-key")).toBe(true);
  });

  test("test_fanout_chunk_sends_identical_chunk_to_every_connection", async () => {
    // Arrange
    const { factory, instances } = makeFakeSessionFactory();
    const connA = new SonioxConnection({ config: DUMMY_CONFIG, label: "a", sessionFactory: factory });
    const connB = new SonioxConnection({ config: DUMMY_CONFIG, label: "b", sessionFactory: factory });
    await openAllReady([connA, connB], "key");
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
    await openAllReady([connA], "key");

    // Act
    await closeAll([connA]);

    // Assert
    expect(instances[0].finished).toBe(true);
    expect(instances[0].closed).toBe(true);
  });
});
