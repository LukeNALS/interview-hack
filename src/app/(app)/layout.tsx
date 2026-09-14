import type { ReactNode } from "react";
import { Providers } from "./providers";

/**
 * Layout nhóm màn app (candidate · setup · live).
 * Nền glow tím nằm ở body (globals.css); KHÔNG render header ở đây —
 * mỗi màn tự render header của mình (candidate/setup 60px, live 62px…).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <div className="flex min-h-dvh flex-col">{children}</div>
    </Providers>
  );
}
