import type { SVGProps } from "react";

/**
 * Icon inline SVG — path copy TRỰC TIẾP từ `init docs/Interview Copilot App v2.dc.html`
 * (stroke 1.6–2.6, round cap/join). KHÔNG dùng icon lib để giữ pixel-perfect.
 * Màu: mặc định `currentColor`, override qua prop `stroke`.
 */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, strokeWidth = 1.8, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Logo tia sét. */
export const IconBolt = (p: IconProps) => (
  <Svg size={14} strokeWidth={2.4} {...p}>
    <path d="M13 2 5 13h6l-1 9 8-11h-6z" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg size={20} strokeWidth={1.8} {...p}>
    <path d="M12 16V5" />
    <path d="M7.5 9.5 12 5l4.5 4.5" />
    <path d="M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg size={17} strokeWidth={1.6} {...p}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg size={13} strokeWidth={2.6} {...p}>
    <path d="M5 12.5 10 17.5 19 7" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg size={16} strokeWidth={1.6} strokeLinejoin="miter" {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6.5 7l1 13h9l1-13" />
  </Svg>
);

export const IconMic = (p: IconProps) => (
  <Svg size={20} strokeWidth={1.7} {...p}>
    <rect x="9" y="4" width="6" height="10" rx="3" />
    <path d="M6 12a6 6 0 0 0 12 0" />
    <path d="M12 18v3" />
  </Svg>
);

export const IconMonitor = (p: IconProps) => (
  <Svg size={22} strokeWidth={1.7} {...p}>
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <path d="M9 20h6" />
    <path d="M12 17v3" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg size={22} strokeWidth={1.7} {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg size={13} strokeWidth={2.2} {...p}>
    <path d="M19 12H5" />
    <path d="m11 18-6-6 6-6" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg size={15} strokeWidth={2.2} {...p}>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </Svg>
);

export const IconArrowDown = (p: IconProps) => (
  <Svg size={12} strokeWidth={2.2} {...p}>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg size={12} strokeWidth={2.2} {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg size={14} strokeWidth={2.2} {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg size={14} strokeWidth={1.7} {...p}>
    <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
  </Svg>
);

/** Icon link chia sẻ (nút "Sao chép link chia sẻ"). */
export const IconLink = (p: IconProps) => (
  <Svg size={14} strokeWidth={1.8} {...p}>
    <path d="M9 15 15 9" />
    <path d="M10.5 6.5 12 5a4 4 0 0 1 5.7 5.7L16 12.2" />
    <path d="M13.5 17.5 12 19a4 4 0 0 1-5.7-5.7L8 11.8" />
  </Svg>
);

/** Handle kéo 6 chấm (fill, không stroke — viewBox riêng 10×16). */
export const IconDragHandle = (p: SVGProps<SVGSVGElement>) => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" {...p}>
    <circle cx="2.5" cy="2.5" r="1.5" />
    <circle cx="7.5" cy="2.5" r="1.5" />
    <circle cx="2.5" cy="8" r="1.5" />
    <circle cx="7.5" cy="8" r="1.5" />
    <circle cx="2.5" cy="13.5" r="1.5" />
    <circle cx="7.5" cy="13.5" r="1.5" />
  </svg>
);
