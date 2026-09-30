import { beforeEach, describe, expect, test, vi } from "vitest";
import { drainLivePipelineStreams, type LivePipeline } from "@/hooks/live-pipeline";

/**
 * `drainLivePipelineStreams` thật (audit #7): dừng PCM của mọi stream TRƯỚC, rồi drain controller; stream lỗi không
 * được chặn stream còn lại. Thứ tự tổng thể của `endLiveInterview` nằm ở `end-interview-drain-order.test.ts`.
 */

const order: string[] = [];

describe("drainLivePipelineStreams", () => {
  function fakeStream(name: string, drain: () => Promise<void> | void) {
    return {
      pcmCapture: { stop: vi.fn(() => void order.push(`pcm-stop:${name}`)) },
      controller: {
        drainAndStop: vi.fn(async (timeoutMs: number) => {
          order.push(`drain:${name}:${timeoutMs}`);
          await drain();
        }),
      },
    };
  }
  const pipelineOf = (...streams: ReturnType<typeof fakeStream>[]) =>
    ({ streams: { current: streams } }) as unknown as LivePipeline;

  beforeEach(() => {
    order.length = 0;
  });

  test("test_live_pipeline_drain_stops_every_pcm_before_draining_any_controller", async () => {
    // Arrange
    const mic = fakeStream("mic", () => {});
    const tab = fakeStream("tab", () => {});

    // Act
    await drainLivePipelineStreams(pipelineOf(mic, tab), 2000);

    // Assert — không bơm thêm audio trong lúc drain
    expect(order.slice(0, 2)).toEqual(["pcm-stop:mic", "pcm-stop:tab"]);
    expect(order.slice(2).sort()).toEqual(["drain:mic:2000", "drain:tab:2000"]);
  });

  test("test_live_pipeline_drain_when_one_controller_fails_still_drains_the_other", async () => {
    // Arrange — 1 stream ném bất đồng bộ, 1 stream ném ĐỒNG BỘ (mock thiếu method / lỗi lập trình)
    const broken = fakeStream("mic", () => Promise.reject(new Error("boom")));
    const thrower = {
      pcmCapture: { stop: vi.fn() },
      controller: {
        drainAndStop: () => {
          throw new TypeError("not a function");
        },
      },
    };
    const healthy = fakeStream("tab", () => {});

    // Act + Assert — không ném, stream còn lại vẫn drain
    await expect(
      drainLivePipelineStreams({ streams: { current: [broken, thrower, healthy] } } as unknown as LivePipeline, 2000),
    ).resolves.toBeUndefined();
    expect(healthy.controller.drainAndStop).toHaveBeenCalledTimes(1);
  });
});
