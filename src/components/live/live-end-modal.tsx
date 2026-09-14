"use client";

import { Modal } from "@/components/common/modal";
import { useSessionStore } from "@/stores/session-store";

interface LiveEndModalProps {
  /** M3 fix (DRY): dùng chung `endInterview()` từ `useLiveSession` — đóng stream, flush ingest
   *  queue, POST /end best-effort, rồi tự điều hướng về /candidate bên trong. */
  onConfirmEnd: () => void | Promise<void>;
}

/**
 * Modal xác nhận kết thúc buổi: "Quay lại" outline + "Kết thúc" gradient đỏ
 * → gọi `onConfirmEnd()` (đường DUY NHẤT kết thúc buổi, chung với cap
 * auto-stop/409 session_ended — xem `useLiveSession.endInterview`).
 */
export function LiveEndModal({ onConfirmEnd }: LiveEndModalProps) {
  const confirmEnd = useSessionStore((s) => s.confirmEnd);
  const patch = useSessionStore((s) => s.patch);

  return (
    <Modal open={confirmEnd} title="Kết thúc buổi phỏng vấn?">
      <div className="text-[14.5px] leading-[1.65] text-secondary">
        Buổi sẽ dừng ghi ngay — bạn không thể ghi tiếp sau khi kết thúc.
      </div>
      <div className="mt-1 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={() => patch({ confirmEnd: false })}
          className="inline-flex h-11 cursor-pointer items-center justify-center rounded-btn-md border border-control bg-transparent px-5 text-[14px] font-semibold text-bright hover:border-muted"
        >
          Quay lại
        </button>
        <button
          type="button"
          onClick={() => {
            patch({ confirmEnd: false });
            void onConfirmEnd();
          }}
          className="inline-flex h-11 cursor-pointer items-center justify-center rounded-btn-md bg-danger-grad px-[22px] text-[14px] font-bold text-white shadow-danger"
        >
          Kết thúc
        </button>
      </div>
    </Modal>
  );
}
