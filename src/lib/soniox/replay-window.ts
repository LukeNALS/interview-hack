/**
 * Chọn điểm replay audio khi reconnect (audit #6 / replay). Thuần logic, không side-effect.
 *
 * Pair cũ bị bỏ cùng mọi câu CHƯA chốt của nó, nên pair mới phải phiên âm lại từ sau câu cuối đã emit — nếu không mỗi
 * lần rớt mất trọn câu đang nói (E6 câu 16). Mốc an toàn = câu cuối đã emit của bên CHẬM hơn (canonical/en), lùi một
 * chút cho khỏi cắt mép; token đã emit được loại bằng cổng theo loại ở phía controller.
 *
 * Trần 30 s chỉ áp cho phần audio TRƯỚC LÚC RỚT (`dropTs` = captureTs chunk cuối đã gửi cho pair cũ): audio thu sau
 * lúc rớt (outage dài) chưa từng được phiên âm nên luôn được replay hết, giới hạn bởi buffer 120 s.
 */

/** Lùi trước mốc để không cắt mất token sát mép (ranh giới token ≠ ranh giới chunk). */
export const REPLAY_MARGIN_MS = 300;
/** Replay tối đa chừng này audio: nói liền lâu hơn thì chốt phần final của pair cũ trước (câu có thể bị tách đôi). */
export const REPLAY_LOOKBACK_MAX_MS = 30_000;

export interface ReplayWindowInput {
  /** Mốc kết thúc (tuyệt đối, ms đồng hồ capture) của segment cuối đã emit theo loại; -Infinity nếu chưa emit gì. */
  lastEmittedEndAbsMs: { canonical: number; en: number };
  /** captureTs chunk cũ nhất còn trong buffer; null nếu buffer rỗng. */
  bufferOldestTs: number | null;
  /** Mốc audio chunk cuối đã gửi cho pair cũ (lúc rớt); -Infinity nếu chưa gửi chunk nào. */
  dropTs: number;
}

export interface ReplayWindow {
  /** Replay các chunk có captureTs >= mốc này. */
  replayFromTs: number;
  /** true ⇒ mốc cách lúc rớt quá 30 s hoặc buffer không phủ tới mốc: caller chốt final của pair cũ rồi tính lại. */
  needsFlush: boolean;
}

export function computeReplayWindow({ lastEmittedEndAbsMs, bufferOldestTs, dropTs }: ReplayWindowInput): ReplayWindow {
  const boundary = Math.min(lastEmittedEndAbsMs.canonical, lastEmittedEndAbsMs.en);
  // Chưa có mốc (một bên chưa emit gì) ⇒ bắt đầu từ chunk cũ nhất còn giữ.
  const candidate = Number.isFinite(boundary) ? boundary - REPLAY_MARGIN_MS : (bufferOldestTs ?? dropTs);
  const tooOld = dropTs - candidate > REPLAY_LOOKBACK_MAX_MS;
  const notCovered = bufferOldestTs !== null && bufferOldestTs > candidate;
  return { replayFromTs: candidate, needsFlush: tooOld || notCovered };
}

/** Sau khi chốt final của pair cũ (mốc đã tiến lên): kẹp lại vào 30 s trước lúc rớt và phần buffer còn giữ. */
export function clampReplayStart(replayFromTs: number, bufferOldestTs: number | null, dropTs: number): number {
  return Math.max(replayFromTs, dropTs - REPLAY_LOOKBACK_MAX_MS, bufferOldestTs ?? Number.NEGATIVE_INFINITY);
}
