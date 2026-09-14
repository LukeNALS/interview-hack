import { IconCheck } from "./icons";

interface ToastProps {
  /** Chuỗi rỗng = không hiển thị. Tự ẩn sau 2.4s do use-toast quản lý. */
  message: string;
}

/** Toast pill nổi giữa đáy màn — xác nhận lưu/xóa/copy… */
export function Toast({ message }: ToastProps) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="fixed bottom-[26px] left-1/2 z-[99] inline-flex -translate-x-1/2 items-center gap-[9px] rounded-pill border border-label/45 bg-popover px-[18px] py-[10px] text-[13.5px] font-semibold text-primary shadow-toast"
    >
      <IconCheck className="text-link" />
      {message}
    </div>
  );
}
