"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * Nút thoát phiên ở header. Dùng browser client giống login/page.tsx — `@supabase/ssr`
 * tự dọn cookie chunk `sb-<ref>-auth-token.N`, KHÔNG tự xoá cookie bằng tay.
 * `router.refresh()` sau khi điều hướng: server component còn cache phiên cũ thì
 * quay lại bằng nút back vẫn thấy dữ liệu của người vừa thoát.
 */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      await supabase.auth.signOut();
    } catch (err) {
      // signOut lỗi (mạng, GoTrue down) vẫn PHẢI rời trang — cookie phía server sẽ tự
      // hết hạn; giữ user kẹt lại với nút khoá vĩnh viễn mới là hỏng thật.
      console.warn("[logout] signOut lỗi, vẫn điều hướng về /login", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={busy}
      className="rounded-pill border border-control px-[13px] py-[5px] text-[11px] tracking-[.08em] text-secondary transition-none hover:border-label/35 hover:text-primary disabled:opacity-50"
    >
      ĐĂNG XUẤT
    </button>
  );
}
