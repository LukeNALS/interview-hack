"use client";

import { ChromeShareDialogMock } from "./chrome-share-dialog-mock";
import { SetupStartError } from "./setup-start-error";
import { SetupStepper } from "./setup-stepper";

/**
 * Màn "Chọn tab cuộc họp" (mode online): mock hộp thoại share Chrome +
 * CTA → vào buổi NGAY (không có bước kiểm âm — dead code đã loại).
 */
export function TabGuide({
  onChooseTab,
  onBackMode,
  startError,
}: {
  onChooseTab: () => void;
  onBackMode: () => void;
  /** Lỗi POST /start (hết buổi miễn phí) — hiện TẠI CHỖ, không điều hướng (BUG #5). */
  startError?: string | null;
}) {
  return (
    <div className="mx-auto box-content flex max-w-[680px] flex-col gap-6 px-6 pb-20 pt-[52px]">
      <div className="flex flex-col gap-3">
        <SetupStepper step="tab-guide" />
        <h1 className="text-[28px] font-extrabold uppercase tracking-[-.02em]">
          Chọn tab cuộc họp
        </h1>
        <div className="text-[14.5px] leading-[1.65] text-secondary">
          Chrome sẽ hỏi bạn muốn chia sẻ gì. Chỉ cần làm đúng hai điểm khoanh
          tím:
        </div>
      </div>
      {startError && <SetupStartError message={startError} />}
      <ChromeShareDialogMock />
      <div className="flex flex-col gap-[10px]">
        <button
          type="button"
          onClick={onChooseTab}
          className="flex h-[54px] cursor-pointer items-center justify-center rounded-btn-xl bg-accent-grad text-[15.5px] font-bold text-white shadow-cta hover:shadow-cta-hover"
        >
          Chọn tab cuộc họp
        </button>
        <span className="text-center text-[12.5px] text-faint">
          Chọn xong là vào buổi ngay — máy bắt đầu nghe và ghi.
        </span>
        <button
          type="button"
          onClick={onBackMode}
          className="cursor-pointer text-center text-[13.5px] text-faint hover:text-accent-hover"
        >
          ← Quay lại chọn chế độ
        </button>
      </div>
    </div>
  );
}
