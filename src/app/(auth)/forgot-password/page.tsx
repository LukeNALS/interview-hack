"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { OPEN_LATEST_EMAIL_HINT } from "@/lib/password-reset-user-facing-messages";

const NEUTRAL_MESSAGE =
  "Nếu email này có tài khoản, bạn sẽ nhận được đường dẫn đặt lại mật khẩu trong ít phút.";

// Màn quên mật khẩu: LUÔN hiện thông báo trung tính sau khi gửi — kể cả khi email
// chưa từng đăng ký — để không lộ danh sách email đã có tài khoản (chống dò user).
// Chỉ lỗi mạng/rate-limit mới hiện thông báo khác (không gửi được thật sự).
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createBrowserSupabaseClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email);
    setLoading(false);

    const isRetryableError =
      resetError?.status === 429 ||
      resetError?.code === "over_email_send_rate_limit" ||
      resetError?.name === "AuthRetryableFetchError";
    if (isRetryableError) {
      setError("Không gửi được — thử lại sau ít phút.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0a11] px-4">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-white">
          <h1 className="mb-2 text-xl font-semibold">Kiểm tra email</h1>
          <p className="text-sm text-white/70">{NEUTRAL_MESSAGE}</p>
          <p className="mt-3 text-sm font-medium text-white">{OPEN_LATEST_EMAIL_HINT}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a11] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-white"
      >
        <h1 className="mb-6 text-xl font-semibold">Quên mật khẩu</h1>

        <label className="mb-1 block text-sm text-white/70" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none focus:border-[#a855f7]"
        />

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[#a855f7] px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {loading ? "Đang gửi…" : "Gửi đường dẫn đặt lại"}
        </button>

        <p className="mt-4 text-center text-sm text-white/60">
          <Link href="/login" className="text-[#a855f7] hover:underline">
            Quay lại đăng nhập
          </Link>
        </p>
      </form>
    </main>
  );
}
