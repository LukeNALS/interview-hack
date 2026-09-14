import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORTS, readLocalSupabase } from "./tests/helpers/local-supabase";

/**
 * E2E P07 — chạy đối đầu LOCAL Supabase stack + mock Soniox/Claude.
 * KHÔNG test nào chạm Soniox/Claude thật (test-standards: mock external).
 *
 * Key local đọc runtime từ `supabase status` (xem `tests/helpers/local-supabase.ts`),
 * không hardcode. Env truyền thẳng vào process `next dev` — Next KHÔNG ghi đè biến
 * đã có sẵn trong `process.env`, nên các giá trị dưới đây thắng `.env.local`
 * (vốn trỏ project THẬT) → E2E không bao giờ chạm production.
 */

const supabase = readLocalSupabase();

const nextEnv: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: supabase.url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabase.anonKey,
  SUPABASE_SERVICE_ROLE_KEY: supabase.serviceKey,
  // Trỏ SDK sang mock — 2 biến optional thêm ở P07 (src/lib/env.ts).
  NEXT_PUBLIC_SONIOX_WS_URL: `ws://127.0.0.1:${E2E_PORTS.sonioxMock}`,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${E2E_PORTS.claudeMock}`,
  // serverEnv fail-fast đòi 2 key này tồn tại; giá trị giả vì mọi lời gọi đi vào mock.
  SONIOX_API_KEY: "e2e-fake-soniox-key",
  ANTHROPIC_API_KEY: "e2e-fake-anthropic-key",
  // Admin phase 01 — email cố định cho e2e admin (spec seed đúng email này;
  // user thường seed email random nên KHÔNG lọt allowlist).
  ADMIN_EMAILS: "e2e-admin-fixed@example.com",
};

export default defineConfig({
  testDir: "./tests/e2e",
  // Mỗi spec seed user/session riêng nên song song an toàn; workers giới hạn để
  // `next dev` (1 process) không thành nút cổ chai gây timeout giả.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    video: "off",
    // Fake mic để getUserMedia không hiện prompt và luôn trả stream (mode direct).
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // Dưới breakpoint 1100 → live phải đổi sang tab bar. Chỉ spec responsive
      // chạy lại ở viewport này (các spec khác không phụ thuộc bề ngang).
      name: "narrow-1024",
      testMatch: /responsive-1100\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 800 } },
    },
  ],
  webServer: [
    {
      command: `node tests/mocks/run-mock.mjs soniox-ws-server --port ${E2E_PORTS.sonioxMock}`,
      url: `http://127.0.0.1:${E2E_PORTS.sonioxMock}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `node tests/mocks/run-mock.mjs claude-server --port ${E2E_PORTS.claudeMock}`,
      url: `http://127.0.0.1:${E2E_PORTS.claudeMock}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `pnpm exec next dev --port ${E2E_PORTS.next}`,
      url: E2E_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: nextEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
