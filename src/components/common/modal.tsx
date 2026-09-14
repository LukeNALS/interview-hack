import type { ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  /** Nội dung + hàng nút do màn gọi tự soạn (vd Quay lại / Kết thúc). */
  children: ReactNode;
}

/** Modal giữa màn: overlay tối, card 460px (vd xác nhận kết thúc buổi). */
export function Modal({ open, title, children }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-overlay pt-[130px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="box-content flex w-[460px] max-w-[92vw] flex-col gap-4 rounded-card-lg border border-control bg-panel p-7 shadow-card-float"
      >
        <div className="text-[19px] font-bold text-primary">{title}</div>
        {children}
      </div>
    </div>
  );
}
