import { formatElapsed } from "@/components/live/live-utils";
import type { UtteranceRow } from "../use-backfill";
import { readTranslations, upsertUtterance } from "./utterance-mapping";

export interface ApplyBackfillRowDeps {
  clientUttIdToLocalId: Map<string, number>;
}

/** Đổ 1 dòng backfill vào store. Upsert theo `seq` server — dòng của phiên CŨ phải được dọn
 *  trước đó (`enterSession`, N5), nếu không backfill sẽ PATCH đè lên chúng. */
export function applyBackfillRowToStore(row: UtteranceRow, deps: ApplyBackfillRowDeps): void {
  upsertUtterance({
    id: row.seq,
    speaker: row.speaker,
    lang: row.lang,
    text_orig: row.text_orig,
    translations: readTranslations(row.translations),
    time: formatElapsed(Math.floor((row.t_start_ms ?? 0) / 1000)),
    partial: false,
    clientUttId: row.client_utt_id,
  }, deps.clientUttIdToLocalId);
}
