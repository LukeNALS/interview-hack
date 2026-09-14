"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

// Màn signup tối giản (token màu chính — UI chi tiết hoàn thiện ở P03).
export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createBrowserSupabaseClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    /**
     * Xác nhận email TẮT (Supabase local bật autoconfirm, hoặc project tắt confirmations):
     * `signUp` trả về session sẵn — user ĐÃ đăng nhập. Chặn bằng màn "Kiểm tra email"
     * lúc này là sai: không bao giờ có mail nào tới, user kẹt ở màn cụt.
     * Confirmations BẬT (mặc định prod): `session` null -> giữ nguyên màn chờ xác nhận.
     */
    if (data.session) {
      router.push("/candidate");
      router.refresh();
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0a11] px-4">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-white">
          <h1 className="mb-2 text-xl font-semibold">Kiểm tra email</h1>
          <p className="text-sm text-white/70">
            Đã gửi link xác nhận tới <span className="text-white">{email}</span>. Xác nhận email trước khi dùng
            tính năng AI.
          </p>
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
        <h1 className="mb-6 text-xl font-semibold">Tạo tài khoản Interview Hack</h1>

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

        <label className="mb-1 block text-sm text-white/70" htmlFor="password">
          Mật khẩu (tối thiểu 8 ký tự)
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

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[#a855f7] px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {loading ? "Đang tạo tài khoản…" : "Đăng ký"}
        </button>

        <p className="mt-4 text-center text-sm text-white/60">
          Đã có tài khoản?{" "}
          <Link href="/login" className="text-[#a855f7] hover:underline">
            Đăng nhập
          </Link>
        </p>
      </form>
    </main>
  );
}
