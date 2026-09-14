import { expect, test } from "vitest";
import { groupUtterancesBySpeaker } from "@/components/live/live-transcript-grouping";
import type { UiUtterance } from "@/types/ui";

/** Utterance tối thiểu cho grouping — chỉ id/pv/partial có ý nghĩa với hàm này. */
function utt(id: number, pv: 0 | 1, partial = false): UiUtterance {
  const text = `lượt ${id}`;
  return { id, pv, lang: "VI", orig: text, vi: text, ja: text, en: text, disp: text, partial, time: partial ? "" : "00:00:10" };
}

test("test_grouping_empty_list_returns_no_groups", () => {
  // Arrange + Act
  const groups = groupUtterancesBySpeaker([]);

  // Assert
  expect(groups).toEqual([]);
});

test("test_grouping_consecutive_same_speaker_merges_into_one_group", () => {
  // Arrange
  const utts = [utt(1, 1), utt(2, 1), utt(3, 1)];

  // Act
  const groups = groupUtterancesBySpeaker(utts);

  // Assert
  expect(groups).toHaveLength(1);
  expect(groups[0].pv).toBe(1);
  expect(groups[0].utts.map((u) => u.id)).toEqual([1, 2, 3]);
});

test("test_grouping_speaker_change_starts_new_group", () => {
  // Arrange — PV, ứng viên, ứng viên, PV
  const utts = [utt(1, 1), utt(2, 0), utt(3, 0), utt(4, 1)];

  // Act
  const groups = groupUtterancesBySpeaker(utts);

  // Assert
  expect(groups.map((g) => g.pv)).toEqual([1, 0, 1]);
  expect(groups[1].utts.map((u) => u.id)).toEqual([2, 3]);
});

test("test_grouping_group_key_is_first_utterance_id", () => {
  // Arrange
  const utts = [utt(7, 1), utt(8, 1), utt(9, 0)];

  // Act
  const groups = groupUtterancesBySpeaker(utts);

  // Assert — key ổn định theo lượt đầu nhóm (React key, không đổi khi nhóm dài ra)
  expect(groups.map((g) => g.key)).toEqual([7, 9]);
});

test("test_grouping_partial_with_temp_negative_id_joins_same_speaker_group", () => {
  // Arrange — partial id -1 (attach-stream) nối đuôi nhóm PV đang nói
  const utts = [utt(1, 1), utt(-1, 1, true)];

  // Act
  const groups = groupUtterancesBySpeaker(utts);

  // Assert
  expect(groups).toHaveLength(1);
  expect(groups[0].utts.map((u) => u.id)).toEqual([1, -1]);
});
