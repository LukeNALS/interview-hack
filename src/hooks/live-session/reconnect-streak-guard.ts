/**
 * Bộ chặn vòng reconnect vô hạn. Giới hạn 3 lượt của `reconnectWithBackoff` chỉ sống trong MỘT lần gọi: nếu
 * connection mở được rồi mới nhận lỗi (vd 401 ~230 ms sau connect, 429 limit_exceeded, 5xx), controller degrade
 * lại và `attach` mở một vòng mới với bộ đếm về 0 — vòng lặp không có trần ngoài rate limit của route mint.
 *
 * Một lần degrade xảy ra < `QUICK_FAILURE_WINDOW_MS` sau lúc (re)connect xong là "thất bại nhanh". Thất bại nhanh
 * liên tiếp: lần 1 reconnect ngay, lần 2 chờ 1 s, lần 3 chờ 2 s, lần `MAX_QUICK_DEGRADES` bỏ cuộc. Kết nối sống
 * ≥ cửa sổ rồi mới rớt (mạng chập chờn bình thường) thì reset về lần 1. Thuần logic, đồng hồ inject được để test.
 */

export const QUICK_FAILURE_WINDOW_MS = 10_000;
export const MAX_QUICK_DEGRADES = 4;

export type StreakDecision = { action: "reconnect"; waitMs: number } | { action: "give_up" };

/** Ném vào `onGiveUp` khi bỏ cuộc vì thất bại nhanh liên tiếp — để toast phân biệt với hết lượt backoff thường. */
export class ReconnectStreakExceededError extends Error {
  constructor() {
    super("Reconnect thất bại nhanh liên tiếp");
    this.name = "ReconnectStreakExceededError";
  }
}

export interface ReconnectStreakGuard {
  /** Connection vừa (re)mở xong — mốc để đo "sống được bao lâu". */
  markConnected(): void;
  /** Một lần degrade: trả quyết định reconnect (kèm thời gian chờ trước lượt đầu) hoặc bỏ cuộc. */
  onDegraded(): StreakDecision;
}

export function createReconnectStreakGuard(now: () => number = Date.now): ReconnectStreakGuard {
  // Mốc ban đầu = lúc tạo (attach bắt đầu mở): lỗi đến ngay sau lần mở đầu cũng tính là thất bại nhanh.
  let connectedAt = now();
  let quickDegrades = 0;
  return {
    markConnected() {
      connectedAt = now();
    },
    onDegraded() {
      quickDegrades = now() - connectedAt < QUICK_FAILURE_WINDOW_MS ? quickDegrades + 1 : 1;
      if (quickDegrades >= MAX_QUICK_DEGRADES) return { action: "give_up" };
      return { action: "reconnect", waitMs: quickDegrades <= 1 ? 0 : 1000 * 2 ** (quickDegrades - 2) };
    },
  };
}
