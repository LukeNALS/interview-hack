import type { SetupStep } from "@/types/ui";

/** Stepper nhỏ đầu màn setup: "1 CHẾ ĐỘ — ÂM THANH" | "CHẾ ĐỘ ✓ — 2 ÂM THANH". */
export function SetupStepper({ step }: { step: SetupStep }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-bold tracking-[.14em] text-muted">
      {step === "mode" ? (
        <>
          <span className="grid size-[19px] place-items-center rounded-chip bg-accent-grad text-[10.5px] text-white">
            1
          </span>
          <span className="text-accent-hover">CHẾ ĐỘ</span>
          <span className="h-0.5 w-7 rounded-[2px] bg-control" />
          <span className="text-strong">ÂM THANH</span>
        </>
      ) : (
        <>
          <span className="text-success">CHẾ ĐỘ ✓</span>
          <span className="h-0.5 w-7 rounded-[2px] bg-control" />
          <span className="grid size-[19px] place-items-center rounded-chip bg-accent-grad text-[10.5px] text-white">
            2
          </span>
          <span className="text-accent-hover">ÂM THANH</span>
        </>
      )}
    </div>
  );
}
