"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * TanStack Query provider cho nhóm màn app (prep · setup · live · wait ·
 * report). 1 QueryClient/tab — `useState(() => new QueryClient())` tránh
 * tạo lại client mỗi render (P04 nối API thật, thay mock).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // API tự viết, không cần retry ngầm — lỗi hiện rõ cho UI xử lý.
            retry: false,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
