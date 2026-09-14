import { create } from "zustand";
import type {
  BannerKind,
  InterviewMode,
  LiveTab,
  SetupStep,
  TransLang,
  UiInsight,
  UiSuggestion,
  UiUtterance,
} from "@/types/ui";

/** Live/UI state của 1 buổi phỏng vấn — port từ init() của file design. */
export interface SessionState {
  /** Phiên mà state hiện tại đang thuộc về — null = chưa gắn phiên nào (vừa reset / màn Chuẩn bị). */
  sessionId: string | null;
  // Setup
  setupStep: SetupStep;
  mode: InterviewMode | null;
  // Live
  elapsed: number;
  /** Tên ứng viên + vị trí của buổi ĐANG mở — nguồn thật từ `GET /sessions/:id`
   *  (trước đây header/bubble đọc MOCK_SESSION nên luôn hiện "Nguyễn Minh Tuấn"). */
  candidateName: string;
  position: string;
  utts: UiUtterance[];
  suggs: UiSuggestion[];
  insights: UiInsight[];
  banner: BannerKind | null;
  viewOrig: boolean;
  expUtt: number;
  transLang: TransLang;
  liveTab: LiveTab;
  narrow: boolean;
  confirmEnd: boolean;
  // Toast
  toast: string;
}

export interface SessionActions {
  /** Setter chung cho các field đơn giản. */
  patch: (partial: Partial<SessionState>) => void;
  appendUtt: (utt: UiUtterance) => void;
  patchUtt: (id: number, patch: Partial<UiUtterance>) => void;
  /** Gỡ 1 lượt thoại — dùng dọn bubble partial (id âm cố định) khi final đã thay thế. */
  removeUtt: (id: number) => void;
  /** Tối đa 2 card gợi ý cùng lúc (slice(-2) như design). */
  addSuggestion: (sugg: UiSuggestion) => void;
  removeSuggestion: (id: number) => void;
  addInsight: (insight: UiInsight) => void;
  /** Hiện toast pill, tự ẩn sau TOAST_DURATION_MS. */
  showToast: (message: string) => void;
  hideToast: () => void;
  /**
   * Gắn store vào 1 phiên (N5). Store là singleton module-scope nên vào phiên KHÁC trong
   * cùng tab phải dọn state của phiên cũ TRƯỚC khi dữ liệu phiên mới bơm vào — nếu không,
   * `upsertUtterance` khớp theo `id` (= seq server, bắt đầu từ 1 ở MỌI phiên) sẽ PATCH ĐÈ
   * lên dòng phiên cũ thay vì thay sạch, transcript phiên mới lẫn dòng phiên cũ.
   * Gắn LẦN ĐẦU (sessionId đang null) thì giữ nguyên state — dữ liệu màn Chuẩn bị của
   * chính phiên này đã nằm sẵn trong store.
   */
  enterSession: (sessionId: string) => void;
  /** "Buổi mới" — reset toàn bộ về màn Chuẩn bị (/candidate). */
  reset: () => void;
}

export const TOAST_DURATION_MS = 2400;
export const MAX_VISIBLE_SUGGESTIONS = 2;

/**
 * State THUỘC VỀ MỘT PHIÊN cụ thể — dọn khi chuyển sang phiên khác (`enterSession`).
 * Gồm dữ liệu phiên (transcript, gợi ý, insight) và mọi con trỏ/chỉ số trỏ vào dữ liệu
 * đó. KHÔNG gồm preference hiển thị (transLang/liveTab/narrow). Thêm field mới thuộc
 * phiên thì khai ở ĐÂY, `createInitialState()` tự thừa hưởng.
 */
export function createSessionScopedState() {
  return {
    elapsed: 0,
    candidateName: "Ứng viên",
    position: "",
    utts: [] as UiUtterance[],
    suggs: [] as UiSuggestion[],
    insights: [] as UiInsight[],
    banner: null as BannerKind | null,
    expUtt: -1,
    confirmEnd: false,
  };
}

export function createInitialState(): SessionState {
  return {
    sessionId: null,
    setupStep: "mode",
    mode: null,
    viewOrig: false,
    transLang: "vi",
    liveTab: "transcript",
    narrow: false,
    toast: "",
    ...createSessionScopedState(),
  };
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useSessionStore = create<SessionState & SessionActions>()(
  (set) => ({
    ...createInitialState(),
    patch: (partial) => set(partial),
    appendUtt: (utt) => set((s) => ({ utts: [...s.utts, utt] })),
    removeUtt: (id) => set((s) => ({ utts: s.utts.filter((u) => u.id !== id) })),
    patchUtt: (id, patch) =>
      set((s) => ({
        utts: s.utts.map((u) => (u.id === id ? { ...u, ...patch } : u)),
      })),
    addSuggestion: (sugg) =>
      set((s) => ({
        suggs: [...s.suggs, sugg].slice(-MAX_VISIBLE_SUGGESTIONS),
      })),
    removeSuggestion: (id) =>
      set((s) => ({ suggs: s.suggs.filter((x) => x.id !== id) })),
    addInsight: (insight) =>
      set((s) => ({ insights: [...s.insights, insight] })),
    showToast: (message) => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: message });
      toastTimer = setTimeout(() => set({ toast: "" }), TOAST_DURATION_MS);
    },
    hideToast: () => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: "" });
    },
    enterSession: (sessionId) =>
      set((s) => {
        if (s.sessionId === sessionId) return s;
        // Lần đầu gắn phiên trong tab: state đang có là của chính phiên này (đi thẳng từ
        // màn Chuẩn bị sang) -> giữ nguyên.
        if (s.sessionId === null) return { sessionId };
        return { ...createSessionScopedState(), sessionId };
      }),
    reset: () => {
      if (toastTimer) clearTimeout(toastTimer);
      set(createInitialState());
    },
  }),
);
