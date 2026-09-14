import { readPersistedClockOffset } from "../use-session";
import type { BackfillResult, UtteranceRow } from "../use-backfill";

/** Trục thời gian session (fix B14): reload đọc lại clock_offset persist ở /start; thiếu -> coi như phiên mới (now()). */
export function resolveT0LocalMs(sessionId: string, startedAtIso: string, now: () => number = Date.now): number {
  const offset = readPersistedClockOffset(sessionId);
  if (offset !== null) return new Date(startedAtIso).getTime() + offset;
  return now();
}

/**
 * fix B15: Realtime rớt rồi resubscribe -> backfill utterances thiếu (broadcast lỡ trong
 * lúc rớt không replay được).
 *
 * M4 fix (code review): sau khi backfill xong PHẢI đồng bộ lại `seqBufferRef` với seq mới nhất
 * vừa backfill được — trước đây bỏ sót bước này nên `SeqBuffer` vẫn giữ giá trị TRƯỚC lúc rớt,
 * khiến event Realtime kế tiếp trông như "seq nhảy cóc" so với giá trị cũ -> `handleSeqGap` kích
 * hoạt thừa 1 lần, backfill lại đúng đoạn vừa mới backfill xong (tốn 1 round-trip thừa mỗi lần
 * Realtime rớt/nối lại). Tự lành nếu bỏ qua (idempotent) nhưng không nên chấp nhận cho MVP vì
 * chi phí sửa rẻ.
 */
export async function resyncAfterReconnect(deps: {
  backfillFrom: (afterSeq: number) => Promise<BackfillResult>;
  lastSeq: number;
  applyBackfillRow: (row: UtteranceRow) => void;
  syncSeqBuffer: (utterances: UtteranceRow[]) => void;
  showRestored: () => void;
}): Promise<void> {
  const result = await deps.backfillFrom(deps.lastSeq);
  for (const row of result.utterances) deps.applyBackfillRow(row);
  deps.syncSeqBuffer(result.utterances);
  deps.showRestored();
}

/** seq nhảy cóc (Realtime broadcast không replay, SU T8) -> backfill đúng khoảng thiếu (bước 12/13). */
export async function handleSeqGap(
  fromSeqExclusive: number,
  backfillFrom: (afterSeq: number) => Promise<BackfillResult>,
  applyBackfillRow: (row: UtteranceRow) => void,
): Promise<void> {
  const result = await backfillFrom(fromSeqExclusive - 1);
  for (const row of result.utterances) applyBackfillRow(row);
}
