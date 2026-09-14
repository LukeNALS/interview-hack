import { describe, expect, test } from "vitest";
import { buildClientUtteranceId, buildUtterance, normalizeToSessionAxis } from "@/lib/transcript/utterance-builder";
import { epochConnForReplay, type BufferedChunk } from "@/lib/soniox/reconnect";

const BASE_INPUT = {
  stream: "mic" as const,
  speaker: "interviewer",
  lang: "ja",
  textOrig: "xin chào",
  translations: { vi: null, ja: null },
  questionId: null,
};

describe("normalizeToSessionAxis — pure client-clock formula", () => {
  test("test_utterance_builder_normalizes_session_axis_using_only_client_clocks", () => {
    // Arrange — epoch_conn + t_soniox - t0_local, per §Architecture (NEVER server clock)
    // Act
    const result = normalizeToSessionAxis({
      tSonioxStartMs: 2000,
      tSonioxEndMs: 2500,
      epochConnMs: 5000,
      t0LocalMs: 0,
    });
    // Assert
    expect(result).toEqual({ t_start_ms: 7000, t_end_ms: 7500 });
  });
});

describe("buildClientUtteranceId", () => {
  test("test_utterance_builder_client_utt_id_uses_stream_and_session_start", () => {
    // Arrange + Act
    const id = buildClientUtteranceId("tab", 7000);
    // Assert
    expect(id).toBe("tab:7000");
  });
});

describe("utterance-builder — reconnect timeline behavior", () => {
  test("test_utterance_builder_rebases_timestamps_to_session_axis_after_reconnect", () => {
    // Arrange — first connection: epoch_conn set at feed start, Soniox-local ts 2000-2500ms
    const t0LocalMs = 0;
    const firstConnEpoch = 5_000;
    const before = buildUtterance({
      ...BASE_INPUT,
      tSonioxStartMs: 2000,
      tSonioxEndMs: 2500,
      epochConnMs: firstConnEpoch,
      t0LocalMs,
    });

    // Act — renew/reconnect opens a NEW connection; Soniox's own clock resets near 0 for
    // it, but epoch_conn (client wall clock at first feed of the NEW connection) is much
    // later than the first connection's epoch_conn.
    const renewedConnEpoch = 60_000;
    const after = buildUtterance({
      ...BASE_INPUT,
      tSonioxStartMs: 100,
      tSonioxEndMs: 600,
      epochConnMs: renewedConnEpoch,
      t0LocalMs,
    });

    // Assert — session-axis timestamps keep increasing across the reconnect, never reset
    // toward 0 even though Soniox's own per-connection clock did reset.
    expect(before.t_start_ms).toBe(7000);
    expect(after.t_start_ms).toBe(60_100);
    expect(after.t_start_ms).toBeGreaterThan(before.t_end_ms);
    expect(before.client_utt_id).not.toBe(after.client_utt_id);
  });

  test("test_utterance_builder_uses_capture_ts_epoch_for_replayed_buffer_after_reconnect", () => {
    // Arrange — RAM buffer holds PCM chunks captured DURING the outage; outage began at
    // capture_ts=20_000. Connection actually reopens+replays 5s later (wall clock 25_000).
    const buffered: BufferedChunk[] = [
      { data: new Uint8Array([1]), captureTs: 20_000 },
      { data: new Uint8Array([2]), captureTs: 20_100 },
      { data: new Uint8Array([3]), captureTs: 20_200 },
    ];
    const t0LocalMs = 10_000;
    const replayWallClockMs = 25_000;

    // Act — fix B13: epoch_conn for the replaying connection = capture_ts of the FIRST
    // buffered chunk, NOT the wall-clock time replay actually happened.
    const epochConnMs = epochConnForReplay(buffered);
    const built = buildUtterance({
      ...BASE_INPUT,
      tSonioxStartMs: 0,
      tSonioxEndMs: 500,
      epochConnMs: epochConnMs as number,
      t0LocalMs,
    });

    // Assert — timeline anchors to the outage START (20_000), not the replay time
    // (25_000): using replay time would have produced t_start_ms = 25_000 + 0 - 10_000 =
    // 15_000, drifting the session axis forward by the outage duration.
    expect(epochConnMs).toBe(20_000);
    expect(built.t_start_ms).toBe(10_000);
    expect(built.t_start_ms).not.toBe(replayWallClockMs - t0LocalMs);
  });
});
