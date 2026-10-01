"use client";

import type { RealtimeToken } from "@soniox/client";
import { classifySonioxRealtimeError, type FatalKind } from "@/lib/soniox/classify-realtime-error";
import { buildSonioxConfigs, SONIOX_SAMPLE_RATE_HZ, type SonioxCaptureMode } from "@/lib/soniox/config";
import { accOf, connOf, type ConnKind, type ConnectionGeneration } from "@/lib/soniox/connection-generation";
import { SonioxConnection, type PairKeys, type SonioxSessionFactory } from "@/lib/soniox/connection";
import { closeAll, fanOutChunk, openAllReady } from "@/lib/soniox/fanout";
import { epochConnForReplay, ReconnectBuffer } from "@/lib/soniox/reconnect";
import { clampReplayStart, computeReplayWindow } from "@/lib/soniox/replay-window";
import { TokenSegmentAccumulator, type FlushedSegment } from "@/lib/soniox/token-segment-accumulator";

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
 *
 * Mỗi lần reconnect dựng 1 THẾ HỆ connection mới (xem `connection-generation.ts`): accumulator riêng,
 * thời gian segment là mốc tuyệt đối trên đồng hồ capture (`epoch_conn` của chính connection phát ra + ms
 * tương đối của token), nên segment của thế hệ cũ và mới không ghép chéo và không lệch trục.
 */

/** PCM16 mono: byte trên mỗi ms audio — đổi độ dài chunk ra thời gian audio. */
const PCM_BYTES_PER_MS = (SONIOX_SAMPLE_RATE_HZ * 2) / 1000;
/** Token lệch mốc vượt dung sai điểm giữa vẫn bị coi là đuôi câu đã emit nếu bắt đầu trong khoảng này sau cổng VÀ khớp chữ cuối câu. */
const GATE_TAIL_SLACK_MS = 400;
/** Đuôi bị lệch chỉ gồm vài token cuối ⇒ đoạn khớp phải nằm trong chừng này ký tự cuối của câu đã emit. */
const GATE_TAIL_REST_MAX_CHARS = 8;

export interface CanonicalSegment {
  textOrig: string;
  language: string | null;
  speaker: string | null;
  /** Mốc TUYỆT ĐỐI (ms đồng hồ capture `Date.now()`) = epoch_conn của connection phát + start tương đối. */
  startAbsMs: number;
  endAbsMs: number;
  /** vi/ja suy từ ngôn ngữ nguồn — null nếu nguồn không phải ja/vi (noop, xem fixture canonical-english-only-noop). */
  translationVi: string | null;
  translationJa: string | null;
}

export interface EnSegment {
  textEn: string | null;
  startAbsMs: number;
  endAbsMs: number;
}

export interface SonioxStreamHandlers {
  /** Text gốc đang tích luỹ (chưa `<end>`) — render bubble opacity-55. */
  onPartial?: (textOrig: string) => void;
  onCanonicalFinal?: (segment: CanonicalSegment) => void;
  onEnFinal?: (segment: EnSegment) => void;
  onDegraded?: () => void;
  onRestored?: () => void;
  /** Lỗi server KHÔNG thử lại được (hết duration/thiếu quyền/hết hạn mức/cấu hình) — controller đã tự
   *  đóng cả cặp và chỉ báo ĐÚNG MỘT LẦN; caller dừng thu âm + báo user. */
  onFatal?: (kind: FatalKind, err: Error) => void;
  /** Mọi lỗi từ SDK (kể cả connection cũ) — chỉ để log; phân loại xảy ra trong controller. */
  onError?: (err: Error) => void;
}

export class SonioxStreamController {
  private readonly configs: ReturnType<typeof buildSonioxConfigs>;
  private readonly handlers: SonioxStreamHandlers;
  private readonly label: string;
  /** DI hook cho test (không đổi hành vi prod — mặc định undefined -> SonioxConnection tự dùng SDK thật). */
  private readonly sessionFactory: SonioxSessionFactory | undefined;
  private nextGenerationId = 1;
  private current: ConnectionGeneration;
  /** Buffer audio RAM LUÔN ghi (cap 2 phút) — reconnect replay từ mốc cuối đã emit, không chỉ từ lúc rớt. */
  private readonly reconnectBuffer = new ReconnectBuffer();
  /** Mốc kết thúc tuyệt đối của segment cuối đã emit theo loại — cơ sở chọn điểm replay + cổng token thế hệ mới. */
  private readonly lastEmitted: Record<ConnKind, number> = {
    canonical: Number.NEGATIVE_INFINITY,
    en: Number.NEGATIVE_INFINITY,
  };
  /** captureTs chunk cuối đã fan-out cho pair hiện tại — mốc "lúc rớt" để tính trần look-back của replay. */
  private lastFanOutTs = Number.NEGATIVE_INFINITY;
  /** Đồng hồ audio: mốc chunk = captureTs chunk ĐẦU + tổng độ dài audio đã nhận. Dùng thay captureTs từng chunk (tới main thread
   *  lệch tới ~200 ms) để epoch của mọi connection — đầu buổi lẫn replay — nằm trên CÙNG một trục, không lệch nhau. */
  private audioOriginTs: number | null = null;
  private audioElapsedMs = 0;
  /** Chữ gốc của segment cuối đã emit theo loại — so với token bị phiên âm lại sau cổng. */
  private readonly lastEmittedText: Record<ConnKind, string> = { canonical: "", en: "" };
  private degraded = false;
  /** true khi đóng chủ động (stop()) HOẶC sau lỗi không thử lại được (reportFatal) — chặn onDisconnected
   *  trigger reconnect (C1 fix) và làm `onFatal` chỉ bắn 1 lần dù cả 2 connection cùng lỗi. */
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
    this.current = this.createGeneration();
  }

  private createGeneration(): ConnectionGeneration {
    const gen = {
      id: this.nextGenerationId++,
      canonicalAcc: new TokenSegmentAccumulator(),
      enAcc: new TokenSegmentAccumulator(),
      gate: { canonical: Number.NEGATIVE_INFINITY, en: Number.NEGATIVE_INFINITY },
      gateOpen: { canonical: false, en: false },
    } as ConnectionGeneration;
    gen.canonical = this.createConnection("canonical", gen);
    gen.en = this.createConnection("en", gen);
    return gen;
  }

  private createConnection(kind: ConnKind, gen: ConnectionGeneration): SonioxConnection {
    const conn = new SonioxConnection({
      config: this.configs[kind],
      label: `${this.label}-${kind}`,
      sessionFactory: this.sessionFactory,
    });
    conn.setHandlers({
      onToken: (token) => this.handleToken(gen, kind, token),
      onEndpoint: () => this.handleEndpoint(gen, kind),
      onFinished: () => this.handleFinished(gen, kind),
      onDisconnected: () => this.handleDisconnected(conn),
      onConnected: () => this.handleConnected(),
      onError: (err) => this.handleError(conn, err),
    });
    return conn;
  }

  /** Mở cả 2 connection, mỗi connection 1 key single-use riêng — chờ cả 2 ready (§Architecture). */
  async open(keys: PairKeys): Promise<void> {
    try {
      await openAllReady([this.current.canonical, this.current.en], [keys.canonical, keys.en]);
    } catch (err) {
      // Mở dở (vd canonical lên, en timeout 20 s): connection đã lên không ai giữ ⇒ rò WebSocket. Set
      // `stopped` TRƯỚC khi close để `disconnected` do chính close() bắn ra không kích hoạt reconnect.
      this.stopped = true;
      this.current.canonical.close();
      this.current.en.close();
      throw err;
    }
  }

  /** Đã đóng (stop() hoặc lỗi không thử lại được) — caller ngoài (reconnect backoff) dùng để bỏ cuộc im lặng. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Bơm 1 chunk PCM (từ pcm-worklet): luôn ghi buffer RAM (để replay khi reconnect); đang degraded thì không fan-out. */
  feed(chunk: ArrayBuffer, captureTs: number): void {
    if (this.stopped) return; // đã đóng (kể cả lỗi fatal): không còn connection để gửi, không giữ audio vô ích
    const data = new Uint8Array(chunk);
    // `captureTs` chỉ dùng làm gốc của chunk đầu; mọi mốc sau tính theo độ dài audio (xem `audioOriginTs`).
    this.audioOriginTs ??= captureTs;
    const audioTs = this.audioOriginTs + this.audioElapsedMs;
    this.audioElapsedMs += data.byteLength / PCM_BYTES_PER_MS;
    this.reconnectBuffer.push(data, audioTs);
    if (this.degraded) return;
    this.lastFanOutTs = audioTs;
    // Connection chưa có epoch (chunk đầu của thế hệ này, không có replay) ⇒ neo vào mốc audio, không vào Date.now() lúc feed.
    for (const conn of [this.current.canonical, this.current.en]) {
      if (conn.getEpochConnMs() === null) conn.setEpochConnMs(audioTs);
    }
    fanOutChunk([this.current.canonical, this.current.en], data);
  }

  /** `conn` = wrapper vừa rớt — bỏ qua nếu: (a) đang/đã stop() chủ động, hoặc (b) `conn` không
   *  còn là canonical/en HIỆN TẠI (đã bị swap ra do reconnect() trước đó, đóng 1s sau
   *  overlap window — SDK có thể tự bắn "disconnected" khi close() dù là đóng chủ động, C1/M2 fix). */
  private handleDisconnected(conn: SonioxConnection): void {
    if (this.stopped) return;
    if (!this.isCurrentConnection(conn)) return;
    this.markDegraded();
  }

  private isCurrentConnection(conn: SonioxConnection): boolean {
    return conn === this.current.canonical || conn === this.current.en;
  }

  /** Idempotent: `disconnected` + `error` (ConnectionError) cùng đến khi WS rớt, chỉ báo 1 lần. */
  private markDegraded(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.handlers.onDegraded?.();
  }

  /**
   * Lỗi server sau connect. SDK 2.3.0 chỉ bắn `error` (KHÔNG `disconnected`) rồi tự dọn session nên phải
   * phân loại ở đây, nếu không stream chết câm. Bỏ qua khi đã stop (kể cả sau fatal) hoặc `conn` không phải
   * connection HIỆN TẠI (pair cũ đã swap ra; pair mới chưa swap do reconnect() tự kiểm `conn.error`).
   * `retry` đi chung đường `disconnected` ⇒ onDegraded ⇒ reconnect với cặp key mới.
   */
  private handleError(conn: SonioxConnection, err: Error): void {
    this.handlers.onError?.(err);
    if (this.stopped) return;
    if (!this.isCurrentConnection(conn)) return;
    const kind = classifySonioxRealtimeError(err);
    if (kind === "retry") this.markDegraded();
    else this.reportFatal(kind, err);
  }

  /** Lỗi không thử lại được: `stopped` chặn reconnect + mọi lỗi/ngắt về sau (nên chỉ báo 1 lần), feed()
   *  chuyển sang buffer (không ném StateError trên session đã chết), đóng cả cặp best-effort. */
  private reportFatal(kind: FatalKind, err: Error): void {
    this.stopped = true;
    this.degraded = true;
    this.reconnectBuffer.clear();
    void closeAll([this.current.canonical, this.current.en]).catch(() => {});
    this.handlers.onFatal?.(kind, err);
  }

  private handleConnected(): void {
    // no-op riêng — reconnect() tự set degraded=false sau khi pair mới ready.
  }

  /**
   * Mất kết nối giữa buổi -> mở THẾ HỆ connection mới (cặp key mới), phiên âm lại audio từ mốc cuối đã emit (`replayInto`),
   * rồi swap và đóng thế hệ cũ ngay. `feed()` trong lúc await vẫn tự ghi buffer (degraded còn true suốt hàm này) nên audio
   * tới muộn cũng nằm trong replay; buffer KHÔNG bị xoá (luôn ghi, lần reconnect sau dùng lại).
   */
  async reconnect(keys: PairKeys): Promise<void> {
    const next = this.createGeneration();
    try {
      await openAllReady([next.canonical, next.en], [keys.canonical, keys.en]);
    } catch (err) {
      // Mở dở: connection đã lên không ai giữ (pair mới chưa phải hiện tại nên handler bỏ qua sự kiện của nó).
      next.canonical.close();
      next.en.close();
      throw err;
    }
    // Code review round 2 (NEW-1): stop() có thể xảy ra GIỮA lúc await ở trên đang chờ (endInterview()/
    // unmount trong lúc reconnectWithBackoff còn in-flight) — nếu vậy pair mới này không còn chủ sở hữu
    // nào (streamsRef.current đã bị clear), không được swap vào/bắn onRestored(); đóng ngay để tránh leak
    // WebSocket (đốt quota Soniox), không đụng buffer/degraded (stop() đã tự lo phần đó).
    if (this.stopped) {
      await closeAll([next.canonical, next.en]);
      return;
    }
    // Lỗi server đến từ pair MỚI trước khi swap (vd 401 ~230 ms sau connect, lúc connection kia còn đang
    // mở): handleError bỏ qua vì chưa phải connection hiện tại ⇒ kiểm ở đây. Chưa feed audio nào nên
    // chỉ cần close(). retry ⇒ ném để backoff xin cặp key MỚI; không thử lại được ⇒ báo, KHÔNG swap.
    const errors = [next.canonical.error, next.en.error].filter((e): e is Error => e !== null);
    // Ưu tiên lỗi KHÔNG thử lại được (403/402/400...) để không che nó bằng lỗi retry của connection kia.
    const dead = errors.find((e) => classifySonioxRealtimeError(e) !== "retry") ?? errors[0];
    if (dead) {
      next.canonical.close();
      next.en.close();
      const kind = classifySonioxRealtimeError(dead);
      if (kind === "retry") throw dead;
      this.reportFatal(kind, dead);
      return;
    }
    try {
      this.replayInto(next);
    } catch (err) {
      // replay ném (sendAudio trên session chết → StateError, hoặc handler ném khi chốt final): pair mới chưa là hiện tại
      // nên không ai khác đóng — đóng ở đây, pair cũ giữ nguyên, để backoff thử lại với cặp key mới.
      next.canonical.close();
      next.en.close();
      throw err;
    }
    this.swapGeneration(next);
    this.degraded = false;
    this.handlers.onRestored?.();
  }

  /**
   * Phiên âm lại từ mốc cuối đã emit: replay audio vào pair MỚI (epoch_conn = capture_ts chunk đầu được replay, fix B13)
   * và đặt cổng bỏ token đã emit. Nói liền quá 30 s hoặc buffer không phủ tới mốc thì chốt final của pair cũ trước.
   */
  private replayInto(next: ConnectionGeneration): void {
    const dropTs = this.lastFanOutTs;
    const plan = (): ReturnType<typeof computeReplayWindow> =>
      computeReplayWindow({
        lastEmittedEndAbsMs: this.lastEmitted,
        bufferOldestTs: this.reconnectBuffer.oldestCaptureTs,
        dropTs,
      });
    let replayFromTs = plan().replayFromTs;
    if (plan().needsFlush) {
      // Câu có thể bị tách đôi ở chỗ này, nhưng phần đã nói không bị mất và mốc tiến lên để replay ngắn lại.
      this.flushGenerationFinals(this.current);
      replayFromTs = clampReplayStart(plan().replayFromTs, this.reconnectBuffer.oldestCaptureTs, dropTs);
    }
    next.gate.canonical = this.lastEmitted.canonical;
    next.gate.en = this.lastEmitted.en;
    const chunks = this.reconnectBuffer.chunksSince(replayFromTs);
    const epoch = epochConnForReplay(chunks);
    if (epoch !== null) {
      next.canonical.setEpochConnMs(epoch);
      next.en.setEpochConnMs(epoch);
    }
    for (const chunk of chunks) fanOutChunk([next.canonical, next.en], chunk.data);
  }

  private swapGeneration(next: ConnectionGeneration): void {
    const previous = this.current;
    this.current = next;
    // Pair cũ đóng NGAY và mọi event của nó bị bỏ (handler kiểm `gen === this.current`): phần chưa chốt của nó đã được
    // pair mới phiên âm lại từ mốc cuối đã emit, giữ lại chỉ sinh câu lặp.
    previous.canonical.close();
    previous.en.close();
  }

  /**
   * Cổng chống phát lần hai: token thuộc phần ĐÃ emit trước khi rớt (pair mới phiên âm lại từ mốc − 300 ms) thì bỏ.
   *  - Token gốc: so ĐIỂM GIỮA token với cổng (không so mốc kết thúc) — hai phiên Soniox độc lập gán mốc cho cùng một từ
   *    lệch nhau vài chục ms, so cứng sẽ lọt đuôi từ cuối thành mảnh/câu lặp; điểm giữa chịu được lệch tới nửa độ dài token.
   *  - Token dịch không có `start_ms`/`end_ms`: đi theo trạng thái — bỏ cho tới khi token gốc đầu tiên của loại đó vượt cổng.
   * @returns true nếu token phải bỏ.
   */
  private isBeforeGate(gen: ConnectionGeneration, kind: ConnKind, token: RealtimeToken): boolean {
    const gate = gen.gate[kind];
    if (gate === Number.NEGATIVE_INFINITY) return false; // thế hệ đầu, hoặc loại này chưa emit gì: không có gì để chặn
    if (token.translation_status === "translation") return !gen.gateOpen[kind];
    if (token.text === "<end>") return false; // transport thô (mock/POC): không mang mốc, không phải lời nói
    const startMs = token.start_ms ?? token.end_ms;
    const endMs = token.end_ms ?? token.start_ms;
    const epoch = connOf(gen, kind).getEpochConnMs();
    if (startMs === undefined || endMs === undefined || epoch === null) {
      if (token.is_final) gen.gateOpen[kind] = true;
      return false;
    }
    const before = epoch + (startMs + endMs) / 2 <= gate;
    // Token provisional được Soniox gửi lại liên tục và chỉ vẽ bubble mờ: chỉ kiểm mốc, không đổi trạng thái cổng/probe.
    if (!token.is_final) return before;
    if (before) return true;
    if (!gen.gateOpen[kind] && this.isShiftedEmittedTail(kind, token.text, epoch + startMs, gate)) return true;
    gen.gateOpen[kind] = true;
    return false;
  }

  /**
   * Hai phiên Soniox đôi khi lệch mốc của cùng một token vượt dung sai điểm giữa (đo trên prod: +81..+198 ms, token dài 60–180 ms
   * ⇒ đuôi "す。" / " phút." của câu đã emit lọt thành utterance riêng; đuôi thường về thành NHIỀU token: "す" rồi "。"). Token sát
   * sau cổng chỉ bị coi là đuôi đã emit khi chữ của nó nằm trong vài ký tự CUỐI của câu đã emit. Chữ khác, hoặc trùng chữ ở xa
   * cuối câu ⇒ lời mới.
   */
  private isShiftedEmittedTail(kind: ConnKind, text: string, startAbsMs: number, gate: number): boolean {
    if (startAbsMs > gate + GATE_TAIL_SLACK_MS) return false;
    const emitted = this.lastEmittedText[kind];
    const at = emitted.lastIndexOf(text);
    return at >= 0 && emitted.length - (at + text.length) <= GATE_TAIL_REST_MAX_CHARS;
  }

  private handleToken(gen: ConnectionGeneration, kind: ConnKind, token: RealtimeToken): void {
    if (gen !== this.current || this.isBeforeGate(gen, kind, token)) return;
    const acc = accOf(gen, kind);
    const flushed = acc.feed(token);
    if (!flushed) {
      // Bubble mờ chỉ vẽ từ canonical (thế hệ cũ đã bị chặn ở dòng đầu hàm).
      if (kind === "canonical") this.handlers.onPartial?.(acc.partialText());
      return;
    }
    this.emitSegment(gen, kind, flushed);
  }

  /**
   * Endpoint (hết câu) từ SDK — đây là đường chốt segment THẬT ở production.
   * SDK lọc `<end>` khỏi stream token nên handleToken() không bao giờ tự chốt được;
   * thiếu handler này thì onCanonicalFinal/onEnFinal KHÔNG BAO GIỜ bắn và không
   * utterance nào được POST lên /utterances (bug P07, phát hiện qua E2E).
   */
  private handleEndpoint(gen: ConnectionGeneration, kind: ConnKind): void {
    if (gen === this.current) this.emitPending(gen, kind);
  }

  /** `finished` của SDK: `finish()` xả câu dở thì final có thể về mà KHÔNG kèm endpoint (E7) — chốt ở đây. */
  private handleFinished(gen: ConnectionGeneration, kind: ConnKind): void {
    if (gen === this.current) this.emitPending(gen, kind);
  }

  /** Chốt phần final đang tích luỹ của 1 thế hệ (bỏ đuôi provisional) thành segment — không kiểm thế hệ hiện tại. */
  private emitPending(gen: ConnectionGeneration, kind: ConnKind): void {
    const flushed = accOf(gen, kind).flush();
    if (!flushed) return;
    this.emitSegment(gen, kind, flushed);
    if (kind === "canonical") this.handlers.onPartial?.("");
  }

  private emitSegment(gen: ConnectionGeneration, kind: ConnKind, flushed: FlushedSegment): void {
    // Mốc tuyệt đối theo epoch của CHÍNH connection phát. Chưa feed chunk nào (epoch null) thì không có
    // trục để đặt segment lên — bỏ (token thật không thể tới trước khi có audio).
    const epoch = connOf(gen, kind).getEpochConnMs();
    if (epoch === null) return;
    const startAbsMs = epoch + flushed.startMs;
    const endAbsMs = epoch + flushed.endMs;
    this.lastEmitted[kind] = Math.max(this.lastEmitted[kind], endAbsMs);
    this.lastEmittedText[kind] = flushed.textOrig;
    if (kind === "canonical") {
      const sourceLang = flushed.language;
      this.handlers.onCanonicalFinal?.({
        textOrig: flushed.textOrig,
        language: flushed.language,
        speaker: flushed.speaker,
        startAbsMs,
        endAbsMs,
        translationVi: sourceLang === "ja" ? flushed.textTranslation : null,
        translationJa: sourceLang === "vi" ? flushed.textTranslation : null,
      });
    } else {
      this.handlers.onEnFinal?.({ textEn: flushed.textTranslation, startAbsMs, endAbsMs });
    }
  }

  private flushGenerationFinals(gen: ConnectionGeneration): void {
    this.emitPending(gen, "canonical");
    this.emitPending(gen, "en");
  }

  /** Đóng NGAY (unmount/lỗi). `flushPending`: chốt nốt phần final đã có của thế hệ hiện tại trước khi đóng — dùng khi
   *  bỏ cuộc reconnect để bớt mất câu đang nói. */
  async stop(opts: { flushPending?: boolean } = {}): Promise<void> {
    if (opts.flushPending) this.flushGenerationFinals(this.current);
    this.stopped = true;
    this.reconnectBuffer.clear();
    await closeAll([this.current.canonical, this.current.en]);
  }

  /**
   * Dừng êm khi người dùng bấm Kết thúc: `finish()` từng connection (song song, tối đa `timeoutMs`) để câu đang nói
   * và bản dịch của nó về kịp, rồi chốt nốt mọi phần final còn tích luỹ (kể cả khi hết timeout mà chưa `finished`).
   * Khác `stop()` ở chỗ có drain — `stop()` vẫn là đường đóng NGAY cho unmount/lỗi. Gọi khi đã dừng là no-op.
   */
  async drainAndStop(timeoutMs: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const gen = this.current;
    await Promise.all([gen.canonical.drain(timeoutMs), gen.en.drain(timeoutMs)]);
    this.flushGenerationFinals(gen);
    this.reconnectBuffer.clear();
  }
}
