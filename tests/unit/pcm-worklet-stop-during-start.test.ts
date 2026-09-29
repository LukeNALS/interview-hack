import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PcmWorkletCapture } from "@/lib/audio/pcm-worklet";

/**
 * `stop()` đến TRƯỚC hoặc TRONG `start()` (lỗi Soniox fatal đến sớm): lúc đó `node`/`audioContext` còn null
 * nên `stop()` không tắt được gì — nếu `start()` vẫn chạy tiếp thì mic bật mồ côi trong khi UI báo đã dừng.
 */

const created: Array<{ close: ReturnType<typeof vi.fn>; addModule: () => Promise<void>; sourceCreated: boolean }> = [];
let releaseAddModule: () => void = () => {};

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 48000;
      close = vi.fn(async () => undefined);
      sourceCreated = false;
      audioWorklet = {
        addModule: () =>
          new Promise<void>((resolve) => {
            releaseAddModule = resolve;
          }),
      };
      constructor() {
        created.push(this as unknown as (typeof created)[number]);
      }
      createMediaStreamSource() {
        this.sourceCreated = true;
        return { connect: () => {} };
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null as unknown, close: () => {} };
      onprocessorerror: unknown = null;
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("test_pcm_worklet_stop_while_add_module_pending_closes_context_and_never_attaches_source", async () => {
  // Arrange — start() đang chờ addModule
  const capture = new PcmWorkletCapture({ onChunk: () => {} });
  const started = capture.start({} as MediaStream);

  // Act — stop() đến giữa chừng, rồi worklet load xong
  capture.stop();
  releaseAddModule();
  await started;

  // Assert — context được đóng, nguồn mic KHÔNG được gắn vào
  expect(created).toHaveLength(1);
  expect(created[0].close).toHaveBeenCalledTimes(1);
  expect(created[0].sourceCreated).toBe(false);
});

test("test_pcm_worklet_stop_before_start_makes_start_a_noop", async () => {
  // Arrange
  const capture = new PcmWorkletCapture({ onChunk: () => {} });

  // Act
  capture.stop();
  await capture.start({} as MediaStream);

  // Assert — không tạo AudioContext nào
  expect(created).toHaveLength(0);
});

test("test_pcm_worklet_start_without_stop_attaches_source_as_before", async () => {
  // Arrange — đối chứng: không stop ⇒ hành vi cũ
  const capture = new PcmWorkletCapture({ onChunk: () => {} });
  const started = capture.start({} as MediaStream);

  // Act
  releaseAddModule();
  await started;

  // Assert
  expect(created[0].sourceCreated).toBe(true);
  expect(created[0].close).not.toHaveBeenCalled();
  capture.stop();
});
