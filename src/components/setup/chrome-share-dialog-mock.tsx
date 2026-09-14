/** Mock hộp thoại chia sẻ của Chrome — minh họa tĩnh, 2 điểm khoanh tím đánh số. */

function CircledNumber({ n, className }: { n: number; className: string }) {
  return (
    <span
      className={`absolute grid size-5 place-items-center rounded-chip bg-accent-grad text-[11px] font-bold text-white shadow-logo ${className}`}
    >
      {n}
    </span>
  );
}

export function ChromeShareDialogMock() {
  return (
    <div className="relative rounded-card-md border border-control bg-dialog-mock p-5 shadow-dialog-mock">
      <div className="text-[14.5px] font-semibold">
        Chọn nội dung bạn muốn chia sẻ
      </div>
      <div className="mt-[2px] text-[12.5px] text-muted">
        interview-hack.app muốn chia sẻ nội dung màn hình của bạn
      </div>
      <div className="mt-[18px] flex gap-1.5">
        <span className="relative rounded-chip-lg bg-label/16 px-3.5 py-[7px] text-[13px] font-semibold text-accent-hover outline-2 outline-solid outline-accent outline-offset-[3px]">
          Thẻ Chrome
          <CircledNumber n={1} className="-left-[13px] -top-[13px]" />
        </span>
        <span className="px-3.5 py-[7px] text-[13px] text-muted">Cửa sổ</span>
        <span className="px-3.5 py-[7px] text-[13px] text-muted">
          Toàn màn hình
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <span className="flex items-center gap-[10px] rounded-chip-lg border border-label/30 bg-label/12 px-3 py-[9px] text-[13.5px] font-medium">
          <span className="size-2 flex-none rounded-full bg-success" />
          Google Meet — Phỏng vấn ứng viên Tuấn
        </span>
        <span className="flex items-center gap-[10px] rounded-chip-lg px-3 py-[9px] text-[13.5px] text-muted">
          <span className="size-2 flex-none rounded-full bg-strong" />
          Lịch tuyển dụng — Notion
        </span>
        <span className="flex items-center gap-[10px] rounded-chip-lg px-3 py-[9px] text-[13.5px] text-muted">
          <span className="size-2 flex-none rounded-full bg-strong" />
          Hộp thư — Gmail
        </span>
      </div>
      <div className="mt-[18px] flex items-center justify-between border-t border-card pt-3.5">
        <span className="relative inline-flex items-center gap-[9px] rounded-chip-md outline-2 outline-solid outline-accent outline-offset-[5px]">
          <span className="relative inline-block h-5 w-[34px] rounded-pill bg-accent-grad">
            <span className="absolute right-[2.5px] top-[2.5px] size-[15px] rounded-full bg-white" />
          </span>
          <span className="text-[13px] font-semibold">
            Chia sẻ âm thanh của thẻ
          </span>
          <CircledNumber n={2} className="-left-3.5 -top-3.5" />
        </span>
        <span className="flex gap-2">
          <span className="rounded-chip-lg border border-control px-4 py-[7px] text-[13px] text-muted">
            Hủy
          </span>
          <span className="rounded-chip-lg bg-accent-grad px-4 py-[7px] text-[13px] font-semibold text-white">
            Chia sẻ
          </span>
        </span>
      </div>
    </div>
  );
}
