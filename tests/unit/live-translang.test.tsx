import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LiveTranscriptPane } from "@/components/live/live-transcript-pane";
import { createInitialState, useSessionStore } from "@/stores/session-store";
import type { UiUtterance } from "@/types/ui";

const noop = () => {};

function renderPane() {
  return render(<LiveTranscriptPane streamingId={null} onStreamComplete={noop} />);
}

// vitest không bật globals → RTL không tự cleanup, phải gọi tay.
afterEach(cleanup);

test("test_transcript_translang_vi_shows_stored_vi_translation_without_network", () => {
  // Arrange — utterance JA gốc đã ingest xong, đủ 3 bản dịch (translations đã lưu, không gọi server khi đổi transLang)
  const utt: UiUtterance = {
    id: 1, pv: 1, lang: "JA", orig: "こんにちは", vi: "Xin chào", ja: "こんにちは", en: "Hello",
    disp: "こんにちは", partial: false, time: "00:00:10",
  };
  useSessionStore.setState({ ...createInitialState(), viewOrig: false, transLang: "vi", utts: [utt] });

  // Act
  renderPane();

  // Assert
  expect(screen.getByText("Xin chào")).toBeInTheDocument();
});

test("test_transcript_translang_switch_to_en_rerenders_same_utterance_from_store", () => {
  // Arrange — cùng 1 utterance, đổi transLang sang "en" (0 request server — chỉ đọc translations đã có)
  const utt: UiUtterance = {
    id: 1, pv: 1, lang: "JA", orig: "こんにちは", vi: "Xin chào", ja: "こんにちは", en: "Hello",
    disp: "こんにちは", partial: false, time: "00:00:10",
  };
  useSessionStore.setState({ ...createInitialState(), viewOrig: false, transLang: "en", utts: [utt] });

  // Act
  renderPane();

  // Assert
  expect(screen.getByText("Hello")).toBeInTheDocument();
  expect(screen.queryByText("Xin chào")).not.toBeInTheDocument();
});

test("test_transcript_english_only_utterance_shows_orig_text_without_dich_or_crash", () => {
  // Arrange — lượt thuần en: BE trả translations.vi/ja=null -> hook (use-live-session) coalesce
  // về text_orig khi build UiUtterance (giống quy ước mocks/utterances.ts cũ). Đây là kết quả
  // ĐÃ coalesce — validate translationFor không crash/không hiện rỗng với input này.
  const origText = "I have five years of experience";
  const utt: UiUtterance = {
    id: 2, pv: 0, lang: "EN", orig: origText, vi: origText, ja: origText, en: origText,
    disp: origText, partial: false, time: "00:00:20",
  };
  useSessionStore.setState({ ...createInitialState(), viewOrig: false, transLang: "vi", utts: [utt] });

  // Act
  renderPane();

  // Assert — hiện bản gốc (KHÔNG hiện chuỗi rỗng/"null"/"undefined", không throw khi render)
  expect(screen.getByText(origText)).toBeInTheDocument();
});

test("test_transcript_english_only_utterance_consistent_across_all_translang_choices", () => {
  // Arrange
  const origText = "please introduce yourself briefly";
  const utt: UiUtterance = {
    id: 3, pv: 1, lang: "EN", orig: origText, vi: origText, ja: origText, en: origText,
    disp: origText, partial: false, time: "00:00:30",
  };

  for (const lang of ["vi", "ja", "en"] as const) {
    // Act
    useSessionStore.setState({ ...createInitialState(), viewOrig: false, transLang: lang, utts: [utt] });
    const { unmount } = renderPane();

    // Assert — mọi lựa chọn transLang đều fallback về bản gốc, không crash
    expect(screen.getByText(origText)).toBeInTheDocument();
    unmount();
  }
});
