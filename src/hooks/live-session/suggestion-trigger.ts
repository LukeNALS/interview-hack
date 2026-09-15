/**
 * Trigger "gợi ý đào sâu" (N13b, plan 20260904-1110) — logic THUẦN, DI toàn bộ side-effect
 * (clock + timer) để unit test chạy fake-clock không timer thật.
 *
 * Hành vi đã chốt với Luke 2026-09-04:
 *  - Mỗi utterance.final của ỨNG VIÊN → reset debounce 2.5s (đợi họ nói xong hẳn).
 *  - Interview Hack (gợi ý TRẢ LỜI): KHÔNG có khoảng cách tối thiểu — mỗi câu hỏi mới của
 *    người phỏng vấn đều cần gợi ý (2026-09-15: khoảng 20s cũ nuốt 2/3 câu hỏi trong buổi test).
 *    Debounce 2.5s vẫn gộp các lượt dồn dập; trần chi phí nằm ở rate limit route answer-hint.
 *  - (Tham số minGapMs vẫn giữ để test/tái dùng) Debounce cháy mà chưa đủ minGapMs → BỎ QUA;
 *    lượt final kế tiếp sẽ kích lại — tránh dội gợi ý dồn cục.
 *  - post() là best-effort: rejection bị nuốt (429/mạng/409 không được phá chu kỳ sau).
 */

export interface SuggestionTriggerDeps {
  post: () => Promise<unknown>;
  debounceMs?: number;
  minGapMs?: number;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SuggestionTrigger {
  /** Gọi khi nhận utterance.final có speaker === "candidate". */
  onCandidateFinal(): void;
  /** Gọi khi pipeline dispose — huỷ debounce đang chờ, khoá mọi kích hoạt sau đó. */
  dispose(): void;
}

export const SUGGESTION_DEBOUNCE_MS = 2500;
export const SUGGESTION_MIN_GAP_MS = 0;

export function createSuggestionTrigger(deps: SuggestionTriggerDeps): SuggestionTrigger {
  const debounceMs = deps.debounceMs ?? SUGGESTION_DEBOUNCE_MS;
  const minGapMs = deps.minGapMs ?? SUGGESTION_MIN_GAP_MS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let handle: unknown = null;
  let lastPostAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const fire = () => {
    handle = null;
    if (disposed) return;
    if (now() - lastPostAt < minGapMs) return;
    lastPostAt = now();
    // Gọi ĐỒNG BỘ (không bọc microtask) — caller/test quan sát được ngay khi debounce cháy.
    // Best-effort: lỗi POST (sync lẫn async) đều nuốt, không unhandled, không chặn chu kỳ sau.
    try {
      void deps.post().catch(() => {});
    } catch {
      // post ném đồng bộ (lỗi lập trình phía caller) cũng không được phá trigger.
    }
  };

  return {
    onCandidateFinal() {
      if (disposed) return;
      if (handle !== null) clearTimer(handle);
      handle = setTimer(fire, debounceMs);
    },
    dispose() {
      disposed = true;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
  };
}
