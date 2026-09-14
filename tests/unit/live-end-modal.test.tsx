import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LiveEndModal } from "@/components/live/live-end-modal";
import { createInitialState, useSessionStore } from "@/stores/session-store";

// M3 fix (code review): LiveEndModal không còn tự gọi useEndSession/router.push nội bộ —
// dùng chung `endInterview()` từ useLiveSession qua prop `onConfirmEnd` (DRY, xoá path
// kết-thúc-buổi trùng). Test giờ chỉ verify modal gọi đúng callback + tự đóng, KHÔNG còn
// verify navigation (navigation là trách nhiệm của endInterview(), test riêng ở use-live-session).

// vitest không bật globals → RTL không tự cleanup, phải gọi tay.
afterEach(cleanup);

beforeEach(() => {
  useSessionStore.setState({ ...createInitialState(), confirmEnd: true });
});

test("test_live_end_modal_confirm_calls_on_confirm_end_and_closes_modal", () => {
  // Arrange
  const onConfirmEnd = vi.fn();
  render(<LiveEndModal onConfirmEnd={onConfirmEnd} />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "Kết thúc" }));

  // Assert — gọi đúng 1 lần đường kết thúc buổi chung (DRY), tự đóng modal.
  expect(onConfirmEnd).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().confirmEnd).toBe(false);
});

test("test_live_end_modal_back_closes_without_calling_on_confirm_end", () => {
  // Arrange
  const onConfirmEnd = vi.fn();
  render(<LiveEndModal onConfirmEnd={onConfirmEnd} />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "Quay lại" }));

  // Assert
  expect(onConfirmEnd).not.toHaveBeenCalled();
  expect(useSessionStore.getState().confirmEnd).toBe(false);
});

test("test_live_end_modal_closed_renders_nothing", () => {
  // Arrange
  useSessionStore.setState({ confirmEnd: false });

  // Act
  render(<LiveEndModal onConfirmEnd={vi.fn()} />);

  // Assert
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
