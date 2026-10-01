"use client";

import { useCallback } from "react";
import { fetchJson } from "@/hooks/use-session";
import type { Database } from "@/types/db";

/** Row thật `GET /utterances?after_seq=` trả về (BE report — `select("*")`). */
export type UtteranceRow = Database["public"]["Tables"]["utterances"]["Row"];

export interface BackfillResult {
  utterances: UtteranceRow[];
  next_after_seq: number | null;
}

/** Trần số trang mỗi lần gọi (route trả ≤ 500 dòng/trang ⇒ 20.000 lượt) — chặn vòng lặp khi server lỗi/phiên bất thường. */
const MAX_PAGES = 40;

/**
 * `GET /api/sessions/:id/utterances?after_seq=N` — dùng cho: (a) reload giữa
 * buổi (`after_seq=0`, bước 16), (b) seq nhảy cóc do Realtime rớt/miss
 * (bước 12/13), (c) resubscribe sau khi Realtime rớt (bước 13, fix B15).
 * Route chỉ trả ≤ 500 dòng + `next_after_seq`, nên hàm này TỰ lặp theo con trỏ tới khi hết (audit #8: trước đây chỉ đọc 1
 * trang nên phiên > 500 lượt thiếu lời thoại trên màn live). Trả TOÀN BỘ dòng đã nạp theo thứ tự seq; `next_after_seq`
 * chỉ khác null khi chạm `MAX_PAGES` (phần còn lại chưa nạp).
 */
export function useBackfill(sessionId: string | null): {
  backfillFrom: (afterSeq: number) => Promise<BackfillResult>;
} {
  const backfillFrom = useCallback(
    async (afterSeq: number): Promise<BackfillResult> => {
      if (!sessionId) return { utterances: [], next_after_seq: null };
      const all: UtteranceRow[] = [];
      let cursor = afterSeq;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetchJson<BackfillResult>(`/api/sessions/${sessionId}/utterances?after_seq=${cursor}`);
        all.push(...res.utterances);
        // Hết trang, hoặc con trỏ không tiến (server lỗi): dừng — không lặp vô hạn.
        if (res.next_after_seq === null || res.next_after_seq <= cursor) return { utterances: all, next_after_seq: null };
        cursor = res.next_after_seq;
      }
      return { utterances: all, next_after_seq: cursor };
    },
    [sessionId],
  );

  return { backfillFrom };
}
