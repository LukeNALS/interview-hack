"use client";

import { IconMonitor, IconUser } from "@/components/common/icons";

const CARD_CLASS =
  "flex min-w-[300px] flex-1 cursor-pointer flex-col gap-3.5 rounded-card-lg border border-card bg-panel px-7 py-[30px] text-left hover:border-accent hover:bg-panel-grad-soft hover:shadow-mode-hover";

const ICON_CHIP_CLASS =
  "grid size-[46px] place-items-center rounded-btn-xl border border-label/35 bg-label/[.13]";

/** 2 card chọn chế độ: online (nghe tab họp) / trực tiếp (micro máy). */
export function ModeCards({
  onPickOnline,
  onPickDirect,
}: {
  onPickOnline: () => void;
  onPickDirect: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-5">
      <button type="button" onClick={onPickOnline} className={CARD_CLASS}>
        <span className={ICON_CHIP_CLASS}>
          <IconMonitor size={22} strokeWidth={1.7} className="text-link" />
        </span>
        <div className="text-[19px] font-bold">Phỏng vấn online</div>
        <div className="text-[14.5px] leading-[1.65] text-secondary">
          Đang họp qua Meet, Zoom hay Teams trên trình duyệt này. Máy sẽ nghe âm
          thanh từ tab cuộc họp.
        </div>
      </button>
      <button type="button" onClick={onPickDirect} className={CARD_CLASS}>
        <span className={ICON_CHIP_CLASS}>
          <IconUser size={22} strokeWidth={1.7} className="text-link" />
        </span>
        <div className="text-[19px] font-bold">Phỏng vấn trực tiếp</div>
        <div className="text-[14.5px] leading-[1.65] text-secondary">
          Ứng viên ngồi cùng phòng. Dùng micro của máy này để nghe cả hai người.
        </div>
      </button>
    </div>
  );
}
