"use client";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedToggleProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Segmented pill (vd "Bản gốc / Bản dịch") — active = gradient tím. */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: SegmentedToggleProps<T>) {
  return (
    <div className="flex items-center gap-[2px] rounded-pill border border-control bg-panel p-[3px]">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`cursor-pointer rounded-pill px-5 py-2 text-[14px] font-semibold ${
              active ? "bg-accent-grad text-white" : "bg-transparent text-muted"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
