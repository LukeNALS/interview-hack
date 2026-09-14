"use client";

import { LangSelect } from "@/components/common/lang-select";
import { SegmentedToggle } from "@/components/common/segmented-toggle";
import { useSessionStore } from "@/stores/session-store";
import { formatElapsed } from "./live-utils";

/** Segmented "Bản gốc / Bản dịch" — map sang cờ viewOrig trong store. */
const VIEW_OPTIONS = [
  { value: "orig", label: "Bản gốc" },
  { value: "trans", label: "Bản dịch" },
] as const;

type ViewValue = (typeof VIEW_OPTIONS)[number]["value"];

interface LiveHeaderProps {
  /** <1100px — ẩn chức danh (design: chỉ hiện khi isWide). */
  narrow: boolean;
}

/** Header 62px màn live: tên + chức danh, badge REC pulse, timer, toggle bản gốc/dịch + ngôn ngữ (giữa), nút Kết thúc (phải). */
export function LiveHeader({ narrow }: LiveHeaderProps) {
  const elapsed = useSessionStore((s) => s.elapsed);
  const viewOrig = useSessionStore((s) => s.viewOrig);
  const transLang = useSessionStore((s) => s.transLang);
  const patch = useSessionStore((s) => s.patch);
  const candidateName = useSessionStore((s) => s.candidateName);
  const position = useSessionStore((s) => s.position);

  return (
    <div className="relative z-5 flex h-[62px] flex-none items-center border-b border-divider bg-app/85 px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="whitespace-nowrap text-[15.5px] font-bold text-primary">
          {candidateName}
        </span>
        {!narrow && (
          <span className="whitespace-nowrap text-[12.5px] text-muted">
            {position}
          </span>
        )}
        <span aria-hidden className="h-[18px] w-px flex-none bg-control" />
        <span className="inline-flex items-center gap-[7px] rounded-pill border border-danger/35 bg-danger/10 px-3 py-[5px]">
          <span className="inline-block size-[9px] flex-none animate-rec-pulse rounded-full bg-danger motion-reduce:animate-none" />
          <span className="whitespace-nowrap text-[10.5px] font-bold tracking-[.08em] text-danger-hover">
            REC
          </span>
        </span>
        <span className="text-[13px] text-accent-hover tabular-nums">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
        <SegmentedToggle<ViewValue>
          options={VIEW_OPTIONS}
          value={viewOrig ? "orig" : "trans"}
          onChange={(v) => patch({ viewOrig: v === "orig" })}
        />
        <LangSelect
          value={transLang}
          onChange={(v) => patch({ transLang: v })}
          title="Ngôn ngữ bản dịch"
        />
      </div>
      <button
        type="button"
        onClick={() => patch({ confirmEnd: true })}
        className="ml-auto inline-flex h-[38px] cursor-pointer items-center justify-center rounded-btn bg-danger-grad px-6 text-[14px] font-bold text-white shadow-danger hover:shadow-danger-hover"
      >
        Kết thúc
      </button>
    </div>
  );
}
