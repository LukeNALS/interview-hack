import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useNarrow } from "@/hooks/use-narrow";

/** Giả lập matchMedia của jsdom: matches tính theo width hiện tại. */
function installMatchMedia(initialWidth: number): {
  setWidth: (w: number) => void;
} {
  let width = initialWidth;
  let listeners: Array<() => void> = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const max = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? NaN);
      return {
        get matches() {
          return width <= max;
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: () => void) => {
          listeners.push(cb);
        },
        removeEventListener: (_: string, cb: () => void) => {
          listeners = listeners.filter((l) => l !== cb);
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  );
  return {
    setWidth: (w: number) => {
      width = w;
      listeners.forEach((cb) => cb());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("test_use_narrow_viewport_1099px_returns_true", () => {
  // Arrange
  installMatchMedia(1099);

  // Act
  const { result } = renderHook(() => useNarrow());

  // Assert — dưới 1100px là narrow (1 cột + tab pill)
  expect(result.current).toBe(true);
});

test("test_use_narrow_viewport_1100px_returns_false", () => {
  // Arrange — đúng 1100px vẫn là 3 cột (design: innerWidth < 1100 mới narrow)
  installMatchMedia(1100);

  // Act
  const { result } = renderHook(() => useNarrow());

  // Assert
  expect(result.current).toBe(false);
});

test("test_use_narrow_resize_wide_to_narrow_updates_to_true", () => {
  // Arrange
  const media = installMatchMedia(1280);
  const { result } = renderHook(() => useNarrow());
  expect(result.current).toBe(false);

  // Act — thu nhỏ cửa sổ xuống 900px
  act(() => media.setWidth(900));

  // Assert
  expect(result.current).toBe(true);
});

test("test_use_narrow_resize_narrow_to_wide_updates_to_false", () => {
  // Arrange
  const media = installMatchMedia(900);
  const { result } = renderHook(() => useNarrow());
  expect(result.current).toBe(true);

  // Act
  act(() => media.setWidth(1440));

  // Assert
  expect(result.current).toBe(false);
});

test("test_use_narrow_custom_breakpoint_is_respected", () => {
  // Arrange
  installMatchMedia(700);

  // Act
  const { result } = renderHook(() => useNarrow(768));

  // Assert
  expect(result.current).toBe(true);
});
