"use client";

import { useSessionStore } from "@/stores/session-store";

interface LiveSuggestionColumnProps {
  narrow: boolean;
}

const LABEL_CLASS = "text-[10.5px] font-bold tracking-[.14em] text-faint";

/** Cột phải 290px: card "TRẢ LỜI GỢI Ý" (tối đa 2) + timeline "NHẬN ĐỊNH CHUNG". */
export function LiveSuggestionColumn({ narrow }: LiveSuggestionColumnProps) {
  const suggs = useSessionStore((s) => s.suggs);
  const insights = useSessionStore((s) => s.insights);
  const removeSuggestion = useSessionStore((s) => s.removeSuggestion);

  return (
    <div
      className={`flex min-h-0 flex-none flex-col gap-2.5 overflow-y-auto border-l border-divider bg-panel-deep px-3.5 pt-3.5 pb-[18px] ${
        narrow ? "w-full" : "box-content w-[290px]"
      }`}
    >
      <div className={LABEL_CLASS}>TRẢ LỜI GỢI Ý</div>
      {suggs.length === 0 && (
        <div className="px-0.5 py-2 text-[13px] leading-[1.6] text-faint">
          Khi người phỏng vấn đặt câu hỏi, gợi ý trả lời sẽ hiện ở đây.
        </div>
      )}
      {suggs.map((sugg) => (
        <div
          key={sugg.id}
          className="flex flex-col gap-2.5 rounded-btn-lg border border-label/35 bg-panel-grad-soft px-3.5 py-[13px]"
        >
          <span className="text-[13.5px] leading-[1.55] text-bright">
            {sugg.text}
          </span>
          <span className="flex gap-3.5">
            <button
              type="button"
              onClick={() => removeSuggestion(sugg.id)}
              className="cursor-pointer text-[12.5px] font-semibold text-faint hover:text-secondary"
            >
              Bỏ qua
            </button>
          </span>
        </div>
      ))}
      {insights.length > 0 && (
        <>
          <div className="my-1.5 h-px flex-none bg-divider" />
          <div className={LABEL_CLASS}>NHẬN ĐỊNH CHUNG</div>
          {insights.map((insight) => (
            <div
              key={`${insight.time}-${insight.text}`}
              className="text-[13px] leading-[1.6] text-secondary"
            >
              <span className="text-[11px] font-semibold text-accent-hover">
                {insight.time}
              </span>{" "}
              · {insight.text}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
