"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/use-session";
import { assertScreenAllowed, redirectPath } from "@/lib/state-machine";
import type { Screen } from "@/types/ui";

/**
 * Guard client-side cho page `/sessions/[id]/<screen>` (chỉ còn setup/live) —
 * đọc status thật qua `useSession` rồi `assertScreenAllowed`; sai → redirect
 * đúng nơi (`redirectPath`: màn khác trong buổi, hoặc `/candidate` nếu buổi
 * đã kết thúc — xem state-machine.ts).
 */
export function SessionScreenGuard({
  sessionId,
  screen,
  children,
}: {
  sessionId: string;
  screen: Screen;
  children: ReactNode;
}) {
  const router = useRouter();
  const { data: session } = useSession(sessionId);

  useEffect(() => {
    if (!session) return;
    try {
      assertScreenAllowed(session.status, screen);
    } catch {
      router.replace(redirectPath(sessionId, session.status));
    }
  }, [session, screen, sessionId, router]);

  return <>{children}</>;
}
