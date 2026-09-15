"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

const LINK_INVALID_MESSAGE = "Đường dẫn không hợp lệ hoặc đã hết hạn. Hãy yêu cầu lại.";

// Màn login tối giản (token màu chính — UI chi tiết hoàn thiện ở P03).
function LoginForm() {
  const router = useRouter();
  // useSearchParams cần bọc Suspense (Next 16) — đọc ?error=link_invalid từ /auth/confirm.
  const searchParams = useSearchParams();
  const linkInvalid = searchParams.get("error") === "link_invalid";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createBrowserSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push("/candidate");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a11] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-white"
      >
        <h1 className="mb-6 text-xl font-semibold">Đăng nhập Interview Hack</h1>

        {linkInvalid && <p className="mb-4 text-sm text-red-400">{LINK_INVALID_MESSAGE}</p>}

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
          Mật khẩu
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none focus:border-[#a855f7]"
        />

        <p className="mb-4 text-right text-sm">
          <Link href="/forgot-password" className="text-[#a855f7] hover:underline">
            Quên mật khẩu?
          </Link>
        </p>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[#a855f7] px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {loading ? "Đang đăng nhập…" : "Đăng nhập"}
        </button>

        <p className="mt-4 text-center text-sm text-white/60">
          Chưa có tài khoản?{" "}
          <Link href="/signup" className="text-[#a855f7] hover:underline">
            Đăng ký
          </Link>
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
