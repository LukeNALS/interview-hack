"use client";

import type { RealtimeToken } from "@soniox/client";
import { buildSonioxConfigs, type SonioxCaptureMode } from "@/lib/soniox/config";
import { SonioxConnection, type SonioxSessionFactory } from "@/lib/soniox/connection";
import { closeAll, fanOutChunk, openAllReady } from "@/lib/soniox/fanout";
import { epochConnForReplay, ReconnectBuffer } from "@/lib/soniox/reconnect";

/**
 * `SonioxStreamController` — quản lý 1 CẶP connection (canonical two_way
 * ja<->vi + en one_way->en) cho 1 luồng audio (mic hoặc tab). Không phải
 * React hook thật (không gọi useState/useEffect) — đặt tên file theo
 * ownership P05-FE, nhưng export là factory/class thuần để
 * `use-live-session.ts` tự quản lifecycle qua `useEffect` của chính nó
 * (tránh vi phạm rules-of-hooks khi cần 1-2 instance tuỳ mode online/direct).
 * Token->utterance aggregation (theo `<end>` boundary) nằm ở đây vì
 * `align.ts`/`utterance-builder.ts` (Wave A) chỉ nhận input ĐÃ gộp sẵn
 * (xem phase-05-client-report.md — "align.ts KHÔNG tự đọc token thô").
 */

interface FlushedSegment {
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
class TokenSegmentAccumulator {
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

export interface CanonicalSegment {
  textOrig: string;
  language: string | null;
  speaker: string | null;
  startMs: number;
  endMs: number;
  /** vi/ja suy từ ngôn ngữ nguồn — null nếu nguồn không phải ja/vi (noop, xem fixture canonical-english-only-noop). */
  translationVi: string | null;
  translationJa: string | null;
}

export interface EnSegment {
  textEn: string | null;
  startMs: number;
  endMs: number;
}

export interface SonioxStreamHandlers {
  /** Text gốc đang tích luỹ (chưa `<end>`) — render bubble opacity-55. */
  onPartial?: (textOrig: string) => void;
  onCanonicalFinal?: (segment: CanonicalSegment) => void;
  onEnFinal?: (segment: EnSegment) => void;
  onDegraded?: () => void;
  onRestored?: () => void;
  onError?: (err: Error) => void;
}

type ConnKind = "canonical" | "en";

export class SonioxStreamController {
  private readonly configs: ReturnType<typeof buildSonioxConfigs>;
  private readonly handlers: SonioxStreamHandlers;
  private readonly label: string;
  /** DI hook cho test (không đổi hành vi prod — mặc định undefined -> SonioxConnection tự dùng SDK thật). */
  private readonly sessionFactory: SonioxSessionFactory | undefined;
  private canonical: SonioxConnection;
  private en: SonioxConnection;
  private readonly canonicalAcc = new TokenSegmentAccumulator();
  private readonly enAcc = new TokenSegmentAccumulator();
  private readonly reconnectBuffer = new ReconnectBuffer();
  private degraded = false;
  /** true khi đóng chủ động (stop()) đang/đã chạy — chặn onDisconnected trigger reconnect (C1 fix). */
  private stopped = false;

  constructor(opts: {
    mode: SonioxCaptureMode;
    label: string;
    handlers: SonioxStreamHandlers;
    sessionFactory?: SonioxSessionFactory;
  }) {
    this.configs = buildSonioxConfigs(opts.mode);
    this.handlers = opts.handlers;
    this.label = opts.label;
    this.sessionFactory = opts.sessionFactory;
    this.canonical = this.createConnection("canonical");
    this.en = this.createConnection("en");
  }

  private createConnection(kind: ConnKind): SonioxConnection {
    const conn = new SonioxConnection({
      config: this.configs[kind],
      label: `${this.label}-${kind}`,
      sessionFactory: this.sessionFactory,
    });
    conn.setHandlers({
      onToken: (token) => this.handleToken(kind, token),
      onEndpoint: () => this.handleEndpoint(kind),
      onDisconnected: () => this.handleDisconnected(conn),
      onConnected: () => this.handleConnected(),
      onError: (err) => this.handlers.onError?.(err),
    });
    return conn;
  }

  /** Mở cả 2 connection với apiKey — chờ cả 2 ready (§Architecture). */
  async open(apiKey: string): Promise<void> {
    await openAllReady([this.canonical, this.en], apiKey);
  }

  /** Bơm 1 chunk PCM (từ pcm-worklet). Degraded -> buffer RAM (reconnect), không fan-out. */
  feed(chunk: ArrayBuffer, captureTs: number): void {
    const data = new Uint8Array(chunk);
    if (this.degraded) {
      this.reconnectBuffer.push(data, captureTs);
      return;
    }
    fanOutChunk([this.canonical, this.en], data);
  }

  getEpochConnMs(): number | null {
    return this.canonical.getEpochConnMs();
  }

  /** `conn` = wrapper vừa rớt — bỏ qua nếu: (a) đang/đã stop() chủ động, hoặc (b) `conn` không
   *  còn là canonical/en HIỆN TẠI (đã bị swap ra do renew()/reconnect() trước đó, đóng 1s sau
   *  overlap window — SDK có thể tự bắn "disconnected" khi close() dù là đóng chủ động, C1/M2 fix). */
  private handleDisconnected(conn: SonioxConnection): void {
    if (this.stopped) return;
    if (conn !== this.canonical && conn !== this.en) return;
    if (this.degraded) return;
    this.degraded = true;
    this.handlers.onDegraded?.();
  }

  private handleConnected(): void {
    // no-op riêng — reconnect()/renew() tự set degraded=false sau khi pair mới ready.
  }

  /**
   * Mất kết nối giữa buổi -> mở pair mới, epoch_conn = capture_ts chunk đầu buffer (fix B13),
   * replay buffer, đóng pair cũ.
   *
   * Bug thứ cấp đã fix (code review C1): trước đây `drain()` chạy TRƯỚC `await openAllReady()`
   * -> chunk capture trong lúc await (feed() vẫn thấy `degraded=true` nên vẫn buffer) bị bỏ sót
   * vĩnh viễn (không nằm trong buffer đã drain, và feed() sau khi degraded=false không đọc buffer
   * nữa). Fix: KHÔNG động vào buffer cho tới khi pair mới đã ready — feed() trong lúc await vẫn
   * tự buffer bình thường (degraded vẫn true suốt hàm này) -> drain() 1 LẦN DUY NHẤT sau khi ready,
   * giữ đúng thứ tự chunk (kể cả chunk tới muộn trong lúc await) + epoch_conn = capture_ts chunk
   * ĐẦU TIÊN (từ trước khi reconnect() được gọi, không đổi).
   */
  async reconnect(apiKey: string): Promise<void> {
    const newCanonical = this.createConnection("canonical");
    const newEn = this.createConnection("en");
    await openAllReady([newCanonical, newEn], apiKey);
    // Code review round 2 (NEW-1): stop() có thể xảy ra GIỮA lúc await ở trên đang chờ (endInterview()/
    // unmount trong lúc reconnectWithBackoff còn in-flight) — nếu vậy pair mới này không còn chủ sở hữu
    // nào (streamsRef.current đã bị clear), không được swap vào/bắn onRestored(); đóng ngay để tránh leak
    // WebSocket (đốt quota Soniox), không đụng buffer/degraded (stop() đã tự lo phần đó).
    if (this.stopped) {
      await closeAll([newCanonical, newEn]);
      return;
    }
    const buffered = this.reconnectBuffer.drain();
    const epoch = epochConnForReplay(buffered);
    if (epoch !== null) {
      newCanonical.setEpochConnMs(epoch);
      newEn.setEpochConnMs(epoch);
    }
    for (const chunk of buffered) fanOutChunk([newCanonical, newEn], chunk.data);
    this.swapConnections(newCanonical, newEn);
    this.degraded = false;
    this.handlers.onRestored?.();
  }

  /** Renew key TTL-120s (chưa mất kết nối) — mở pair mới overlap 1s, epoch_conn tự rebase bình thường (không set thủ công). */
  async renew(apiKey: string): Promise<void> {
    const newCanonical = this.createConnection("canonical");
    const newEn = this.createConnection("en");
    await openAllReady([newCanonical, newEn], apiKey);
    // Cùng shape race với NEW-1 (xem reconnect() ở trên) — stop() có thể xảy ra giữa await này.
    if (this.stopped) {
      await closeAll([newCanonical, newEn]);
      return;
    }
    this.swapConnections(newCanonical, newEn);
  }

  private swapConnections(newCanonical: SonioxConnection, newEn: SonioxConnection): void {
    const oldCanonical = this.canonical;
    const oldEn = this.en;
    this.canonical = newCanonical;
    this.en = newEn;
    setTimeout(() => {
      oldCanonical.close();
      oldEn.close();
    }, 1000);
  }

  private handleToken(kind: ConnKind, token: RealtimeToken): void {
    const acc = kind === "canonical" ? this.canonicalAcc : this.enAcc;
    const flushed = acc.feed(token);
    if (!flushed) {
      if (kind === "canonical") this.handlers.onPartial?.(acc.partialText());
      return;
    }
    this.emitSegment(kind, flushed);
  }

  /**
   * Endpoint (hết câu) từ SDK — đây là đường chốt segment THẬT ở production.
   * SDK lọc `<end>` khỏi stream token nên handleToken() không bao giờ tự chốt được;
   * thiếu handler này thì onCanonicalFinal/onEnFinal KHÔNG BAO GIỜ bắn và không
   * utterance nào được POST lên /utterances (bug P07, phát hiện qua E2E).
   */
  private handleEndpoint(kind: ConnKind): void {
    const acc = kind === "canonical" ? this.canonicalAcc : this.enAcc;
    const flushed = acc.flush();
    if (!flushed) return;
    this.emitSegment(kind, flushed);
    if (kind === "canonical") this.handlers.onPartial?.("");
  }

  private emitSegment(kind: ConnKind, flushed: FlushedSegment): void {
    if (kind === "canonical") {
      const sourceLang = flushed.language;
      this.handlers.onCanonicalFinal?.({
        textOrig: flushed.textOrig,
        language: flushed.language,
        speaker: flushed.speaker,
        startMs: flushed.startMs,
        endMs: flushed.endMs,
        translationVi: sourceLang === "ja" ? flushed.textTranslation : null,
        translationJa: sourceLang === "vi" ? flushed.textTranslation : null,
      });
    } else {
      this.handlers.onEnFinal?.({
        textEn: flushed.textTranslation,
        startMs: flushed.startMs,
        endMs: flushed.endMs,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await closeAll([this.canonical, this.en]);
  }
}
