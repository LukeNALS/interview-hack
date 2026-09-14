"use client";

import { useEffect, useRef, useState } from "react";
import type { UttLang } from "@/types/ui";

/** Nhịp stream theo design: JA ~65ms/ký tự, VI ~100ms/từ (EN như VI). */
export const STREAM_STEP_MS: Record<UttLang, number> = {
  JA: 65,
  VI: 100,
  EN: 100,
};

const MIN_STEP_MS = 30;

interface UseStreamingTextOptions {
  /** false = hiện tức thì (bubble cũ render tĩnh, chỉ stream bubble cuối). */
  enabled?: boolean;
  /** Gọi đúng 1 lần khi stream xong — lúc này mới gắn timestamp. */
  onComplete?: () => void;
}

interface StreamState {
  key: string;
  displayed: string;
  done: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Stream text từng ký tự (JA) / từng từ (VI, EN).
 * Tôn trọng prefers-reduced-motion: hiện tức thì và báo complete ngay.
 */
export function useStreamingText(
  text: string,
  lang: UttLang,
  options: UseStreamingTextOptions = {},
): { displayed: string; done: boolean } {
  const { enabled = true } = options;
  const instant = !enabled || !text || prefersReducedMotion();
  const key = `${lang}|${String(enabled)}|${text}`;
  const freshState = (): StreamState => ({
    key,
    displayed: instant ? text : "",
    done: instant,
  });

  const [state, setState] = useState<StreamState>(freshState);
  // Input đổi → reset đồng bộ ngay trong render (pattern "adjust state in render").
  if (state.key !== key) setState(freshState());

  // Giữ callback mới nhất — sync trong effect (không ghi ref lúc render).
  const onCompleteRef = useRef(options.onComplete);
  useEffect(() => {
    onCompleteRef.current = options.onComplete;
  });
  const notifiedRef = useRef<string | null>(null);

  useEffect(() => {
    const notifyOnce = () => {
      if (notifiedRef.current === key) return;
      notifiedRef.current = key;
      onCompleteRef.current?.();
    };

    if (instant) {
      notifyOnce();
      return;
    }

    const segs = lang === "JA" ? Array.from(text) : text.split(" ");
    const joiner = lang === "JA" ? "" : " ";
    const step = Math.max(MIN_STEP_MS, STREAM_STEP_MS[lang]);
    let k = 0;
    const timer = setInterval(() => {
      k += 1;
      if (k >= segs.length) {
        clearInterval(timer);
        setState({ key, displayed: text, done: true });
        notifyOnce();
        return;
      }
      setState({ key, displayed: segs.slice(0, k).join(joiner), done: false });
    }, step);
    return () => clearInterval(timer);
  }, [key, text, lang, instant]);

  const current = state.key === key ? state : freshState();
  return { displayed: current.displayed, done: current.done };
}
