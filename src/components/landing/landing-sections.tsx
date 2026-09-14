import type { ReactNode } from "react";
import Link from "next/link";
import { IconBolt, IconCheck, IconFile, IconMic, IconMonitor, IconUser } from "@/components/common/icons";
import type { FeatureSectionCopy, LandingCopy } from "./landing-i18n";
import { LandingPreview } from "./landing-hero-preview";

/**
 * Các section landing — text từ `copy` (i18n VI/EN/JA). Interview Hack chỉ dành
 * cho ứng viên: 1 section tính năng (kicker + heading + 3 feature + flow + CTA).
 */

export function StatsRow({ copy }: { copy: LandingCopy }) {
  return (
    <section className="mx-auto box-content max-w-[980px] px-6 pb-16">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {copy.stats.map((s) => (
          <div key={s.label} className="rounded-btn-lg border border-divider bg-app/60 px-4 py-5 text-center">
            <div className="text-[26px] font-extrabold tracking-[-.01em] text-primary">
              {s.value}<span className="text-accent">.</span>
            </div>
            <div className="mt-1 text-[12.5px] leading-[1.5] text-secondary">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-center text-[11px] font-bold tracking-[.22em] text-label">{children}</h2>
  );
}

const FEATURE_ICONS: ReactNode[] = [
  <IconFile key="f" size={16} />,
  <IconCheck key="c" size={16} />,
  <IconMic key="m" size={16} />,
];

/** Section tính năng duy nhất — khối bọc viền accent + nền tím nhạt. */
export function FeaturesSection({
  copy,
  signupHref,
}: {
  copy: FeatureSectionCopy;
  signupHref: string;
}) {
  return (
    <section className="mx-auto box-content max-w-[980px] px-6 pb-16">
      <div className="rounded-btn-lg border border-accent/40 bg-label/10 px-6 py-10 sm:px-10">
        <div className="text-[11px] font-bold tracking-[.22em] text-accent-hover">{copy.kicker}</div>
        <h2 className="mt-3 max-w-[560px] text-[28px] font-extrabold uppercase leading-[1.15] tracking-[-.01em] text-primary sm:text-[34px]">
          {copy.heading}<span className="text-accent">.</span>
        </h2>
        <p className="mt-3 max-w-[600px] text-[15px] leading-[1.7] text-secondary">{copy.sub}</p>

        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          {copy.features.map((f, i) => (
            <div key={f.title} className="rounded-btn-lg border border-divider bg-app/70 px-5 py-5">
              <div className="grid size-[32px] place-items-center rounded-btn bg-accent-grad text-white shadow-logo">
                {FEATURE_ICONS[i]}
              </div>
              <div className="mt-3 text-[14.5px] font-bold text-primary">{f.title}</div>
              <div className="mt-1.5 text-[13.5px] leading-[1.65] text-secondary">{f.body}</div>
            </div>
          ))}
        </div>

        {/* Mock màn live — xem trước sản phẩm thật. */}
        <LandingPreview />

        {/* Dòng flow: chips nối mũi tên — nhìn 3 giây hiểu cả hành trình. */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {copy.flow.map((step, i) => (
            <span key={step} className="inline-flex items-center gap-2">
              <span className="rounded-chip-lg border border-control bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-bright">
                {step}
              </span>
              {i < copy.flow.length - 1 && <span className="text-[13px] text-accent-hover">→</span>}
            </span>
          ))}
        </div>

        <Link
          href={signupHref}
          className="mt-7 inline-flex h-[46px] items-center justify-center gap-2 rounded-btn-xl bg-accent-grad px-6 text-[14px] font-bold text-white shadow-cta transition-all hover:text-[#ffa94d] hover:shadow-cta-hover"
        >
          <IconBolt size={14} strokeWidth={2.2} />
          {copy.cta}
        </Link>
      </div>
    </section>
  );
}

export function ModesSection({ copy }: { copy: LandingCopy }) {
  const modeIcons = [<IconMonitor key="m" size={16} />, <IconUser key="u" size={16} />];
  return (
    <section className="mx-auto box-content max-w-[980px] px-6 pb-16">
      <SectionHeading>{copy.modes.heading}</SectionHeading>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {copy.modes.cards.map((m, i) => (
          <div key={m.name} className="rounded-btn-lg border border-divider px-6 py-6 transition-colors hover:border-accent/50">
            <div className="flex items-center gap-3">
              <span className="grid size-[34px] place-items-center rounded-btn border border-accent/50 text-accent-hover">
                {modeIcons[i]}
              </span>
              <span className="text-[15.5px] font-bold text-primary">{m.name}</span>
            </div>
            <div className="mt-3 text-[14px] leading-[1.7] text-secondary">{m.body}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function FaqSection({ copy }: { copy: LandingCopy }) {
  return (
    <section className="mx-auto box-content max-w-[760px] px-6 pb-20">
      <SectionHeading>{copy.faq.heading}</SectionHeading>
      <div className="mt-6 flex flex-col gap-3">
        {copy.faq.items.map((f) => (
          // <details> native — mở/đóng không cần JS, đúng tinh thần landing tĩnh.
          <details key={f.q} className="group rounded-btn-lg border border-divider bg-app/60 px-5 py-4 open:border-accent/40">
            <summary className="cursor-pointer list-none text-[14.5px] font-semibold text-bright marker:content-none">
              <span className="mr-2 text-accent transition-transform group-open:rotate-90">›</span>
              {f.q}
            </summary>
            <p className="mt-2 pl-5 text-[13.5px] leading-[1.7] text-secondary">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
