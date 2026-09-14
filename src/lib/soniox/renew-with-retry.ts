import type { KeyLease } from "./reconnect";

/**
 * N2 fix — vá lỗi "stream chết CÂM giữa buổi phỏng vấn".
 *
 * Trước đây `TempKeyClient.renew()` được gọi trần trong `void (async () => …)()` KHÔNG có
 * catch, mà lệnh hẹn lượt renew kế tiếp lại là câu lệnh CUỐI trong chính async đó. Hệ quả:
 * một lần renew ném (mạng chớp, 429, 5xx) là chuỗi renew dừng hẳn — temp key hết hạn vài
 * phút sau, Soniox đóng WS, transcript im lặng mà user KHÔNG thấy banner nào. Khách vẫn
 * đang ngồi đó, mic vẫn chạy, và buổi phỏng vấn thì không làm lại được.
 *
 * Hàm này bọc renew bằng retry CÓ TRẦN + báo user ở cả hai mốc: đang trục trặc (banner vàng)
 * và đã bỏ cuộc (callback `onGiveUp` để caller bắn banner + toast). Thuần logic, không phụ
 * thuộc React/DOM/network — test được bằng fake timer.
 */
export interface RenewWithRetryDeps {
  /** Lấy lease mới (`TempKeyClient.renew`) — được phép ném. */
  renew: () => Promise<KeyLease>;
  /** Đẩy key mới xuống mọi stream đang mở — được phép ném (coi như 1 lượt hỏng). */
  applyKey: (lease: KeyLease) => Promise<void>;
  /** Pipeline đã đóng -> thoát ngay: không banner, không retry (rời màn live là chuyện bình thường). */
  isDisposed: () => boolean;
  /** Hỏng lượt đầu nhưng CÒN lượt -> banner vàng, bắn ĐÚNG MỘT LẦN mỗi chu kỳ. */
  onDegraded: () => void;
  /** Renew lại được sau khi đã báo degraded -> banner xanh. */
  onRestored: () => void;
  /** Hết lượt -> caller báo user; chuỗi renew dừng CÓ CHỦ ĐÍCH (khác hẳn dừng câm). */
  onGiveUp: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Tổng số lượt thử (kể cả lượt đầu). Default 4 -> chờ tối đa 2+4+8 = 14s. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * @returns `true` = đã renew + đẩy key xong (caller hẹn lượt renew kế tiếp).
 *          `false` = pipeline đã đóng HOẶC hết lượt retry (caller KHÔNG hẹn tiếp).
 */
export async function renewKeyWithRetry(deps: RenewWithRetryDeps): Promise<boolean> {
  const {
    maxAttempts = 4,
    baseDelayMs = 2000,
    maxDelayMs = 15000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = deps;

  let degraded = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (deps.isDisposed()) return false;
    try {
      const lease = await deps.renew();
      if (deps.isDisposed()) return false;
      await deps.applyKey(lease);
      if (degraded) deps.onRestored();
      return true;
    } catch (err) {
      // Dispose trong lúc đang renew: im lặng thoát, KHÔNG hù user bằng banner lỗi.
      if (deps.isDisposed()) return false;
      if (attempt === maxAttempts - 1) {
        deps.onGiveUp(err);
        return false;
      }
      if (!degraded) {
        degraded = true;
        deps.onDegraded();
      }
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
  return false;
}
