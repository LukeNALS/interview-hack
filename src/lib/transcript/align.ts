/**
 * Merges finals from the canonical connection (`two_way ja<->vi`, authoritative for
 * boundaries/speaker/text_orig) with finals from the `en` connection (`one_way->en`,
 * contributes only the `en` translation) using temporal IoU — per P01 conclusion
 * (validated 100% match, median delta=0ms on POC data) and phase-05 §Architecture.
 *
 * No network/timers touch the outside world directly: the 1.2s "wait for en" delay is
 * driven by an injectable `scheduleWait` so tests can trigger it deterministically
 * without real timers (development-rules "DI mọi side-effect").
 */

export interface TimeRangeMs {
  t_start_ms: number;
  t_end_ms: number;
}

export interface CanonicalFinal extends TimeRangeMs {
  client_utt_id: string;
  speaker: string | null;
  lang: string | null;
  text_orig: string;
  /** two_way conn only ever yields vi/ja — en always comes from the other connection. */
  translations: { vi: string | null; ja: string | null };
}

export interface EnFinal extends TimeRangeMs {
  text_en: string;
}

export interface AlignedUtterance extends TimeRangeMs {
  client_utt_id: string;
  speaker: string | null;
  lang: string | null;
  text_orig: string;
  translations: { vi: string | null; ja: string | null; en: string | null };
  en_pending: boolean;
}

/** Temporal Intersection-over-Union between two [t_start_ms, t_end_ms] ranges. */
export function computeIou(a: TimeRangeMs, b: TimeRangeMs): number {
  const overlap = Math.max(0, Math.min(a.t_end_ms, b.t_end_ms) - Math.max(a.t_start_ms, b.t_start_ms));
  const union = Math.max(a.t_end_ms, b.t_end_ms) - Math.min(a.t_start_ms, b.t_start_ms);
  if (union <= 0) return 0;
  return overlap / union;
}

/**
 * Direct mode: maps "Speaker N" labels between the canonical and en connections by
 * majority overlap over already-paired utterances. Returns an empty map (→ caller falls
 * back to canonical's own speaker label, per §Architecture step 7) when no pairs carry
 * speaker info on both sides.
 */
export function mapSpeakerLabels(
  pairs: Array<{ canonicalSpeaker: string | null; enSpeaker: string | null }>,
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const p of pairs) {
    if (!p.canonicalSpeaker || !p.enSpeaker) continue;
    const inner = counts.get(p.canonicalSpeaker) ?? new Map<string, number>();
    inner.set(p.enSpeaker, (inner.get(p.enSpeaker) ?? 0) + 1);
    counts.set(p.canonicalSpeaker, inner);
  }
  const result = new Map<string, string>();
  for (const [canonicalSpeaker, inner] of counts) {
    let best: string | null = null;
    let bestCount = -1;
    for (const [enSpeaker, count] of inner) {
      if (count > bestCount) {
        best = enSpeaker;
        bestCount = count;
      }
    }
    if (best) result.set(canonicalSpeaker, best);
  }
  return result;
}

export type CancelWait = () => void;
export type ScheduleWaitFn = (cb: () => void, ms: number) => CancelWait;

const defaultScheduleWait: ScheduleWaitFn = (cb, ms) => {
  const timer = setTimeout(cb, ms);
  return () => clearTimeout(timer);
};

export interface AlignBufferOptions {
  /** IoU threshold to consider a canonical/en pair a match. Default 0.5 (P01 conclusion). */
  iouThreshold?: number;
  /** Max wait for a matching en final before emitting with en_pending=true. Default 1200ms. */
  enWaitMs?: number;
  /** Called once per emitted/updated utterance. `isUpdate=true` on late-en upsert. */
  onEmit: (utterance: AlignedUtterance, isUpdate: boolean) => void;
  scheduleWait?: ScheduleWaitFn;
}

interface PendingCanonical {
  final: CanonicalFinal;
  cancel: CancelWait;
}

/** Stateful align buffer — one instance per live session (or per speaker stream). */
export class AlignBuffer {
  private readonly iouThreshold: number;
  private readonly enWaitMs: number;
  private readonly scheduleWait: ScheduleWaitFn;
  private readonly pendingCanonical = new Map<string, PendingCanonical>();
  private readonly unmatchedEn: EnFinal[] = [];
  private readonly emitted = new Map<string, AlignedUtterance>();

  constructor(private readonly opts: AlignBufferOptions) {
    this.iouThreshold = opts.iouThreshold ?? 0.5;
    this.enWaitMs = opts.enWaitMs ?? 1200;
    this.scheduleWait = opts.scheduleWait ?? defaultScheduleWait;
  }

  /** Feed one final utterance from the canonical (two_way ja<->vi) connection. */
  addCanonicalFinal(final: CanonicalFinal): void {
    const matchIdx = this.bestMatchIndex(final, this.unmatchedEn);
    if (matchIdx >= 0) {
      const [en] = this.unmatchedEn.splice(matchIdx, 1);
      this.emit(final, en, false);
      return;
    }
    const cancel = this.scheduleWait(() => this.onCanonicalWaitTimeout(final.client_utt_id), this.enWaitMs);
    this.pendingCanonical.set(final.client_utt_id, { final, cancel });
  }

  /** Feed one final utterance from the en (one_way->en) connection. */
  addEnFinal(en: EnFinal): void {
    for (const [id, pending] of this.pendingCanonical) {
      if (computeIou(pending.final, en) >= this.iouThreshold) {
        pending.cancel();
        this.pendingCanonical.delete(id);
        this.emit(pending.final, en, false);
        return;
      }
    }
    for (const [id, existing] of this.emitted) {
      if (existing.en_pending && computeIou(existing, en) >= this.iouThreshold) {
        const updated: AlignedUtterance = {
          ...existing,
          translations: { ...existing.translations, en: en.text_en },
          en_pending: false,
        };
        this.emitted.set(id, updated);
        this.opts.onEmit(updated, true);
        return;
      }
    }
    // No canonical waiting yet (out-of-order arrival) — hold for a future canonical final.
    this.unmatchedEn.push(en);
  }

  private onCanonicalWaitTimeout(clientUttId: string): void {
    const pending = this.pendingCanonical.get(clientUttId);
    if (!pending) return;
    this.pendingCanonical.delete(clientUttId);
    this.emit(pending.final, null, false);
  }

  private bestMatchIndex(range: TimeRangeMs, candidates: TimeRangeMs[]): number {
    let bestIdx = -1;
    let bestIou = 0;
    candidates.forEach((c, i) => {
      const v = computeIou(range, c);
      if (v > bestIou && v >= this.iouThreshold) {
        bestIou = v;
        bestIdx = i;
      }
    });
    return bestIdx;
  }

  private emit(final: CanonicalFinal, en: EnFinal | null, isUpdate: boolean): void {
    const aligned: AlignedUtterance = {
      client_utt_id: final.client_utt_id,
      speaker: final.speaker,
      lang: final.lang,
      text_orig: final.text_orig,
      translations: { vi: final.translations.vi, ja: final.translations.ja, en: en?.text_en ?? null },
      t_start_ms: final.t_start_ms,
      t_end_ms: final.t_end_ms,
      en_pending: en === null,
    };
    this.emitted.set(final.client_utt_id, aligned);
    this.opts.onEmit(aligned, isUpdate);
  }

  /**
   * Đóng buffer — call on stopCapture()/unmount.
   *
   * N4 fix: huỷ timer chờ EN nhưng EMIT NỐT phần đang chờ, y hệt `onCanonicalWaitTimeout`
   * (`en: null` / `en_pending: true`) — dispose có nghĩa "hết giờ chờ NGAY", KHÔNG phải
   * "vứt câu đang chờ". Trước đây chỉ `cancel()` nên bấm "Kết thúc" trong cửa sổ 1.2s là
   * mất CÂU CUỐI buổi: nó chưa từng tới `onEmit` → chưa từng vào `ingestQueue` → không cơ
   * chế flush nào cứu được. Idempotent: map được clear nên gọi lần 2 không đẻ bản trùng.
   */
  dispose(): void {
    const pendings = [...this.pendingCanonical.values()];
    this.pendingCanonical.clear();
    for (const pending of pendings) {
      pending.cancel();
      this.emit(pending.final, null, false);
    }
  }
}
