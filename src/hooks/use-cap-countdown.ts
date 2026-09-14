"use client";

import { useEffect, useRef } from "react";

export interface UseCapCountdownOptions {
  /** ISO string từ `GET /sessions/:id` (`started_at`) — null = chưa live, hook no-op. */
  startedAt: string | null;
  capSeconds: number;
  /** Elapsed giây mỗi tick — caller patch vào store (LiveHeader timer). */
  onTick?: (elapsedSeconds: number) => void;
  /** Bắn 1 lần khi còn ≤5' (và >1'). */
  onWarn5Min?: () => void;
  /** Bắn 1 lần khi còn ≤1'. */
  onWarn1Min?: () => void;
  /** Bắn 1 lần khi elapsed ≥ capSeconds — caller tự stopCapture + gọi /end (layer c). */
  onCapReached: () => void;
  now?: () => number;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const WARN_5MIN_SECONDS = 5 * 60;
const WARN_1MIN_SECONDS = 60;

/**
 * Cap 90' layer (c) — SU T5/AC3: đồng hồ dùng chung `elapsed = now - started_at`
 * (server), KHÔNG giữ timer state riêng phía client. Cảnh báo còn 5'/1',
 * tự bắn `onCapReached` đúng 1 lần khi chạm cap (phase-05 bước 14).
 */
export function useCapCountdown(opts: UseCapCountdownOptions): void {
  const optsRef = useRef(opts);
  // React Compiler cấm ghi ref trong render (react-hooks/refs) — cập nhật ref
  // "luôn mới nhất" phải nằm trong effect, không phải render trực tiếp.
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const warned5 = { current: false };
    const warned1 = { current: false };
    const capped = { current: false };

    if (!opts.startedAt) return;
    const startedMs = new Date(opts.startedAt).getTime();
    if (Number.isNaN(startedMs)) return;

    const {
      now = Date.now,
      intervalMs = 1000,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
    } = optsRef.current;

    let id: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      const o = optsRef.current;
      const elapsedSeconds = Math.max(0, Math.floor((now() - startedMs) / 1000));
      o.onTick?.(elapsedSeconds);
      const remaining = o.capSeconds - elapsedSeconds;

      if (!warned5.current && remaining <= WARN_5MIN_SECONDS && remaining > WARN_1MIN_SECONDS) {
        warned5.current = true;
        o.onWarn5Min?.();
      }
      if (!warned1.current && remaining <= WARN_1MIN_SECONDS && remaining > 0) {
        warned1.current = true;
        o.onWarn1Min?.();
      }
      if (!capped.current && elapsedSeconds >= o.capSeconds) {
        capped.current = true;
        o.onCapReached();
        if (id !== null) clearIntervalFn(id);
      }
    };

    tick();
    id = setIntervalFn(tick, intervalMs);
    return () => {
      if (id !== null) clearIntervalFn(id);
    };
  }, [opts.startedAt, opts.capSeconds]);
}
