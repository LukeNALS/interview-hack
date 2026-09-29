import { expect, type Page } from "@playwright/test";
import { TEST_PASSWORD } from "./seed";

/**
 * Đăng nhập qua UI thật (GoTrue local) — KHÔNG tự chế cookie: `@supabase/ssr` v0.7
 * lưu session dạng cookie chunk `sb-<ref>-auth-token.N`, tự dựng lại là hardcode
 * định dạng nội bộ của thư viện, vỡ ngay khi bump version. Đi qua form vừa đúng
 * luồng thật vừa bền.
 */
export async function loginAs(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  // Đăng nhập xong app điều hướng về màn bắt đầu của ứng viên.
  await expect(page).toHaveURL(/\/candidate$/);
}

/**
 * Chặn route cấp key Soniox. Route thật (`/api/sessions/[id]/soniox-key`) gọi
 * `https://api.soniox.com/v1/auth/temporary-api-key` bằng URL HARDCODE phía server
 * (route.ts) nên không override được bằng env — chỉ chặn được ở tầng browser.
 * Trả CẶP key giả DUY NHẤT mỗi lần gọi (như route thật: 2 key single-use): mock WS server
 * từ chối key đã dùng bằng 401 như Soniox thật, nên key cố định sẽ chết ở lần mở thứ hai.
 */
export async function stubSonioxKey(page: Page): Promise<void> {
  let calls = 0;
  await page.route("**/api/sessions/*/soniox-key", async (route) => {
    calls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        keys: [`e2e-fake-temp-key-${calls}-canonical`, `e2e-fake-temp-key-${calls}-en`],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
}
