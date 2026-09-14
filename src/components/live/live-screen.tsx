"use client";

import { useEffect } from "react";
import { Banner } from "@/components/common/banner";
import { Toast } from "@/components/common/toast";
import { useLiveSession } from "@/hooks/use-live-session";
import { useNarrow } from "@/hooks/use-narrow";
import { useSession } from "@/hooks/use-session";
import { useToast } from "@/hooks/use-toast";
import { useSessionStore } from "@/stores/session-store";
import { LiveEndModal } from "./live-end-modal";
import { LiveHeader } from "./live-header";
import { LiveSuggestionColumn } from "./live-suggestion-column";
import { LiveTabsBar } from "./live-tabs-bar";
import { LiveTranscriptPane } from "./live-transcript-pane";

/** Partial/final thật render trực tiếp (Soniox đã tự "gõ" incremental) — không dùng typewriter mock nữa.
 *  PHẢI là null, KHÔNG dùng -1: -1 cũng là id bubble partial của stream mic/mixed (attach-stream.ts)
 *  — trùng sentinel làm bubble partial bị typewriter reset mỗi nhịp Soniox → chữ "nhảy" (2026-08-25). */
export const NO_STREAMING_ID: number | null = null;
const noopStreamComplete = () => {};

interface LiveScreenProps {
  sessionId: string;
}

/**
 * Màn "Trong buổi phỏng vấn" — 2 vùng full-height, breakpoint DUY NHẤT 1100px:
 * ≥1100px 2 cột (transcript co giãn / gợi ý trả lời 290), <1100px 1 cột + thanh tab pill.
 */
export function LiveScreen({ sessionId }: LiveScreenProps) {
  const narrow = useNarrow();
  const { endInterview } = useLiveSession(sessionId);
  // Cache hit — useLiveSession đã fetch cùng queryKey; chỉ để banner "silent" nói đúng
  // nguồn im lặng theo mode (online = tab người phỏng vấn, direct = micro).
  const { data: session } = useSession(sessionId);
  const liveTab = useSessionStore((s) => s.liveTab);
  const banner = useSessionStore((s) => s.banner);
  const patch = useSessionStore((s) => s.patch);
  const { toast } = useToast();

  // Sync narrow vào store cho phần cần cross-component (hook là nguồn sự thật).
  useEffect(() => {
    patch({ narrow });
  }, [narrow, patch]);

  const showTranscript = !narrow || liveTab === "transcript";
  const showSuggest = !narrow || liveTab === "suggest";
  // Transcript pane KHÔNG unmount khi đổi tab — bubble đang stream phải sống
  // để kịch bản demo chạy tiếp (ẩn bằng CSS, xem LiveTranscriptPane.hidden).

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <LiveHeader narrow={narrow} />
      <Banner kind={banner} mode={session?.mode} />
      {narrow && <LiveTabsBar />}
      <div className="flex min-h-0 flex-1 items-stretch">
        <LiveTranscriptPane
          streamingId={NO_STREAMING_ID}
          onStreamComplete={noopStreamComplete}
          hidden={!showTranscript}
        />
        {showSuggest && <LiveSuggestionColumn narrow={narrow} />}
      </div>
      {/* Kết thúc là XONG — không có report, luôn về /candidate. */}
      <LiveEndModal onConfirmEnd={endInterview} />
      <Toast message={toast} />
    </div>
  );
}
