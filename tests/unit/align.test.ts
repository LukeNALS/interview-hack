import { describe, expect, test } from "vitest";
import { AlignBuffer, computeIou, mapSpeakerLabels, type AlignedUtterance } from "@/lib/transcript/align";
import canonicalFixture from "../fixtures/soniox-tokens/canonical-ja-vi-final.json";
import enFixture from "../fixtures/soniox-tokens/en-final.json";

/** Builds an AlignBuffer with a manually-triggerable wait — tests call `fireWait()`
 *  instead of real/fake timers, keeping the 1.2s "wait for en" delay deterministic. */
function buildDeterministicBuffer(onEmit: (u: AlignedUtterance, isUpdate: boolean) => void) {
  let pendingCb: (() => void) | null = null;
  const buffer = new AlignBuffer({
    onEmit,
    scheduleWait: (cb) => {
      pendingCb = cb;
      return () => {
        pendingCb = null;
      };
    },
  });
  return { buffer, fireWait: () => pendingCb?.() };
}

// Translation tokens carry no timing of their own in the real Soniox format (only
// `original`-status tokens do) — so utterance timing always comes from the `original`
// subset, matching the fixtures under tests/fixtures/soniox-tokens/.
function canonicalFromFixture(clientUttId: string) {
  const tokens = canonicalFixture.messages[0].tokens.filter((t) => t.text !== "<end>");
  const original = tokens.filter((t) => t.translation_status === "original");
  const translated = tokens.filter((t) => t.translation_status === "translation").map((t) => t.text).join("");
  return {
    client_utt_id: clientUttId,
    speaker: "interviewer",
    lang: "ja",
    text_orig: original.map((t) => t.text).join(""),
    translations: { vi: translated, ja: null },
    t_start_ms: original[0].start_ms ?? 0,
    t_end_ms: original.at(-1)?.end_ms ?? 0,
  };
}

function enFromFixture() {
  const tokens = enFixture.messages[0].tokens.filter((t) => t.text !== "<end>");
  const original = tokens.filter((t) => t.translation_status === "original");
  const translated = tokens.filter((t) => t.translation_status === "translation").map((t) => t.text).join("");
  return {
    text_en: translated,
    t_start_ms: original[0].start_ms ?? 0,
    t_end_ms: original.at(-1)?.end_ms ?? 0,
  };
}

describe("computeIou", () => {
  test("test_align_compute_iou_identical_ranges_returns_one", () => {
    // Arrange
    const a = { t_start_ms: 100, t_end_ms: 500 };
    const b = { t_start_ms: 100, t_end_ms: 500 };
    // Act
    const iou = computeIou(a, b);
    // Assert
    expect(iou).toBe(1);
  });
});

describe("align — merge canonical + en finals", () => {
  test("test_align_two_finals_with_iou_above_threshold_merges_into_one_utterance", () => {
    // Arrange — canonical + en finals for the SAME utterance (built from real-format fixtures)
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    const canonical = canonicalFromFixture("mic:0");
    const en = enFromFixture();

    // Act
    buffer.addCanonicalFinal(canonical);
    buffer.addEnFinal(en);

    // Assert
    expect(results).toHaveLength(1);
    const [merged, isUpdate] = results[0];
    expect(isUpdate).toBe(false);
    expect(merged.client_utt_id).toBe("mic:0");
    expect(merged.text_orig).toBe(canonical.text_orig);
    expect(merged.translations.vi).toBe(canonical.translations.vi);
    expect(merged.translations.en).toBe(en.text_en);
    expect(merged.en_pending).toBe(false);
  });

  test("test_align_missing_en_final_emits_utterance_with_en_pending_true", () => {
    // Arrange — canonical final arrives, matching en final never does
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer, fireWait } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    const canonical = canonicalFromFixture("mic:0");

    // Act
    buffer.addCanonicalFinal(canonical);
    fireWait(); // simulate the 1.2s wait elapsing with no matching en final

    // Assert
    expect(results).toHaveLength(1);
    const [emitted] = results[0];
    expect(emitted.en_pending).toBe(true);
    expect(emitted.translations.en).toBeNull();
    expect(emitted.text_orig).toBe(canonical.text_orig);
  });

  test("test_align_late_en_final_updates_existing_utterance_by_client_utt_id", () => {
    // Arrange — canonical times out first (en_pending), en final arrives late
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer, fireWait } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    const canonical = canonicalFromFixture("mic:0");
    const en = enFromFixture();
    buffer.addCanonicalFinal(canonical);
    fireWait();
    expect(results).toHaveLength(1);
    expect(results[0][0].en_pending).toBe(true);

    // Act — late en final arrives after the timeout already emitted en_pending=true
    buffer.addEnFinal(en);

    // Assert — same client_utt_id, upsert (isUpdate=true), en_pending flips to false
    expect(results).toHaveLength(2);
    const [updated, isUpdate] = results[1];
    expect(isUpdate).toBe(true);
    expect(updated.client_utt_id).toBe(canonical.client_utt_id);
    expect(updated.translations.en).toBe(en.text_en);
    expect(updated.en_pending).toBe(false);
  });

  test("test_align_iou_below_threshold_does_not_match_and_canonical_times_out", () => {
    // Arrange — en final's time range does not overlap the canonical final at all
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer, fireWait } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    const canonical = canonicalFromFixture("mic:0");
    const farAwayEn = { text_en: "unrelated", t_start_ms: 50_000, t_end_ms: 51_000 };

    // Act
    buffer.addCanonicalFinal(canonical);
    buffer.addEnFinal(farAwayEn);
    fireWait();

    // Assert — no match, canonical still emits (timed out) with en_pending true
    expect(results).toHaveLength(1);
    expect(results[0][0].en_pending).toBe(true);
  });
});

describe("mapSpeakerLabels — direct mode speaker overlap mapping", () => {
  test("test_align_map_speaker_labels_majority_overlap_maps_correctly", () => {
    // Arrange — 3 paired utterances, "Speaker 1"<->"Speaker A" majority (2/3), "Speaker 2"<->"Speaker B"
    const pairs = [
      { canonicalSpeaker: "Speaker 1", enSpeaker: "Speaker A" },
      { canonicalSpeaker: "Speaker 1", enSpeaker: "Speaker A" },
      { canonicalSpeaker: "Speaker 1", enSpeaker: "Speaker B" },
      { canonicalSpeaker: "Speaker 2", enSpeaker: "Speaker B" },
    ];

    // Act
    const mapping = mapSpeakerLabels(pairs);

    // Assert
    expect(mapping.get("Speaker 1")).toBe("Speaker A");
    expect(mapping.get("Speaker 2")).toBe("Speaker B");
  });

  test("test_align_map_speaker_labels_no_pairs_returns_empty_map", () => {
    // Arrange + Act
    const mapping = mapSpeakerLabels([]);
    // Assert — caller falls back to canonical's own speaker label (§Architecture step 7)
    expect(mapping.size).toBe(0);
  });
});

/**
 * N4 — `dispose()` chạy trong `closeAllStreamsOnce` ← `disposeLivePipeline` ← `endInterview()`.
 * Người dùng thường bấm "Kết thúc" NGAY sau câu nói cuối, tức rơi đúng cửa sổ chờ EN 1.2s:
 * canonical-final đang nằm trong `pendingCanonical`, timer chưa trôi. Trước bản vá, `dispose()`
 * chỉ `cancel()` -> câu cuối biến mất trước khi tới `onEmit`, không cơ chế flush nào cứu được
 * (nó chưa từng vào `ingestQueue`). Ngữ nghĩa đúng: dispose = "hết giờ chờ NGAY", emit y hệt
 * `onCanonicalWaitTimeout` (en=null / en_pending=true), giống hệt khi timer trôi tự nhiên.
 */
describe("AlignBuffer.dispose — không nuốt canonical-final đang chờ EN (N4)", () => {
  test("test_align_dispose_with_canonical_still_waiting_for_en_emits_it_with_en_pending", () => {
    // Arrange — canonical-final tới, KHÔNG có en khớp: nằm chờ, timer 1.2s CHƯA trôi
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    buffer.addCanonicalFinal(canonicalFromFixture("mic:0"));
    expect(results).toHaveLength(0);

    // Act — user bấm "Kết thúc" đúng trong cửa sổ chờ EN
    buffer.dispose();

    // Assert — câu cuối vẫn ra, đánh dấu chờ EN (KHÔNG mất im lặng)
    expect(results).toHaveLength(1);
    expect(results[0][0].client_utt_id).toBe("mic:0");
    expect(results[0][0].translations.en).toBeNull();
    expect(results[0][0].en_pending).toBe(true);
    expect(results[0][1]).toBe(false);
  });

  test("test_align_dispose_called_twice_emits_pending_canonical_only_once", () => {
    // Arrange — closeAllStreamsOnce có thể chạy lại (endInterview rồi unmount ngay sau đó)
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    buffer.addCanonicalFinal(canonicalFromFixture("mic:0"));

    // Act
    buffer.dispose();
    buffer.dispose();

    // Assert — idempotent: không đẻ utterance trùng
    expect(results).toHaveLength(1);
  });

  test("test_align_dispose_with_nothing_pending_emits_nothing", () => {
    // Arrange — canonical đã khớp EN và emit xong từ trước, buffer rỗng
    const results: Array<[AlignedUtterance, boolean]> = [];
    const { buffer } = buildDeterministicBuffer((u, isUpdate) => results.push([u, isUpdate]));
    buffer.addCanonicalFinal(canonicalFromFixture("mic:0"));
    buffer.addEnFinal(enFromFixture());
    expect(results).toHaveLength(1);

    // Act
    buffer.dispose();

    // Assert — không có utterance ma nào sinh thêm lúc đóng
    expect(results).toHaveLength(1);
  });
});
