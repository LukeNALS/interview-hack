"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/common/app-header";
import { LogoutButton } from "@/components/common/logout-button";
import { ApiError, persistClockOffset, useSession, useStartSession } from "@/hooks/use-session";
import { screenPath } from "@/lib/state-machine";
import { useSessionStore } from "@/stores/session-store";
import type { InterviewMode } from "@/types/ui";
import { ModeCards } from "./mode-cards";
import { SetupStartError } from "./setup-start-error";
import { SetupStepper } from "./setup-stepper";
import { TabGuide } from "./tab-guide";

/**
 * Màn /sessions/[id]/setup: bước "mode" (2 card) → online = màn hướng dẫn
 * chọn tab → live; trực tiếp = live NGAY. KHÔNG audio-check/mic-test/consent.
 */
export function SetupScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const setupStep = useSessionStore((s) => s.setupStep);
  const patch = useSessionStore((s) => s.patch);
  const startSession = useStartSession(sessionId);
  const session = useSession(sessionId);
  const [startError, setStartError] = useState<string | null>(null);

  /**
   * POST /start (trừ quota + status='live' + CHỐT `mode` lên server, BUG #4) RỒI mới
   * điều hướng /live — PHẢI chờ xong vì màn live cần `session.status==='live'` ngay ở
   * lần GET đầu (không poll lại). Persist `clock_offset = t0_local - started_at_server`
   * ngay lúc này (§Architecture, fix B14) — reload giữa buổi đọc lại key này.
   *
   * Lỗi:
   *  - `no_free_sessions` (hết quota): server đã TỪ CHỐI mở buổi -> hiện lỗi tại chỗ và
   *    DỪNG. Trước đây điều hướng bừa sang /live rồi bị guard đá về màn trước, user không
   *    nhận được lời giải thích nào (guard chỉ redirect, KHÔNG báo lỗi — BUG #5).
   *  - Lỗi khác (đặc biệt `session_already_started`: race, buổi đã live thật) giữ nguyên
   *    best-effort đi tiếp /live, để guard + useLiveSession xử theo status thật từ server.
   */
  const goLive = async (pickedMode: InterviewMode) => {
    setStartError(null);
    try {
      const result = await startSession.mutateAsync({ mode: pickedMode });
      persistClockOffset(sessionId, Date.now() - new Date(result.started_at).getTime());
    } catch (err) {
      if (err instanceof ApiError && err.code === "no_free_sessions") {
        setStartError(err.message);
        return;
      }
      // best-effort — xem docblock.
    }
    router.push(screenPath(sessionId, "live"));
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <AppHeader
        right={
          <span className="inline-flex items-center gap-3">
            <span className="text-[13px] text-secondary">
              {[session.data?.candidate_name, session.data?.position].filter(Boolean).join(" · ") || "Buổi phỏng vấn"}
            </span>
            <LogoutButton />
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto">
        {setupStep === "mode" ? (
          <div className="mx-auto box-content flex max-w-[820px] flex-col gap-[30px] px-6 pb-[110px] pt-[72px]">
            <div className="flex flex-col gap-3">
              <SetupStepper step="mode" />
              <h1 className="text-[32px] font-extrabold uppercase tracking-[-.02em]">
                Buổi phỏng vấn diễn ra thế nào?
              </h1>
            </div>
            {startError && <SetupStartError message={startError} />}
            <ModeCards
              onPickOnline={() =>
                patch({ mode: "online", setupStep: "tab-guide" })
              }
              onPickDirect={() => {
                patch({ mode: "direct" });
                void goLive("direct");
              }}
            />
          </div>
        ) : (
          <TabGuide
            onChooseTab={() => void goLive("online")}
            onBackMode={() => patch({ setupStep: "mode" })}
            startError={startError}
          />
        )}
      </div>
    </div>
  );
}
