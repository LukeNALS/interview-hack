import type { TransLang, UiUtterance } from "@/types/ui";

/** "00:MM:SS" — port fmt() từ file design (timer header + timestamp bubble). */
export function formatElapsed(totalSeconds: number): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `00:${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

/** "MM:SS" cho dòng NHẬN ĐỊNH CHUNG — design dùng fmt(elapsed).slice(3). */
export function formatInsightTime(totalSeconds: number): string {
  return formatElapsed(totalSeconds).slice(3);
}

/**
 * Bản dịch của lượt thoại theo ngôn ngữ bản dịch đang chọn —
 * port nguyên văn logic `trans` trong renderVals() file design.
 */
export function translationFor(utt: UiUtterance, transLang: TransLang): string {
  if (utt.lang === "VI") {
    if (transLang === "vi") return utt.orig;
    return transLang === "ja" ? utt.ja : utt.en;
  }
  if (transLang === "ja") return utt.orig;
  return transLang === "vi" ? utt.vi : utt.en;
}
