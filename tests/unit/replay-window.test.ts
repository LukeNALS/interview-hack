import { describe, expect, test } from "vitest";
import { clampReplayStart, computeReplayWindow, REPLAY_LOOKBACK_MAX_MS, REPLAY_MARGIN_MS } from "@/lib/soniox/replay-window";
import { ReconnectBuffer } from "@/lib/soniox/reconnect";

const NEG = Number.NEGATIVE_INFINITY;
const chunk = new Uint8Array([1]);

describe("computeReplayWindow", () => {
  test("test_replay_window_starts_at_slower_kind_boundary_minus_margin", () => {
    // Arrange — en chậm hơn canonical: mốc an toàn là của en
    const input = { lastEmittedEndAbsMs: { canonical: 5_000, en: 4_000 }, bufferOldestTs: 0, dropTs: 6_000 };

    // Act
    const window = computeReplayWindow(input);

    // Assert
    expect(window).toEqual({ replayFromTs: 4_000 - REPLAY_MARGIN_MS, needsFlush: false });
  });

  test("test_replay_window_without_any_emitted_segment_starts_at_oldest_buffered_chunk", () => {
    // Arrange — canonical đã emit nhưng en chưa emit gì ⇒ chưa có mốc chung
    const input = { lastEmittedEndAbsMs: { canonical: 5_000, en: NEG }, bufferOldestTs: 1_000, dropTs: 6_000 };

    // Act + Assert
    expect(computeReplayWindow(input)).toEqual({ replayFromTs: 1_000, needsFlush: false });
  });

  test("test_replay_window_boundary_exactly_30s_old_does_not_need_flush_but_older_does", () => {
    // Arrange — candidate = boundary − 300; now − candidate đúng 30_000 là biên không cần chốt
    const base = { bufferOldestTs: 0 };
    const exact = computeReplayWindow({ ...base, lastEmittedEndAbsMs: { canonical: 10_300, en: 10_300 }, dropTs: 10_000 + REPLAY_LOOKBACK_MAX_MS });
    const older = computeReplayWindow({ ...base, lastEmittedEndAbsMs: { canonical: 10_300, en: 10_300 }, dropTs: 10_001 + REPLAY_LOOKBACK_MAX_MS });

    // Assert
    expect(exact.needsFlush).toBe(false);
    expect(older.needsFlush).toBe(true);
  });

  test("test_replay_window_when_buffer_does_not_cover_the_boundary_needs_flush", () => {
    // Arrange — buffer đã evict quá mốc (nói liền hơn 2 phút)
    const input = { lastEmittedEndAbsMs: { canonical: 5_000, en: 5_000 }, bufferOldestTs: 9_000, dropTs: 10_000 };

    // Act + Assert
    expect(computeReplayWindow(input).needsFlush).toBe(true);
  });

  test("test_replay_window_with_empty_buffer_and_no_boundary_replays_nothing", () => {
    // Arrange
    const input = { lastEmittedEndAbsMs: { canonical: NEG, en: NEG }, bufferOldestTs: null, dropTs: 7_000 };

    // Act + Assert
    expect(computeReplayWindow(input)).toEqual({ replayFromTs: 7_000, needsFlush: false });
  });
});

describe("clampReplayStart", () => {
  test("test_clamp_replay_start_takes_the_latest_of_candidate_lookback_and_buffer_start", () => {
    // Assert — mốc ứng viên sớm hơn cả cửa sổ 30 s lẫn buffer thì bị kẹp vào vế muộn nhất
    expect(clampReplayStart(1_000, 2_000, 50_000)).toBe(50_000 - REPLAY_LOOKBACK_MAX_MS);
    expect(clampReplayStart(1_000, 45_000, 50_000)).toBe(45_000);
    expect(clampReplayStart(48_000, 2_000, 50_000)).toBe(48_000);
    expect(clampReplayStart(1_000, null, 50_000)).toBe(50_000 - REPLAY_LOOKBACK_MAX_MS);
  });
});

describe("ReconnectBuffer — luôn ghi", () => {
  test("test_reconnect_buffer_always_on_evicts_beyond_120s_and_chunks_since_returns_capture_order", () => {
    // Arrange — 130 s audio, mỗi chunk cách 1 s
    const buffer = new ReconnectBuffer();
    for (let s = 0; s <= 130; s++) buffer.push(chunk, s * 1000);

    // Act
    const since = buffer.chunksSince(125_000).map((c) => c.captureTs);

    // Assert — chỉ giữ ≤ 120 s cuối; chunksSince đúng thứ tự và KHÔNG xoá buffer
    expect(buffer.oldestCaptureTs).toBe(10_000);
    expect(since).toEqual([125_000, 126_000, 127_000, 128_000, 129_000, 130_000]);
    expect(buffer.peek()).toHaveLength(121);
  });

  test("test_reconnect_buffer_oldest_capture_ts_is_null_when_empty", () => {
    // Arrange + Act + Assert
    expect(new ReconnectBuffer().oldestCaptureTs).toBeNull();
  });
});
