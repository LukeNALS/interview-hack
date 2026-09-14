import { defineConfig } from "vitest/config";
import path from "node:path";
import { config as loadEnv } from "dotenv";

// Config riêng cho test đối đầu HỆ THỐNG THẬT ngoài máy — KHÔNG chạy trong
// `pnpm test`/CI mặc định (xem exclude trong vitest.config.ts). Chạy thủ công
// qua `pnpm test:real`. Mọi suite ở đây tự `describe.skip` khi thiếu key nên
// lệnh vẫn xanh trên máy chưa cấu hình.
//
//  - cv-vision-real: gọi Claude API thật, tốn phí. Cần ANTHROPIC_API_KEY.
//  - quota-race, rls: tạo user + session THẬT qua Supabase admin API trên đích
//    NEXT_PUBLIC_SUPABASE_URL (hiện trỏ project production), dọn ở afterAll.
//    ⚠️ Chạy lệnh này là ghi vào project thật — cân nhắc trỏ env sang local
//    stack trước khi chạy. Chúng canh nợ N1 (lệch GRANT prod↔local) nên KHÔNG
//    được bỏ hẳn, chỉ chuyển sang cổng chạy có chủ đích.
loadEnv({ path: path.resolve(__dirname, ".env.local") });

export default defineConfig({
  test: {
    include: [
      "tests/integration/cv-vision-real.test.ts",
      "tests/integration/quota-race.test.ts",
      "tests/integration/rls.test.ts",
    ],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
