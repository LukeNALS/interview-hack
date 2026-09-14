import type { UiUtterance } from "@/types/ui";

/** Một nhóm chat: các lượt thoại LIÊN TIẾP của cùng một người nói (N13a). */
export interface UtteranceGroup {
  /** id lượt đầu nhóm — dùng làm React key, ổn định khi nhóm dài ra. */
  key: number;
  pv: 0 | 1;
  utts: UiUtterance[];
}

/**
 * Gộp transcript phẳng thành nhóm theo người nói — thuần, O(n), không đọc store.
 * Đổi `pv` là cắt nhóm; partial (id âm) nối đuôi nhóm cùng người như lượt thường.
 */
export function groupUtterancesBySpeaker(utts: readonly UiUtterance[]): UtteranceGroup[] {
  const groups: UtteranceGroup[] = [];
  for (const utt of utts) {
    const last = groups[groups.length - 1];
    if (last && last.pv === utt.pv) last.utts.push(utt);
    else groups.push({ key: utt.id, pv: utt.pv, utts: [utt] });
  }
  return groups;
}
