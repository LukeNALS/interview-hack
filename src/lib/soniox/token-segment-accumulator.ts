import type { RealtimeToken } from "@soniox/client";

export interface FlushedSegment {
  textOrig: string;
  textTranslation: string | null;
  language: string | null;
  speaker: string | null;
  startMs: number;
  endMs: number;
}

/**
 * Gộp token thô -> 1 segment mỗi khi hết câu (enable_endpoint_detection).
 *
 * CẢNH BÁO: `feed()` chỉ chốt khi thấy token `<end>` — nhưng SDK @soniox/client
 * LỌC BỎ `<end>`/`<fin>` khỏi token trước khi emit (`filterSpecialTokens`,
 * dist/index.mjs:962) và bắn `endpoint` thành event RIÊNG. Nên ở production
 * đường chốt duy nhất là event đó -> `handleEndpoint()` gọi `flush()` trực tiếp.
 * Nhánh `<end>` trong feed() giữ lại cho transport thô (POC/mock) còn thấy token này.
 *
 * CHỈ token `is_final === true` được vào segment. Soniox bắn token provisional
 * (`is_final: false`) rồi PHÁT LẠI đúng đoạn đó ở response sau dưới dạng bản final đầy
 * đủ hơn — gộp cả hai làm transcript lặp phần đầu câu (bug P07, dữ liệu thật trong DB:
 * "こんにちは、自己紹介をお" + "こんにちは、自己紹介をお願いします"). Đây cũng là cách
 * SDK tự làm cho utterance collector của nó (`final_only: true`, dist/index.mjs:1568).
 */
export class TokenSegmentAccumulator {
  /** Token ĐÃ final của câu đang nói — nguồn duy nhất dựng FlushedSegment. */
  private original: RealtimeToken[] = [];
  private translation: RealtimeToken[] = [];
  /** Đuôi provisional hiện tại (nhánh original) — chỉ để vẽ bubble mờ, KHÔNG bao giờ vào segment. */
  private pending: RealtimeToken[] = [];

  feed(token: RealtimeToken): FlushedSegment | null {
    if (token.text === "<end>") return this.flush();
    if (!token.is_final) {
      // Token dịch provisional bỏ hẳn: bubble mờ chỉ hiện text gốc (partialText).
      if (token.translation_status !== "translation") this.pushPending(token);
      return null;
    }
    // Bản final đã tới -> đuôi provisional cũ hết giá trị (nội dung của nó nằm trong bản final).
    this.pending = [];
    if (token.translation_status === "translation") this.translation.push(token);
    else this.original.push(token);
    return null;
  }

  /**
   * Mỗi response Soniox gửi LẠI toàn bộ đuôi provisional (bản sửa mới nhất) chứ không gửi
   * thêm phần đuôi mới — token quay về mốc `start_ms` cũ nghĩa là đuôi mới bắt đầu: cắt
   * phần cũ từ mốc đó rồi mới nối, tránh bubble nối chồng bản cũ.
   */
  private pushPending(token: RealtimeToken): void {
    const start = token.start_ms;
    if (start !== undefined) {
      const overlapAt = this.pending.findIndex((t) => (t.start_ms ?? -1) >= start);
      if (overlapAt >= 0) this.pending.length = overlapAt;
    }
    this.pending.push(token);
  }

  partialText(): string {
    return [...this.original, ...this.pending].map((t) => t.text).join("");
  }

  /**
   * Chốt segment đang tích luỹ. PUBLIC vì đường chốt THẬT ở production là event
   * `endpoint` của SDK, không phải token `<end>` — xem handleEndpoint().
   */
  flush(): FlushedSegment | null {
    const original = this.original;
    const translation = this.translation;
    this.original = [];
    this.translation = [];
    // Đuôi provisional chưa kịp finalize thuộc về câu vừa chốt -> vứt, không để dính sang câu sau.
    this.pending = [];
    if (original.length === 0) return null;
    return {
      textOrig: original.map((t) => t.text).join(""),
      textTranslation: translation.length > 0 ? translation.map((t) => t.text).join("") : null,
      language: original.find((t) => t.language)?.language ?? null,
      speaker: original.find((t) => t.speaker)?.speaker ?? null,
      startMs: original[0].start_ms ?? 0,
      endMs: original[original.length - 1].end_ms ?? original[0].start_ms ?? 0,
    };
  }
}
