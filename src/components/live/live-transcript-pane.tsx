"use client";

import { useMemo } from "react";
import { IconArrowDown, IconMic } from "@/components/common/icons";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { useSessionStore } from "@/stores/session-store";
import { LiveTranscriptGroup } from "./live-transcript-group";
import { groupUtterancesBySpeaker } from "./live-transcript-grouping";

interface LiveTranscriptPaneProps {
  /** id lượt thoại đang typewriter (null = không có) — P05: luôn null (partial thật render trực tiếp).
   *  KHÔNG dùng số âm làm sentinel: id âm là bubble partial thật (-1 mic/mixed, -2 tab). */
  streamingId: number | null;
  onStreamComplete: (uttId: number) => void;
  /**
   * Ẩn bằng CSS thay vì unmount (tab narrow ≠ Transcript) — giữ bubble đang
   * stream sống để kịch bản demo không kẹt giữa chừng.
   */
  hidden?: boolean;
}

/** Cột transcript giữa: bubble streaming, auto-scroll + pill "Xuống cuối", scroll tới câu hỏi đang chọn. */
export function LiveTranscriptPane({
  streamingId,
  onStreamComplete,
  hidden = false,
}: LiveTranscriptPaneProps) {
  const utts = useSessionStore((s) => s.utts);
  const expUtt = useSessionStore((s) => s.expUtt);
  const viewOrig = useSessionStore((s) => s.viewOrig);
  const transLang = useSessionStore((s) => s.transLang);
  const patch = useSessionStore((s) => s.patch);
  const { ref, paused, onScroll, scrollToBottom } =
    useAutoScroll<HTMLDivElement>(utts);
  // N13a: nhóm lượt liên tiếp cùng người nói thành cụm chat trái/phải.
  const groups = useMemo(() => groupUtterancesBySpeaker(utts), [utts]);

  return (
    <div
      className={`relative min-h-0 min-w-0 flex-1 flex-col ${hidden ? "hidden" : "flex"}`}
    >
      {utts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-10">
          <span className="grid size-[46px] place-items-center rounded-card border border-label/30 bg-label/10">
            <IconMic size={20} strokeWidth={1.7} className="text-link" />
          </span>
          <div className="text-[15.5px] text-secondary">
            Bắt đầu nói chuyện, transcript sẽ hiện ở đây
          </div>
          <div className="text-[10.5px] tracking-[.08em] text-faint">
            ĐANG NGHE ÂM THANH TỪ CUỘC HỌP
          </div>
        </div>
      ) : (
        <div
          ref={ref}
          onScroll={onScroll}
          className="flex flex-1 flex-col gap-4 overflow-y-auto px-[26px] pt-[18px] pb-14"
        >
          {groups.map((group) => (
            <LiveTranscriptGroup
              key={group.key}
              group={group}
              expUtt={expUtt}
              viewOrig={viewOrig}
              transLang={transLang}
              streamingId={streamingId}
              onToggleExpand={(id) =>
                patch({ expUtt: expUtt === id ? -1 : id })
              }
              onStreamComplete={onStreamComplete}
            />
          ))}
        </div>
      )}
      {paused && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 cursor-pointer items-center gap-[7px] rounded-pill border border-label/45 bg-popover px-[15px] py-2 text-[12.5px] font-semibold text-primary shadow-pill-float hover:border-accent"
        >
          <IconArrowDown size={12} strokeWidth={2.2} className="text-link" />
          Xuống cuối
        </button>
      )}
    </div>
  );
}
