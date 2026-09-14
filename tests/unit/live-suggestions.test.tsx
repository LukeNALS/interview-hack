import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LiveSuggestionColumn } from "@/components/live/live-suggestion-column";
import { MOCK_SUGGESTIONS } from "@/mocks/utterances";
import {
  createInitialState,
  useSessionStore,
} from "@/stores/session-store";

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.setState({
    ...createInitialState(),
    suggs: [...MOCK_SUGGESTIONS],
  });
});

// vitest không bật globals → RTL không tự cleanup, phải gọi tay.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("test_live_suggestion_skip_removes_card", () => {
  // Arrange
  render(<LiveSuggestionColumn narrow={false} />);

  // Act
  fireEvent.click(screen.getAllByText("Bỏ qua")[0]);

  // Assert
  const state = useSessionStore.getState();
  expect(state.suggs).toHaveLength(1);
  expect(state.suggs[0].id).toBe(MOCK_SUGGESTIONS[1].id);
});

test("test_live_suggestion_empty_shows_candidate_placeholder_hint", () => {
  // Arrange
  useSessionStore.setState({ suggs: [] });

  // Act
  render(<LiveSuggestionColumn narrow={false} />);

  // Assert
  expect(
    screen.getByText("Khi người phỏng vấn đặt câu hỏi, gợi ý trả lời sẽ hiện ở đây."),
  ).toBeInTheDocument();
});

test("test_live_suggestion_insights_section_hidden_when_empty", () => {
  // Arrange — insights rỗng (Phase 1)
  render(<LiveSuggestionColumn narrow={false} />);

  // Assert — đúng design: section NHẬN ĐỊNH CHUNG ẩn hẳn khi chưa có
  expect(screen.queryByText("NHẬN ĐỊNH CHUNG")).not.toBeInTheDocument();
});
