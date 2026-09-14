import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStreamingText } from "@/hooks/use-streaming-text";

function stubMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("test_streaming_text_ja_streams_per_character_at_65ms", () => {
  // Arrange
  stubMatchMedia(false);
  const text = "こんにちは"; // 5 ký tự
  const { result } = renderHook(() => useStreamingText(text, "JA"));

  // Act + Assert — mỗi 65ms hiện thêm 1 ký tự
  expect(result.current.displayed).toBe("");
  act(() => vi.advanceTimersByTime(65));
  expect(result.current.displayed).toBe("こ");
  act(() => vi.advanceTimersByTime(65 * 3));
  expect(result.current.displayed).toBe("こんにち");
  expect(result.current.done).toBe(false);
  act(() => vi.advanceTimersByTime(65));
  expect(result.current.displayed).toBe(text);
  expect(result.current.done).toBe(true);
});

test("test_streaming_text_vi_streams_per_word_at_100ms", () => {
  // Arrange
  stubMatchMedia(false);
  const text = "xin chào các bạn"; // 4 từ
  const { result } = renderHook(() => useStreamingText(text, "VI"));

  // Act + Assert — mỗi 100ms hiện thêm 1 từ
  act(() => vi.advanceTimersByTime(100));
  expect(result.current.displayed).toBe("xin");
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.displayed).toBe("xin chào các");
  act(() => vi.advanceTimersByTime(100));
  expect(result.current.displayed).toBe(text);
  expect(result.current.done).toBe(true);
});

test("test_streaming_text_on_complete_fires_once_after_stream_ends", () => {
  // Arrange
  stubMatchMedia(false);
  const onComplete = vi.fn();
  const text = "một hai ba";
  renderHook(() => useStreamingText(text, "VI", { onComplete }));

  // Act — chạy quá thời lượng stream
  act(() => vi.advanceTimersByTime(100 * 10));

  // Assert — chỉ báo complete đúng 1 lần, sau khi xong (mới gắn timestamp)
  expect(onComplete).toHaveBeenCalledTimes(1);
});

test("test_streaming_text_reduced_motion_shows_full_text_instantly", () => {
  // Arrange
  stubMatchMedia(true);
  const onComplete = vi.fn();
  const text = "こんにちは、よろしくお願いします";

  // Act
  const { result } = renderHook(() =>
    useStreamingText(text, "JA", { onComplete }),
  );

  // Assert — không cần chạy timer, text hiện tức thì
  expect(result.current.displayed).toBe(text);
  expect(result.current.done).toBe(true);
  expect(onComplete).toHaveBeenCalledTimes(1);
});

test("test_streaming_text_disabled_renders_static_full_text", () => {
  // Arrange — bubble cũ render tĩnh, chỉ bubble cuối stream
  stubMatchMedia(false);
  const text = "câu đã hoàn chỉnh từ trước";

  // Act
  const { result } = renderHook(() =>
    useStreamingText(text, "VI", { enabled: false }),
  );

  // Assert
  expect(result.current.displayed).toBe(text);
  expect(result.current.done).toBe(true);
});
