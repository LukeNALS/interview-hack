import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LiveHeader } from "@/components/live/live-header";
import { createInitialState, useSessionStore } from "@/stores/session-store";

beforeEach(() => {
  useSessionStore.setState(createInitialState());
});

// vitest không bật globals → RTL không tự cleanup, phải gọi tay.
afterEach(cleanup);

test("test_live_header_with_reduced_motion_disables_pulse_animation", () => {
  // Arrange + Act
  const { container } = render(<LiveHeader narrow={false} />);

  // Assert — chấm REC pulse PHẢI kèm motion-reduce:animate-none (AC7)
  const dot = container.querySelector(".animate-rec-pulse");
  expect(dot).not.toBeNull();
  expect(dot).toHaveClass("motion-reduce:animate-none");
});

test("test_live_header_elapsed_872s_renders_timer_00_14_32_tabular", () => {
  // Arrange
  useSessionStore.setState({ elapsed: 872 });

  // Act
  render(<LiveHeader narrow={false} />);

  // Assert — fmt() design: "00:MM:SS", tabular-nums
  const timer = screen.getByText("00:14:32");
  expect(timer).toHaveClass("tabular-nums");
});

test("test_live_header_narrow_hides_candidate_role", () => {
  // Arrange — tên/chức danh THẬT của buổi nằm trong store (nguồn: GET /sessions/:id),
  // không còn đọc MOCK_SESSION nữa.
  useSessionStore.setState({ candidateName: "Nguyễn Minh Tuấn", position: "Kỹ sư Backend" });

  // Act
  render(<LiveHeader narrow />);

  // Assert — chức danh ẩn khi narrow, tên vẫn hiện
  expect(screen.queryByText("Kỹ sư Backend")).not.toBeInTheDocument();
  expect(screen.getByText("Nguyễn Minh Tuấn")).toBeInTheDocument();
});

test("test_live_header_end_button_click_opens_confirm_modal_flag", () => {
  // Arrange
  render(<LiveHeader narrow={false} />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "Kết thúc" }));

  // Assert
  expect(useSessionStore.getState().confirmEnd).toBe(true);
});

test("test_live_header_segmented_ban_goc_click_sets_view_orig", () => {
  // Arrange — mặc định đang xem Bản dịch (viewOrig=false)
  render(<LiveHeader narrow={false} />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "Bản gốc" }));

  // Assert
  expect(useSessionStore.getState().viewOrig).toBe(true);
});
