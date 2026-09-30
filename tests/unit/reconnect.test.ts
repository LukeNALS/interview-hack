import { describe, expect, test } from "vitest";
import { ReconnectBuffer, epochConnForReplay } from "@/lib/soniox/reconnect";

describe("ReconnectBuffer — RAM-only, capped at 2 minutes", () => {
  test("test_reconnect_buffer_push_and_chunks_since_returns_chunks_in_capture_order_without_clearing", () => {
    // Arrange
    const buffer = new ReconnectBuffer();
    // Act
    buffer.push(new Uint8Array([1]), 1000);
    buffer.push(new Uint8Array([2]), 1100);
    const all = buffer.chunksSince(0);
    // Assert
    expect(all.map((c) => c.captureTs)).toEqual([1000, 1100]);
    expect(buffer.isEmpty).toBe(false); // buffer luôn ghi: đọc không xoá, reconnect lần sau vẫn dùng được
  });

  test("test_reconnect_buffer_evicts_chunks_older_than_max_duration", () => {
    // Arrange — cap at 2 minutes (120_000ms), default
    const buffer = new ReconnectBuffer(120_000);
    // Act
    buffer.push(new Uint8Array([1]), 0); // will fall outside the 2min window once t=120_001 arrives
    buffer.push(new Uint8Array([2]), 60_000);
    buffer.push(new Uint8Array([3]), 120_001);
    // Assert — first chunk (captureTs=0) evicted; the other two remain
    expect(buffer.peek().map((c) => c.captureTs)).toEqual([60_000, 120_001]);
  });

  test("test_reconnect_buffer_clear_empties_without_returning_chunks", () => {
    const buffer = new ReconnectBuffer();
    buffer.push(new Uint8Array([1]), 0);
    buffer.clear();
    expect(buffer.isEmpty).toBe(true);
  });
});

describe("epochConnForReplay — fix B13", () => {
  test("test_epoch_conn_for_replay_returns_capture_ts_of_first_chunk", () => {
    // Arrange
    const chunks = [
      { data: new Uint8Array([1]), captureTs: 5000 },
      { data: new Uint8Array([2]), captureTs: 5100 },
    ];
    // Act + Assert
    expect(epochConnForReplay(chunks)).toBe(5000);
  });

  test("test_epoch_conn_for_replay_empty_buffer_returns_null", () => {
    expect(epochConnForReplay([])).toBeNull();
  });
});
