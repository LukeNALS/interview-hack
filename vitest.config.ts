import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { config as loadEnv } from "dotenv";

// Nạp .env.local cho integration test (RLS test cần Supabase URL + service-role key).
loadEnv({ path: path.resolve(__dirname, ".env.local") });

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // 3 file dưới đối đầu HỆ THỐNG THẬT ngoài máy nên KHÔNG chạy trong `pnpm test`
    // mặc định — chạy thủ công qua `pnpm test:real` (xem vitest.real.config.ts):
    //  - cv-vision-real: gọi Claude API thật (tốn phí, không deterministic).
    //  - quota-race + rls: tạo user/session THẬT qua admin API trên đích mà
    //    NEXT_PUBLIC_SUPABASE_URL trỏ tới — hiện là project production. Đây cũng là
    //    nguồn đỏ giả: chạy chung suite làm lệch đồng hồ ↔ server, GoTrue trả
    //    "JWT issued at future" (gặp thật 2026-08-19). `test:db` đã có gate cứng chỉ
    //    cho localhost; 2 file này là đường vòng qua gate đó, nên phải tách ra.
    exclude: [
      "poc/**",
      "node_modules/**",
      "**/*.spec.ts",
      "tests/integration/cv-vision-real.test.ts",
      "tests/integration/quota-race.test.ts",
      "tests/integration/rls.test.ts",
    ],
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
