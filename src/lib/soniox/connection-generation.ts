import type { SonioxConnection } from "./connection";
import type { TokenSegmentAccumulator } from "./token-segment-accumulator";

export type ConnKind = "canonical" | "en";

/**
 * Một THẾ HỆ connection = 1 cặp (canonical + en) cùng 2 accumulator RIÊNG. Reconnect dựng thế hệ mới; token/endpoint
 * của thế hệ cũ không bao giờ dồn vào accumulator của thế hệ mới (trước đây 1 cặp accumulator sống qua mọi swap nên
 * token cũ đến muộn bị ghép vào câu mới — audit #6). Thời gian segment tính bằng epoch của CHÍNH connection phát ra.
 */
export interface ConnectionGeneration {
  readonly id: number;
  canonical: SonioxConnection;
  en: SonioxConnection;
  readonly canonicalAcc: TokenSegmentAccumulator;
  readonly enAcc: TokenSegmentAccumulator;
  /** Cổng token theo loại (mốc tuyệt đối): bỏ token có `epoch + end_ms <=` mốc — phần đã emit trước khi rớt, pair mới
   *  phiên âm lại nhưng không được phát lần hai. -Infinity = không chặn (thế hệ đầu). */
  readonly gate: Record<ConnKind, number>;
  /** Token DỊCH không có mốc thời gian nên không gate theo thời gian được: chỉ nhận sau khi token gốc đầu tiên của loại đó
   *  vượt cổng (trước đó chúng là bản dịch của phần đã emit). */
  readonly gateOpen: Record<ConnKind, boolean>;
}

export const connOf = (gen: ConnectionGeneration, kind: ConnKind): SonioxConnection =>
  kind === "canonical" ? gen.canonical : gen.en;

export const accOf = (gen: ConnectionGeneration, kind: ConnKind): TokenSegmentAccumulator =>
  kind === "canonical" ? gen.canonicalAcc : gen.enAcc;
