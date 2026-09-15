"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { useToast } from "@/hooks/use-toast";

// Trang này KHÔNG public (middleware chặn) — chỉ vào được sau khi /auth/confirm
// verifyOtp(type=recovery) thành công và đã có session.
const HOME_PATH = "/candidate";

export default function ResetPasswordPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // Validate client-side trước — giống ngưỡng 8 ký tự của signup.
    if (password.length < 8) {
      setError("Mật khẩu phải có ít nhất 8 ký tự.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Mật khẩu nhập lại không khớp.");
      return;
    }

    setLoading(true);
    const supabase = createBrowserSupabaseClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    // Toast dùng chung store với /candidate — bắn trước khi điều hướng vẫn hiện được
    // ở màn kế tiếp vì store là singleton client-side (soft navigation, không reload).
    showToast("Đã đổi mật khẩu");
    router.push(HOME_PATH);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a11] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-white"
      >
        <h1 className="mb-6 text-xl font-semibold">Đặt mật khẩu mới</h1>

        <label className="mb-1 block text-sm text-white/70" htmlFor="password">
          Mật khẩu mới (tối thiểu 8 ký tự)
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none focus:border-[#a855f7]"
        />

        <label className="mb-1 block text-sm text-white/70" htmlFor="password-confirm">
          Nhập lại mật khẩu mới
        </label>
        <input
          id="password-confirm"
          type="password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none focus:border-[#a855f7]"
        />

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[#a855f7] px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {loading ? "Đang lưu…" : "Đổi mật khẩu"}
        </button>
      </form>
    </main>
  );
}
