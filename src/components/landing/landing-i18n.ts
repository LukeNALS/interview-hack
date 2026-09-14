"use client";

import { useEffect, useState } from "react";
import { LANDING_COPY_VI } from "./landing-copy-vi";
import { LANDING_COPY_EN } from "./landing-copy-en";
import { LANDING_COPY_JA } from "./landing-copy-ja";

/**
 * i18n landing page (góp ý Luke 2026-09-05): 3 ngôn ngữ VI/EN/JA, switcher chữ
 * (không icon) ở header, persist localStorage. Mặc định VI — SSR render VI nên
 * SEO/e2e anchor tiếng Việt giữ nguyên; đổi ngôn ngữ chỉ xảy ra sau hydrate.
 */

export type LandingLang = "vi" | "en" | "ja";

/** Section tính năng: kicker + heading + 3 feature + dòng flow + CTA riêng. */
export interface FeatureSectionCopy {
  kicker: string;
  heading: string;
  sub: string;
  features: { title: string; body: string }[];
  /** Các chặng của flow, render thành chips nối mũi tên. */
  flow: string[];
  cta: string;
}

export interface LandingCopy {
  nav: { login: string; signup: string };
  hero: {
    badge: string;
    titleTop: string;
    titleBottom: string;
    sub: string;
    ctaPrimary: string;
    ctaSecondary: string;
    note: string;
  };
  stats: { value: string; label: string }[];
  /** Interview Hack chỉ dành cho ứng viên — 1 section tính năng duy nhất. */
  features: FeatureSectionCopy;
  modes: { heading: string; cards: { name: string; body: string }[] };
  faq: { heading: string; items: { q: string; a: string }[] };
  ctaBlock: { title: string; sub: string; button: string };
  footer: { line1: string; line2: string };
}

export const LANDING_COPY: Record<LandingLang, LandingCopy> = {
  vi: LANDING_COPY_VI,
  en: LANDING_COPY_EN,
  ja: LANDING_COPY_JA,
};

/** Nhãn nút switcher — chữ thuần, không icon (yêu cầu Luke). */
export const LANDING_LANG_LABELS: Record<LandingLang, string> = {
  vi: "VI",
  en: "EN",
  ja: "日本語",
};

const STORAGE_KEY = "interview-hack:landing-lang";

function isLandingLang(value: string | null): value is LandingLang {
  return value === "vi" || value === "en" || value === "ja";
}

/** State ngôn ngữ landing: khởi tạo "vi" (khớp SSR), sau hydrate đọc lại lựa chọn đã lưu. */
export function useLandingLang(): [LandingLang, (lang: LandingLang) => void] {
  const [lang, setLang] = useState<LandingLang>("vi");

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage không khả dụng (private mode) — giữ VI.
    }
    if (!isLandingLang(saved) || saved === "vi") return;
    // setState qua timeout 0 thay vì sync trong effect: né cascading render
    // (react-compiler lint) và né hydration mismatch (SSR luôn render VI).
    const id = window.setTimeout(() => setLang(saved), 0);
    return () => window.clearTimeout(id);
  }, []);

  const pick = (next: LandingLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Không lưu được thì thôi — lựa chọn vẫn sống trong phiên.
    }
  };

  return [lang, pick];
}
