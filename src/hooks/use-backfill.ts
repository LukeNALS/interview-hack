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

/**
 * `GET /api/sessions/:id/utterances?after_seq=N` — dùng cho: (a) reload giữa
 * buổi (`after_seq=0`, bước 16), (b) seq nhảy cóc do Realtime rớt/miss
 * (bước 12/13), (c) resubscribe sau khi Realtime rớt (bước 13, fix B15).
 * Trả TOÀN BỘ trang ≤500 dòng — caller tự loop theo `next_after_seq` nếu
 * cần (MVP: 1 trang đã đủ cho 90' cap, số utterance thực tế << 500).
 */
export function useBackfill(sessionId: string | null): {
  backfillFrom: (afterSeq: number) => Promise<BackfillResult>;
} {
  const backfillFrom = useCallback(
    async (afterSeq: number): Promise<BackfillResult> => {
      if (!sessionId) return { utterances: [], next_after_seq: null };
      return fetchJson<BackfillResult>(
        `/api/sessions/${sessionId}/utterances?after_seq=${afterSeq}`,
      );
    },
    [sessionId],
  );

  return { backfillFrom };
}
