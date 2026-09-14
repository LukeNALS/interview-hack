"use client";

import type { TransLang } from "@/types/ui";

const LANG_OPTIONS: readonly { value: TransLang; label: string }[] = [
  { value: "vi", label: "Tiếng Việt" },
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

interface LangSelectProps {
  value: TransLang;
  onChange: (value: TransLang) => void;
  title?: string;
}

/** Dropdown ngôn ngữ bản dịch (vi/ja/en). */
export function LangSelect({
  value,
  onChange,
  title = "Ngôn ngữ bản dịch",
}: LangSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as TransLang)}
      title={title}
      className="cursor-pointer rounded-btn border border-control bg-panel px-[10px] py-2 text-[13px] font-semibold text-accent-hover"
    >
      {LANG_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
