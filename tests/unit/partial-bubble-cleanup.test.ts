import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createInitialState, useSessionStore } from "@/stores/session-store";

/**
 * Bubble partial dùng id cố định -1/-2, time rỗng. Không dọn khi final thay thế
 * → ô trắng không timestamp nằm lại giữa transcript (bug 2026-08-24, session f6248d99).
 * Test khoá hành vi store — logic gọi removeUtt nằm ở attach-stream (onFinal/onPartial rỗng).
 */

const PARTIAL = {
  id: -1, pv: 1 as const, lang: "VI" as const, orig: "đang gõ", vi: "đang gõ",
  ja: "đang gõ", en: "đang gõ", qid: 0, disp: "đang gõ", partial: true, time: "",
};

beforeEach(() => {
  useSessionStore.setState(createInitialState());
});

describe("removeUtt — dọn bubble partial", () => {
  test("test_remove_utt_deletes_partial_bubble_by_negative_id", () => {
    // Arrange
    const store = useSessionStore.getState();
    store.appendUtt(PARTIAL);
    store.appendUtt({ ...PARTIAL, id: 5, partial: false, time: "00:00:09", orig: "Bạn." });

    // Act
    useSessionStore.getState().removeUtt(-1);

    // Assert — bubble final giữ nguyên, bubble partial biến mất
    const utts = useSessionStore.getState().utts;
    expect(utts).toHaveLength(1);
    expect(utts[0].id).toBe(5);
  });

  test("test_remove_utt_missing_id_is_noop", () => {
    // Arrange
    useSessionStore.getState().appendUtt({ ...PARTIAL, id: 7, partial: false });

    // Act
    useSessionStore.getState().removeUtt(-2);

    // Assert
    expect(useSessionStore.getState().utts).toHaveLength(1);
  });
});
