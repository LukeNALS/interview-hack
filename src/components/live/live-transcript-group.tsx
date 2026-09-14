"use client";

import { memo } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { TransLang } from "@/types/ui";
import { LiveTranscriptBubble } from "./live-transcript-bubble";
import type { UtteranceGroup } from "./live-transcript-grouping";

interface LiveTranscriptGroupProps {
  group: UtteranceGroup;
  expUtt: number;
  viewOrig: boolean;
  transLang: TransLang;
  streamingId: number | null;
  onToggleExpand: (uttId: number) => void;
  onStreamComplete: (uttId: number) => void;
}

/**
 * Nhóm transcript N13a (pivot 2026-09-03: LIST phẳng, không căn trái/phải):
 * tên người nói hiện 1 lần đầu chuỗi lượt liên tiếp (PV màu accent, ứng viên trắng),
 * các hàng bên dưới là text trần. `data-pv` là hook cho test (unit + e2e), đừng đổi tên.
 */
function LiveTranscriptGroupImpl({
  group,
  expUtt,
  viewOrig,
  transLang,
  streamingId,
  onToggleExpand,
  onStreamComplete,
}: LiveTranscriptGroupProps) {
  const candidateName = useSessionStore((s) => s.candidateName);
  const isPv = group.pv === 1;

  return (
    <section data-pv={group.pv} className="flex flex-col gap-2">
      <span
        className={`text-[12.5px] font-bold ${isPv ? "text-accent-hover" : "text-primary"}`}
      >
        {isPv ? "Người phỏng vấn" : candidateName}
      </span>
      {group.utts.map((utt) => (
        <LiveTranscriptBubble
          key={utt.id}
          utt={utt}
          expanded={expUtt === utt.id}
          streaming={streamingId === utt.id}
          viewOrig={viewOrig}
          transLang={transLang}
          onToggleExpand={onToggleExpand}
          onStreamComplete={onStreamComplete}
        />
      ))}
    </section>
  );
}

export const LiveTranscriptGroup = memo(LiveTranscriptGroupImpl);
