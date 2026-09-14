import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { upsertUtterance } from "@/hooks/live-session/utterance-mapping";
import { createInitialState, useSessionStore } from "@/stores/session-store";

/**
 * Bản local sinh từ stream mang id tạm ÂM; bản broadcast/backfill mang `seq` dương.
 * Không nối hai bản qua `client_utt_id` thì mỗi câu nói hiện HAI lần trên transcript
 * (đo thật 2026-08-24) — và transcript nhân đôi chảy thẳng vào báo cáo.
 */

const BASE = {
  speaker: "candidate" as const,
  lang: "vi",
  text_orig: "Tôi có 5 năm kinh nghiệm.",
  translations: { vi: "Tôi có 5 năm kinh nghiệm.", ja: null, en: null },
  qid: 0,
  partial: false,
};

beforeEach(() => {
  useSessionStore.setState(createInitialState());
});

describe("upsertUtterance — nối bản local với seq server", () => {
  test("test_upsert_reconciles_temp_negative_id_to_server_seq_without_duplicating", () => {
    // Arrange — bản local từ stream (id âm), có client_utt_id
    const idMap = new Map<string, number>();
    upsertUtterance({ ...BASE, id: -1, time: "00:00:23", clientUttId: "c-1" }, idMap);

    // Act — broadcast trả về cùng câu đó với seq thật
    upsertUtterance({ ...BASE, id: 5, time: "00:00:23", clientUttId: "c-1" }, idMap);

    // Assert — MỘT bubble, mang seq server
    const utts = useSessionStore.getState().utts;
    expect(utts).toHaveLength(1);
    expect(utts[0].id).toBe(5);
    expect(idMap.get("c-1")).toBe(5);
  });

  test("test_upsert_same_client_utt_id_twice_is_idempotent", () => {
    // Arrange — broadcast lặp (Realtime gửi trùng) sau khi đã reconcile
    const idMap = new Map<string, number>();
    upsertUtterance({ ...BASE, id: -1, time: "00:00:23", clientUttId: "c-1" }, idMap);
    upsertUtterance({ ...BASE, id: 5, time: "00:00:23", clientUttId: "c-1" }, idMap);

    // Act
    upsertUtterance({ ...BASE, id: 5, time: "00:00:23", clientUttId: "c-1" }, idMap);

    // Assert
    expect(useSessionStore.getState().utts).toHaveLength(1);
  });

  test("test_upsert_different_client_utt_id_keeps_separate_utterances", () => {
    // Arrange — hai câu nói KHÁC nhau không được gộp nhầm
    const idMap = new Map<string, number>();
    upsertUtterance({ ...BASE, id: -1, time: "00:00:23", clientUttId: "c-1" }, idMap);

    // Act
    upsertUtterance({ ...BASE, id: -2, time: "00:00:31", clientUttId: "c-2" }, idMap);

    // Assert
    expect(useSessionStore.getState().utts).toHaveLength(2);
  });
});
