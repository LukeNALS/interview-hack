import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Render bọc QueryClientProvider — mọi component dùng hook TanStack Query
 * (P04: use-session/use-questions/use-cv-upload/use-generate-questions)
 * throw nếu render trực tiếp không có provider trong cây.
 * `retry: false` để test lỗi mạng không phải chờ retry ngầm.
 */
export function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return { ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>), queryClient };
}
