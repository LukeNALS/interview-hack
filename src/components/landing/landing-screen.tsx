"use client";

import Link from "next/link";
import { AppLogo } from "@/components/common/app-header";
import { IconBolt } from "@/components/common/icons";
import { FaqSection, FeaturesSection, ModesSection, StatsRow } from "./landing-sections";
import { LANDING_COPY, LANDING_LANG_LABELS, useLandingLang, type LandingLang } from "./landing-i18n";

const LANGS: LandingLang[] = ["vi", "en", "ja"];

/**
 * Landing page `/` cho khách chưa đăng nhập — Interview Hack chỉ dành cho
 * ứng viên. Switcher ngôn ngữ CHỮ (VI · EN · 日本語, không icon — yêu cầu Luke).
 * SSR render VI nên SEO + e2e anchor tiếng Việt giữ nguyên. KHÔNG pricing
 * (chưa thu tiền trước review APPI §1).
 */
export function LandingScreen() {
  const [lang, setLang] = useLandingLang();
  const copy = LANDING_COPY[lang];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-[60px] flex-none items-center justify-between border-b border-divider bg-app/85 px-7 backdrop-blur">
        <AppLogo />
        <nav className="flex items-center gap-3">
          {/* Switcher ngôn ngữ dạng chữ — không icon. */}
          <span className="mr-1 inline-flex items-center gap-0.5" aria-label="Ngôn ngữ / Language">
            {LANGS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`cursor-pointer rounded-chip px-2 py-1 text-[12px] font-bold tracking-[.04em] ${
                  lang === l ? "text-bright underline underline-offset-4" : "text-muted hover:text-secondary"
                }`}
              >
                {LANDING_LANG_LABELS[l]}
              </button>
            ))}
          </span>
          <Link
            href="/login"
            className="inline-flex h-[38px] items-center justify-center rounded-btn border border-control px-4 text-[13.5px] font-semibold text-bright transition-colors hover:border-muted"
          >
            {copy.nav.login}
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-[38px] items-center justify-center rounded-btn bg-accent-grad px-[18px] text-[13.5px] font-bold text-white shadow-cta transition-all hover:text-[#ffa94d] hover:shadow-cta-hover"
          >
            {copy.nav.signup}
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto box-content max-w-[980px] px-6 pb-16 pt-[72px] text-center">
          <div className="inline-flex items-center gap-2 rounded-chip-lg border border-accent/40 bg-label/10 px-3.5 py-1.5 text-[11px] font-bold tracking-[.18em] text-accent-hover">
            <IconBolt size={11} strokeWidth={2.4} />
            {copy.hero.badge}
          </div>
          <h1 className="mx-auto mt-5 max-w-[760px] text-[40px] font-extrabold uppercase leading-[1.1] tracking-[-.02em] text-primary sm:text-[52px]">
            {copy.hero.titleTop}
            <br />
            {copy.hero.titleBottom}
            <span className="text-accent">.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[620px] text-[16px] leading-[1.7] text-secondary">
            {copy.hero.sub}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex h-[54px] items-center justify-center gap-[10px] rounded-btn-xl bg-accent-grad px-8 text-base font-bold text-white shadow-cta transition-all hover:text-[#ffa94d] hover:shadow-cta-hover"
            >
              <IconBolt size={16} strokeWidth={2.2} />
              {copy.hero.ctaPrimary}
            </Link>
            <Link
              href="/login"
              className="inline-flex h-[54px] items-center justify-center rounded-btn-xl border border-control px-8 text-base font-semibold text-bright transition-colors hover:border-muted"
            >
              {copy.hero.ctaSecondary}
            </Link>
          </div>
          <div className="mt-4 text-[13px] text-secondary">{copy.hero.note}</div>
        </section>

        <StatsRow copy={copy} />
        <FeaturesSection copy={copy.features} signupHref="/signup" />
        <ModesSection copy={copy} />
        <FaqSection copy={copy} />

        {/* CTA cuối trang */}
        <section className="mx-auto box-content max-w-[760px] px-6 pb-20 text-center">
          <div className="rounded-btn-lg border border-accent/40 bg-label/10 px-8 py-10">
            <h2 className="text-[26px] font-extrabold uppercase tracking-[-.01em] text-primary">
              {copy.ctaBlock.title}<span className="text-accent">.</span>
            </h2>
            <p className="mx-auto mt-3 max-w-[460px] text-[14px] leading-[1.7] text-secondary">
              {copy.ctaBlock.sub}
            </p>
            <Link
              href="/signup"
              className="mt-6 inline-flex h-[50px] items-center justify-center gap-[10px] rounded-btn-xl bg-accent-grad px-8 text-[15px] font-bold text-white shadow-cta transition-all hover:text-[#ffa94d] hover:shadow-cta-hover"
            >
              <IconBolt size={15} strokeWidth={2.2} />
              {copy.ctaBlock.button}
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-divider px-6 py-6 text-center text-[11.5px] leading-[1.8] tracking-[.04em] text-faint">
        {copy.footer.line1}
        <br />
        {copy.footer.line2}
      </footer>
    </div>
  );
}
