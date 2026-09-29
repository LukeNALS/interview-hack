import { expect, type Page } from "@playwright/test";
import { stubSonioxKeyWithScenario } from "../mocks/e2e-support";
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
 * Chặn route cấp key Soniox (kịch bản `basic`). Route thật (`/api/sessions/[id]/soniox-key`) gọi
 * `https://api.soniox.com/v1/auth/temporary-api-key` bằng URL HARDCODE phía server nên không override
 * được bằng env — chỉ chặn được ở tầng browser. Uỷ quyền cho `stubSonioxKeyWithScenario`: mỗi lần gọi
 * trả CẶP key giả DUY NHẤT gắn runId ngẫu nhiên (như route thật: 2 key single-use). Mock WS server từ chối
 * key đã dùng bằng 401 như Soniox thật, nên key trùng giữa các stub/spec chạy song song sẽ bị 401 giả.
 */
export async function stubSonioxKey(page: Page): Promise<void> {
  await stubSonioxKeyWithScenario(page, "basic");
}
