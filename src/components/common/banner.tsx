import type { BannerKind } from "@/types/ui";
import { IconCheck } from "./icons";

interface BannerProps {
  /** null = không hiển thị. "lost" = mất kết nối (vàng), "ok" = đã nối lại (xanh), "silent" = chưa nhận được âm thanh (vàng, P05). */
  kind: BannerKind | null;
  /** Nguồn đang bị silence-detector theo dõi khác nhau theo mode (online = TAB ứng viên,
   *  direct = micro) — wording banner "silent" phải nói đúng nguồn, mic online vẫn thu
   *  bình thường khi tab im (Luke báo 2026-09-04: banner chung chung gây hiểu lầm). */
  mode?: "online" | "direct";
}

/** Banner trạng thái kết nối dưới header màn live. */
export function Banner({ kind, mode }: BannerProps) {
  if (kind === "silent") {
    return (
      <div className="flex flex-none items-center gap-[10px] border-b border-warning/30 bg-warning/[.08] px-[18px] py-[10px]">
        <span className="grid size-[19px] flex-none place-items-center rounded-chip bg-warning/15 text-[12px] font-bold text-warning">
          !
        </span>
        <span className="text-[14px] font-semibold text-warning">
          {mode === "direct"
            ? "Chưa nhận được âm thanh từ micro — kiểm tra thiết bị thu."
            : "Chưa nhận được âm thanh từ tab đang chia sẻ (phía bên kia) — mic của bạn vẫn thu bình thường. Kiểm tra đã bật “Chia sẻ âm thanh của thẻ”."}
        </span>
      </div>
    );
  }
  if (kind === "lost") {
    return (
      <div className="flex flex-none items-center gap-[10px] border-b border-warning/30 bg-warning/[.08] px-[18px] py-[10px]">
        <span className="grid size-[19px] flex-none place-items-center rounded-chip bg-warning/15 text-[12px] font-bold text-warning">
          !
        </span>
        <span className="text-[14px] font-semibold text-warning">
          Mất kết nối — đang thử lại.
        </span>
        <span className="text-[13.5px] text-secondary">
          Phần transcript đã ghi vẫn được giữ.
        </span>
      </div>
    );
  }
  if (kind === "ok") {
    return (
      <div className="flex flex-none items-center gap-[10px] border-b border-success/30 bg-success/[.07] px-[18px] py-[10px]">
        <IconCheck size={15} className="text-success" />
        <span className="text-[14px] font-semibold text-success">
          Đã nối lại — transcript được giữ nguyên.
        </span>
      </div>
    );
  }
  return null;
}
