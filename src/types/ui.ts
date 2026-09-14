/**
 * View model cho các màn FE (Interview Hack — chỉ ứng viên). KHÔNG đụng types/api.ts.
 */

/** Màn hình chính của luồng phỏng vấn (URL là nguồn sự thật) — chỉ còn setup → live. */
export type Screen = "setup" | "live";

/** Trạng thái session phía server (khớp enum `session_status` trong DB). */
export type SessionStatus = "prep" | "live" | "processing" | "done" | "failed";

export type SetupStep = "mode" | "tab-guide";
export type InterviewMode = "online" | "direct";
export type LiveTab = "transcript" | "suggest";
export type TransLang = "vi" | "ja" | "en";
export type UttLang = "JA" | "VI" | "EN";
/**
 * "silent" thêm ở P05 (wave FE) cho banner "chưa nhận được âm thanh" —
 * deviation ownership: kéo theo sửa `src/components/common/banner.tsx`
 * (không thuộc ownership gốc P05-FE, xem report phase-05-fe deviation #1).
 */
export type BannerKind = "lost" | "ok" | "silent";

export interface UiUtterance {
  id: number;
  /** 1 = người phỏng vấn, 0 = ứng viên. */
  pv: 0 | 1;
  lang: UttLang;
  orig: string;
  vi: string;
  ja: string;
  en: string;
  /** Text đang hiển thị (stream dần khi partial). */
  disp: string;
  partial: boolean;
  /** "00:MM:SS" — chỉ gắn khi stream xong. */
  time: string;
}

export interface UiSuggestion {
  id: number;
  text: string;
}

export interface UiInsight {
  time: string;
  text: string;
}
