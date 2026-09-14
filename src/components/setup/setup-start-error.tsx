"use client";

/**
 * BUG #5 — báo lỗi TẠI CHỖ khi POST /start bị từ chối (hết buổi miễn phí).
 * Màn setup không render <Toast>, mà trước đây code lại điều hướng ngay sang /live
 * nên toast (nếu có) cũng chết theo remount: user chỉ thấy màn nhấp nháy rồi quay
 * về nút cũ, không một chữ giải thích. Message lấy THẲNG từ server (start/route.ts)
 * để chỉ có 1 nguồn sự thật cho câu chữ.
 */
export function SetupStartError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-danger/35 bg-danger/[.08] px-4 py-3 text-[14px] leading-[1.6] text-danger"
    >
      {message} Buổi phỏng vấn chưa được bắt đầu.
    </div>
  );
}
