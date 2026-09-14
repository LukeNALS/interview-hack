"use client";

import { useSessionStore } from "@/stores/session-store";
import type { LiveTab } from "@/types/ui";

const PILL_BASE =
  "cursor-pointer rounded-pill border px-3.5 py-1.5 text-[13px] font-semibold";
const PILL_ACTIVE = "border-transparent bg-accent-grad text-white";
const PILL_IDLE = "border-control bg-panel text-muted";

/** Thanh tab pill khi <1100px: Transcript · Gợi ý (+ badge đếm đỏ). */
export function LiveTabsBar() {
  const liveTab = useSessionStore((s) => s.liveTab);
  const suggCount = useSessionStore((s) => s.suggs.length);
  const patch = useSessionStore((s) => s.patch);

  const pillClass = (tab: LiveTab) =>
    `${PILL_BASE} ${liveTab === tab ? PILL_ACTIVE : PILL_IDLE}`;
  const select = (tab: LiveTab) => patch({ liveTab: tab });

  return (
    <div className="flex flex-none gap-1.5 border-b border-divider bg-app/85 px-4 py-2.5">
      <button
        type="button"
        onClick={() => select("transcript")}
        className={pillClass("transcript")}
      >
        Transcript
      </button>
      <button
        type="button"
        onClick={() => select("suggest")}
        className={`inline-flex items-center gap-1.5 ${pillClass("suggest")}`}
      >
        Gợi ý
        {suggCount > 0 && (
          <span className="grid size-4 place-items-center rounded-full bg-danger text-[10px] font-bold text-white">
            {suggCount}
          </span>
        )}
      </button>
    </div>
  );
}
