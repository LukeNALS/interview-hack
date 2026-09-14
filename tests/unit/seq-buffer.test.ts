import { describe, expect, test } from "vitest";
import { SeqBuffer } from "@/lib/transcript/seq-buffer";

describe("SeqBuffer", () => {
  test("test_seq_buffer_in_order_seq_does_not_trigger_gap_callback", () => {
    // Arrange
    const gaps: Array<[number, number]> = [];
    const accepted: number[] = [];
    const buffer = new SeqBuffer({
      onGapDetected: (from, to) => gaps.push([from, to]),
      onAccepted: (seq) => accepted.push(seq),
    });

    // Act
    buffer.feed(1);
    buffer.feed(2);
    buffer.feed(3);

    // Assert
    expect(gaps).toHaveLength(0);
    expect(accepted).toEqual([1, 2, 3]);
  });

  test("test_seq_buffer_seq_gap_triggers_backfill_callback_with_missing_range", () => {
    // Arrange
    const gaps: Array<[number, number]> = [];
    const buffer = new SeqBuffer({ onGapDetected: (from, to) => gaps.push([from, to]), onAccepted: () => {} });

    // Act — jumps from seq 1 straight to seq 5 (Realtime never replays missed messages)
    buffer.feed(1);
    buffer.feed(5);

    // Assert — missing range is [2, 4]
    expect(gaps).toEqual([[2, 4]]);
  });

  test("test_seq_buffer_duplicate_or_stale_seq_is_ignored", () => {
    // Arrange
    const accepted: number[] = [];
    const buffer = new SeqBuffer({ onGapDetected: () => {}, onAccepted: (seq) => accepted.push(seq) });

    // Act
    buffer.feed(3);
    buffer.feed(2); // stale (before last accepted)
    buffer.feed(3); // duplicate

    // Assert
    expect(accepted).toEqual([3]);
  });

  test("test_seq_buffer_reset_restores_tracked_position_for_reload_backfill", () => {
    // Arrange
    const buffer = new SeqBuffer({ onGapDetected: () => {}, onAccepted: () => {} });
    buffer.feed(10);

    // Act — reload backfills from seq=0, buffer should track from a clean slate
    buffer.reset(0);

    // Assert
    expect(buffer.current).toBe(0);
  });
});
