import { beforeEach, describe, expect, test, vi } from "vitest";
import { endLiveInterview, END_DRAIN_TIMEOUT_MS, type EndLiveInterviewDeps } from "@/hooks/live-session/end-interview";

/**
 * Thứ tự kết thúc buổi (audit #7): dừng PCM → drain Soniox → dispose pipeline → flush ingest queue → /end → navigate.
 * Đảo drain và dispose ⇒ câu cuối về sau dispose bị chặn (xem use-live-session-last-utterance: probe #7).
 */

const order = vi.hoisted(() => [] as string[]);
const fakePipeline = vi.hoisted(() => ({ ending: false, ingestQueue: { id: "queue" } }));
const drainMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/live-pipeline", () => ({
  getLivePipeline: vi.fn(() => fakePipeline),
  disposeLivePipeline: vi.fn(() => void order.push("dispose")),
  drainLivePipelineStreams: drainMock,
}));
vi.mock("@/hooks/live-session/live-session-lifecycle", () => ({
  flushIngestQueueBeforeEnd: vi.fn(async () => void order.push("flush")),
}));

describe("endLiveInterview — thứ tự drain", () => {
  beforeEach(() => {
    order.length = 0;
    fakePipeline.ending = false; // endLiveInterview đặt true trên pipeline dùng chung
    drainMock.mockReset();
    drainMock.mockImplementation(async () => void order.push("drain"));
  });

  function makeDeps(): EndLiveInterviewDeps {
    return {
      sessionId: "session-1",
      endingRef: { current: false },
      endSession: vi.fn(async () => {
        order.push("end");
        return {};
      }),
      navigateAfterEnd: vi.fn(() => void order.push("navigate")),
    };
  }

  test("test_end_live_interview_drains_streams_before_disposing_pipeline_and_flushing_queue", async () => {
    // Arrange + Act
    await endLiveInterview(makeDeps());

    // Assert
    expect(order).toEqual(["drain", "dispose", "flush", "end", "navigate"]);
    expect(drainMock).toHaveBeenCalledWith(fakePipeline, END_DRAIN_TIMEOUT_MS);
  });

  test("test_end_live_interview_when_drain_rejects_still_disposes_posts_end_and_navigates", async () => {
    // Arrange
    drainMock.mockRejectedValueOnce(new Error("drain blew up"));

    // Act
    await endLiveInterview(makeDeps());

    // Assert — drain lỗi không được chặn luồng kết thúc
    expect(order).toEqual(["dispose", "flush", "end", "navigate"]);
  });
});
