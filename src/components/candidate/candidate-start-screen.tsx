"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AdminLinkButton } from "@/components/common/admin-link-button";
import { AppHeader } from "@/components/common/app-header";
import { FreeSessionsBadge } from "@/components/common/free-sessions-badge";
import { IconBolt } from "@/components/common/icons";
import { LogoutButton } from "@/components/common/logout-button";
import { Toast } from "@/components/common/toast";
import { useCreateSession } from "@/hooks/use-session";
import { useToast } from "@/hooks/use-toast";

/**
 * Màn bắt đầu buổi phỏng vấn: mô tả buổi phỏng vấn → tạo session
 * (mô tả lưu jd_text làm ngữ cảnh cho gợi ý trả lời) → sang màn setup
 * chọn online/trực tiếp.
 */
export function CandidateStartScreen() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [briefError, setBriefError] = useState(false);
  const [starting, setStarting] = useState(false);
  const createSession = useCreateSession();
  const { toast, showToast } = useToast();

  const start = async () => {
    if (!brief.trim()) {
      setBriefError(true);
      return;
    }
    setStarting(true);
    try {
      const session = await createSession.mutateAsync({
        mode: "online",
        kind: "candidate",
        jd_text: brief.trim(),
      });
      router.push(`/sessions/${session.id}/setup`);
    } catch {
      showToast("Tạo buổi thất bại — thử lại");
      setStarting(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <AppHeader
        right={
          <span className="inline-flex items-center gap-3">
            <AdminLinkButton />
            <FreeSessionsBadge />
            <LogoutButton />
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto box-content flex max-w-[860px] flex-col gap-[26px] px-6 pb-[88px] pt-[52px]">
          <div>
            <div className="text-[11px] font-bold tracking-[.22em] text-label">
              BƯỚC 0 · TRƯỚC BUỔI PHỎNG VẤN CỦA BẠN
            </div>
            <h1 className="mt-[10px] text-[38px] font-extrabold uppercase leading-[1.08] tracking-[-.02em]">
              Đi phỏng vấn
              <br />
              tự tin hơn<span className="text-accent">.</span>
            </h1>
            <div className="mt-3 text-[15px] text-secondary">
              Mô tả buổi phỏng vấn — khi người phỏng vấn đặt câu hỏi, AI sẽ gợi ý
              câu trả lời dễ hiểu ngay bên cạnh transcript.
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="candidate-brief" className="text-[13.5px] font-semibold text-bright">
              Buổi phỏng vấn này là gì?{" "}
              <span className="rounded-chip border border-control px-1.5 py-0.5 text-[10px] tracking-[.08em] text-muted">
                BẮT BUỘC
              </span>
            </label>
            <textarea
              id="candidate-brief"
              value={brief}
              onChange={(e) => {
                setBrief(e.target.value);
                setBriefError(false);
              }}
              placeholder="Ví dụ: Phỏng vấn vị trí Backend Engineer tại công ty X, vòng kỹ thuật, tập trung Node.js và thiết kế hệ thống. Tôi có 3 năm kinh nghiệm, điểm mạnh là tối ưu API."
              rows={5}
              className={`w-full resize-y rounded-btn-lg border bg-transparent px-4 py-3 text-[14px] leading-[1.6] text-bright placeholder:text-faint focus:outline-none ${
                briefError ? "border-danger/60" : "border-control focus:border-accent/60"
              }`}
            />
            {briefError && (
              <div className="text-[12.5px] text-danger-hover">Nhập mô tả buổi phỏng vấn trước đã.</div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={start}
              disabled={starting}
              className="flex h-[54px] cursor-pointer items-center justify-center gap-[10px] rounded-btn-xl bg-accent-grad text-base font-bold text-white shadow-cta hover:shadow-cta-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <IconBolt size={16} strokeWidth={2.2} />
              {starting ? "Đang tạo buổi…" : "Bắt đầu buổi phỏng vấn"}
            </button>
            <div className="text-center text-[13px] text-secondary">
              Bước sau chọn online (chia sẻ tab meeting) hoặc trực tiếp · buổi này
              tính 1 lượt như buổi thường, dưới 5 phút tự hoàn lượt
            </div>
          </div>
        </div>
      </div>
      <Toast message={toast} />
    </div>
  );
}
