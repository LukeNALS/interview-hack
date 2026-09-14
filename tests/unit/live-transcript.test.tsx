import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NO_STREAMING_ID } from "@/components/live/live-screen";
import { LiveTranscriptPane } from "@/components/live/live-transcript-pane";
import { mockUtterances, RAW_UTTERANCES } from "@/mocks/utterances";
import { createInitialState, useSessionStore } from "@/stores/session-store";

const noop = () => {};

beforeEach(() => {
  // Transcript giữa buổi — lượt cuối (id 9) đang partial, chưa có timestamp.
  useSessionStore.setState({
    ...createInitialState(),
    utts: mockUtterances(),
  });
});

// vitest không bật globals → RTL không tự cleanup, phải gọi tay.
afterEach(cleanup);

test("test_live_transcript_partial_bubble_renders_without_timestamp", () => {
  // Arrange + Act
  const { container } = render(
    <LiveTranscriptPane streamingId={null} onStreamComplete={noop} />,
  );

  // Assert — bubble partial: mờ .55, KHÔNG timestamp
  const partial = container.querySelector("#utt-9");
  expect(partial).not.toBeNull();
  expect(partial).toHaveClass("opacity-55");
  expect(partial?.querySelector(".tabular-nums")?.textContent).toBe("");

  // Bubble hoàn chỉnh có timestamp
  const complete = container.querySelector("#utt-1");
  expect(complete).toHaveClass("opacity-100");
  expect(complete?.querySelector(".tabular-nums")?.textContent).toBe(
    "00:02:14",
  );
});

test("test_live_transcript_complete_bubble_click_expands_bilingual_panel", () => {
  // Arrange
  const { container } = render(
    <LiveTranscriptPane streamingId={null} onStreamComplete={noop} />,
  );

  // Act — bấm bubble hoàn chỉnh đầu tiên
  fireEvent.click(container.querySelector("#utt-1") as HTMLElement);

  // Assert — mở song song BẢN GỐC + BẢN DỊCH
  expect(useSessionStore.getState().expUtt).toBe(1);
  expect(screen.getByText("BẢN GỐC · JA")).toBeInTheDocument();
  expect(screen.getByText("BẢN DỊCH · VI")).toBeInTheDocument();
  expect(screen.getByText(RAW_UTTERANCES[0].orig)).toBeInTheDocument();
  expect(
    screen.getByText("Đang mở cả hai bản — bấm để đóng"),
  ).toBeInTheDocument();

  // Act — bấm lại để đóng
  fireEvent.click(container.querySelector("#utt-1") as HTMLElement);
  expect(useSessionStore.getState().expUtt).toBe(-1);
});

test("test_live_transcript_partial_bubble_click_does_not_expand", () => {
  // Arrange
  const { container } = render(
    <LiveTranscriptPane streamingId={null} onStreamComplete={noop} />,
  );

  // Act
  fireEvent.click(container.querySelector("#utt-9") as HTMLElement);

  // Assert
  expect(useSessionStore.getState().expUtt).toBe(-1);
});

test("test_live_transcript_partial_bubble_with_temp_id_minus_one_renders_full_text_immediately", () => {
  // Arrange — bubble partial của stream mic/mixed mang id tạm -1 (attach-stream.ts). Regression
  // 2026-08-25: LiveScreen từng dùng -1 làm sentinel "không stream" → bubble này bị typewriter
  // reset mỗi nhịp partial, chữ hiện-mất liên tục. Sentinel phải là null và text hiện NGAY.
  const text = "một hai ba bốn năm sáu";
  useSessionStore.setState({
    ...createInitialState(),
    utts: [{ id: -1, pv: 1, lang: "VI", orig: text, vi: text, ja: text, en: text, disp: text, partial: true, time: "" }],
  });

  // Act
  const { container } = render(
    <LiveTranscriptPane streamingId={NO_STREAMING_ID} onStreamComplete={noop} />,
  );

  // Assert — không typewriter: đủ text ngay ở lần render đầu, không chờ timer
  expect(NO_STREAMING_ID).toBeNull();
  expect(container.querySelector("#utt--1")?.textContent).toContain(text);
});

/** Lượt thoại tối giản cho test nhóm N13a. */
function makeUtt(id: number, pv: 0 | 1) {
  const text = `câu ${id}`;
  return { id, pv, lang: "VI" as const, orig: text, vi: text, ja: text, en: text, disp: text, partial: false, time: "00:00:10" };
}

test("test_live_transcript_groups_consecutive_same_speaker_into_one_header", () => {
  // Arrange — PV nói 2 câu liền, ứng viên 1 câu, PV thêm 1 câu → 3 nhóm (2 nhóm PV)
  useSessionStore.setState({
    ...createInitialState(),
    candidateName: "Tuấn",
    utts: [makeUtt(1, 1), makeUtt(2, 1), makeUtt(3, 0), makeUtt(4, 1)],
  });

  // Act
  render(<LiveTranscriptPane streamingId={null} onStreamComplete={noop} />);

  // Assert — tên hiện 1 lần/nhóm, KHÔNG lặp theo từng bubble
  expect(screen.getAllByText("Người phỏng vấn")).toHaveLength(2);
  expect(screen.getAllByText("Tuấn")).toHaveLength(1);
});

test("test_live_transcript_list_rows_have_no_bubble_background", () => {
  // Arrange — pivot 2026-09-03: transcript là LIST phẳng, không ô chat/bong bóng
  useSessionStore.setState({
    ...createInitialState(),
    candidateName: "Tuấn",
    utts: [makeUtt(1, 1), makeUtt(2, 0)],
  });

  // Act
  const { container } = render(
    <LiveTranscriptPane streamingId={null} onStreamComplete={noop} />,
  );

  // Assert — hàng text trần: không nền, không bo góc, không giới hạn bề ngang, không căn phải
  for (const id of ["#utt-1", "#utt-2"]) {
    expect(container.querySelector(id)?.className).not.toMatch(/bg-|rounded-|max-w-/);
  }
  expect(container.querySelector('[data-pv="1"]')?.className).not.toContain("items-end");
});

test("test_live_transcript_empty_state_shows_listening_hint", () => {
  // Arrange
  useSessionStore.setState({ utts: [] });

  // Act
  render(<LiveTranscriptPane streamingId={null} onStreamComplete={noop} />);

  // Assert
  expect(
    screen.getByText("Bắt đầu nói chuyện, transcript sẽ hiện ở đây"),
  ).toBeInTheDocument();
  expect(screen.getByText("ĐANG NGHE ÂM THANH TỪ CUỘC HỌP")).toBeInTheDocument();
});
