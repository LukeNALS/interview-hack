import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/safe-internal-path";

/**
 * Luồng TOKEN HASH (mở được ở BẤT KỲ trình duyệt nào) — khác `/auth/callback`
 * (PKCE, chỉ mở được đúng trình duyệt đã bấm "quên mật khẩu"/đăng ký).
 * Dùng cho link trong template `recovery.html`/`confirmation.html`.
 */
const ALLOWED_TYPES: ReadonlySet<string> = new Set(["recovery", "signup", "email", "email_change", "magiclink"]);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  // Next dev (Turbopack) chuẩn hoá request.url/nextUrl.origin về "localhost" bất kể Host
  // header thật (vd "127.0.0.1:3100") — dùng thẳng Host header để dựng origin redirect,
  // nếu không cookie session vừa set (scope theo host) sẽ rớt ở request kế tiếp vì khác host.
  const host = request.headers.get("host");
  const origin = host ? `${request.nextUrl.protocol}//${host}` : new URL(request.url).origin;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (tokenHash && type && ALLOWED_TYPES.has(type)) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    if (!error) {
      // Recovery luôn sang màn đặt mật khẩu mới — không tôn trọng `next` ở đây
      // (đổi mật khẩu là bước bắt buộc, không cho nhảy thẳng chỗ khác).
      if (type === "recovery") {
        return NextResponse.redirect(`${origin}/reset-password`);
      }
      return NextResponse.redirect(`${origin}${safeInternalPath(searchParams.get("next"))}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link_invalid`);
}
