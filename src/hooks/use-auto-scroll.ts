"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** User được coi là "đã cuộn lên" khi cách đáy quá ngưỡng này (theo design). */
const BOTTOM_THRESHOLD_PX = 80;

/**
 * Auto-scroll đáy cho khung transcript. User cuộn lên → pause + cờ `paused`
 * để hiện pill "Xuống cuối"; `scrollToBottom()` resume + cuộn xuống ngay.
 *
 * @param signal - giá trị đổi khi có nội dung mới (vd utts.length / text stream).
 */
export function useAutoScroll<T extends HTMLElement>(
  signal: unknown,
): {
  ref: RefObject<T | null>;
  paused: boolean;
  onScroll: () => void;
  scrollToBottom: () => void;
} {
  const ref = useRef<T | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [signal, paused]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const away =
      el.scrollTop < el.scrollHeight - el.clientHeight - BOTTOM_THRESHOLD_PX;
    setPaused(away);
  }, []);

  const scrollToBottom = useCallback(() => {
    setPaused(false);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return { ref, paused, onScroll, scrollToBottom };
}
