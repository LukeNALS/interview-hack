"use client";

import { memo, useCallback, useEffect } from "react";
import { useStreamingText } from "@/hooks/use-streaming-text";
import { useSessionStore } from "@/stores/session-store";
import type { TransLang, UiUtterance } from "@/types/ui";
import { translationFor } from "./live-utils";

interface LiveTranscriptBubbleProps {
  utt: UiUtterance;
  /** Đang mở panel song song BẢN GỐC + BẢN DỊCH. */
  expanded: boolean;
  /** CHỈ bubble cuối đang typewriter — thực tế luôn false (sentinel null, xem live-screen). */
  streaming: boolean;
  viewOrig: boolean;
  transLang: TransLang;
  onToggleExpand: (uttId: number) => void;
  onStreamComplete: (uttId: number) => void;
}

/**
 * Hàng transcript dạng LIST PHẲNG (N13a, pivot 2026-09-03: Luke chốt liệt kê có thứ tự,
 * KHÔNG ô chat/bong bóng — thay cả box viền r14 lẫn bubble trái/phải bản đầu):
 * text trần + dòng meta nhỏ (chip lang + time); tên người nói nằm ở LiveTranscriptGroup.
 * Partial mờ .55, span time RỖNG. Giữ API ngầm cho test/report: `#utt-{id}` +
 * `opacity-55` + `.tabular-nums`. `memo` bắt buộc (P05 note) — transcript dài hàng trăm
 * lượt, patch 1 utterance không được re-render cả danh sách.
 */
function LiveTranscriptBubbleImpl({
  utt,
  expanded,
  streaming,
  viewOrig,
  transLang,
  onToggleExpand,
  onStreamComplete,
}: LiveTranscriptBubbleProps) {
  const handleComplete = useCallback(
    () => onStreamComplete(utt.id),
    [onStreamComplete, utt.id],
  );
  const { displayed } = useStreamingText(utt.orig, utt.lang, {
    enabled: streaming,
    onComplete: streaming ? handleComplete : undefined,
  });

  // Đồng bộ text đang stream vào store (disp) → auto-scroll bám theo từng nhịp.
  useEffect(() => {
    if (streaming) useSessionStore.getState().patchUtt(utt.id, { disp: displayed });
  }, [streaming, displayed, utt.id]);

  const trans = translationFor(utt, transLang);
  const bodyText = utt.partial
    ? streaming
      ? displayed
      : utt.disp
    : viewOrig
      ? utt.orig
      : trans;
  const showExpand = expanded && !utt.partial;

  return (
    <div
      id={`utt-${utt.id}`}
      onClick={() => {
        if (!utt.partial) onToggleExpand(utt.id);
      }}
      className={`flex flex-col gap-1 ${utt.partial ? "cursor-default opacity-55" : "cursor-pointer opacity-100"}`}
    >
      {showExpand ? (
        <div className="flex flex-col gap-2.5 rounded-btn-lg bg-input-deep px-3.5 py-3">
          <div className="flex flex-col gap-1">
            <span className="text-[9.5px] font-bold tracking-[.1em] text-link">
              BẢN GỐC · {utt.lang}
            </span>
            <span className="font-jp text-[15.5px] leading-[1.7] text-brighter">
              {utt.orig}
            </span>
          </div>
          <div className="h-px bg-label/20" />
          <div className="flex flex-col gap-1">
            <span className="text-[9.5px] font-bold tracking-[.1em] text-link">
              BẢN DỊCH · {transLang.toUpperCase()}
            </span>
            <span className="text-[15.5px] leading-[1.65] text-brighter">
              {trans}
            </span>
          </div>
          <span className="text-[11.5px] text-faint">
            Đang mở cả hai bản — bấm để đóng
          </span>
        </div>
      ) : (
        <div className="text-[16px] leading-[1.65] text-brighter">{bodyText}</div>
      )}
      <div className="flex items-center gap-2">
        <span className="rounded-[5px] border border-control bg-app/50 px-1.5 py-[1.5px] text-[9.5px] font-bold tracking-[.08em] text-muted">
          {utt.lang}
        </span>
        <span className="text-[10.5px] text-faint tabular-nums">{utt.time}</span>
      </div>
    </div>
  );
}

export const LiveTranscriptBubble = memo(LiveTranscriptBubbleImpl);
