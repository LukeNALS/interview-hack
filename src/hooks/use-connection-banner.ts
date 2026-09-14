"use client";

import { useCallback, useRef } from "react";
import { useSessionStore } from "@/stores/session-store";

const RESTORED_AUTO_HIDE_MS = 2400;

export interface UseConnectionBannerApi {
  /** ~6-8s đầu không có tín hiệu âm thanh (SU R3) — banner vàng, KHÔNG tự ẩn (giữ tới khi có tín hiệu). */
  showSilent: () => void;
  /** Soniox WS/Realtime rớt — banner vàng, KHÔNG tự ẩn. */
  showDegraded: () => void;
  /** Nối lại — banner xanh, tự ẩn sau vài giây. */
  showRestored: () => void;
  clear: () => void;
}

/** Điều phối banner kết nối màn live qua field `banner` dùng chung trong session-store. */
export function useConnectionBanner(): UseConnectionBannerApi {
  const patch = useSessionStore((s) => s.patch);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showSilent = useCallback(() => {
    clearHideTimer();
    patch({ banner: "silent" });
  }, [clearHideTimer, patch]);

  const showDegraded = useCallback(() => {
    clearHideTimer();
    patch({ banner: "lost" });
  }, [clearHideTimer, patch]);

  const showRestored = useCallback(() => {
    clearHideTimer();
    patch({ banner: "ok" });
    hideTimer.current = setTimeout(() => patch({ banner: null }), RESTORED_AUTO_HIDE_MS);
  }, [clearHideTimer, patch]);

  const clear = useCallback(() => {
    clearHideTimer();
    patch({ banner: null });
  }, [clearHideTimer, patch]);

  return { showSilent, showDegraded, showRestored, clear };
}
