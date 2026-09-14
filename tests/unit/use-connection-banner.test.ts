import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useConnectionBanner } from "@/hooks/use-connection-banner";
import { createInitialState, useSessionStore } from "@/stores/session-store";

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.setState(createInitialState());
});

afterEach(() => {
  vi.useRealTimers();
});

test("test_connection_banner_show_silent_sets_silent_kind", () => {
  // Arrange
  const { result } = renderHook(() => useConnectionBanner());

  // Act
  act(() => result.current.showSilent());

  // Assert
  expect(useSessionStore.getState().banner).toBe("silent");
});

test("test_connection_banner_show_degraded_sets_lost_kind", () => {
  // Arrange
  const { result } = renderHook(() => useConnectionBanner());

  // Act
  act(() => result.current.showDegraded());

  // Assert
  expect(useSessionStore.getState().banner).toBe("lost");
});

test("test_connection_banner_show_restored_sets_ok_then_auto_hides", () => {
  // Arrange
  const { result } = renderHook(() => useConnectionBanner());

  // Act
  act(() => result.current.showRestored());
  // Assert — hiện xanh ngay
  expect(useSessionStore.getState().banner).toBe("ok");

  // Act — tự ẩn sau 1 khoảng (không đợi user bấm gì)
  act(() => vi.advanceTimersByTime(3000));
  // Assert
  expect(useSessionStore.getState().banner).toBeNull();
});

test("test_connection_banner_clear_resets_to_null_immediately", () => {
  // Arrange
  const { result } = renderHook(() => useConnectionBanner());
  act(() => result.current.showDegraded());

  // Act
  act(() => result.current.clear());

  // Assert
  expect(useSessionStore.getState().banner).toBeNull();
});
