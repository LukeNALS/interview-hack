import Link from "next/link";
import type { ReactNode } from "react";
import { IconBolt } from "./icons";

/** Logo tia sét + wordmark — dùng lại ở header các màn. */
export function AppLogo() {
  return (
    <span className="inline-flex items-center gap-[10px]">
      <span className="grid size-[26px] flex-none place-items-center rounded-lg bg-accent-grad shadow-logo">
        <IconBolt className="text-white" />
      </span>
      <span className="text-[15px] font-bold tracking-[.01em] text-primary">
        Interview <span className="text-link">Hack</span>
      </span>
    </span>
  );
}

interface AppHeaderProps {
  /** Nhãn phụ sau logo, vd "BÁO CÁO PHỎNG VẤN". */
  label?: string;
  /** Slot phải: badge, nút điều khiển… */
  right?: ReactNode;
  /** Đích khi bấm logo — mặc định về màn chuẩn bị (chuẩn web: logo = về home).
   *  Truyền `null` để TẮT (trang chia sẻ công khai: khách chưa đăng nhập, bấm logo
   *  bị đá sang /login là trải nghiệm tệ hơn không có link). */
  logoHref?: string | null;
}

/** Header 60px cố định (candidate/setup). Màn live có header 62px riêng. */
export function AppHeader({ label, right, logoHref = "/candidate" }: AppHeaderProps) {
  return (
    <header className="flex h-[60px] flex-none items-center justify-between border-b border-divider bg-app/80 px-7">
      <span className="inline-flex items-center gap-[14px]">
        {logoHref ? (
          <Link href={logoHref} aria-label="Về màn chuẩn bị">
            <AppLogo />
          </Link>
        ) : (
          <AppLogo />
        )}
        {label ? (
          <>
            <span className="h-[18px] w-px bg-control" />
            <span className="text-[11px] tracking-[.1em] text-muted">
              {label}
            </span>
          </>
        ) : null}
      </span>
      {right}
    </header>
  );
}
