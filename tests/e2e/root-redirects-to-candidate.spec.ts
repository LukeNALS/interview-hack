import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedUser } from "../helpers/seed";

/**
 * `/` với user ĐÃ đăng nhập phải đưa thẳng vào app (URL gõ theo phản xạ; trước đây
 * từng trả boilerplate create-next-app lạc bảng màu). Khách CHƯA đăng nhập giờ thấy
 * landing page thay vì bị đá về /login (đổi chủ đích 2026-09-05, plan
 * 20260905-0630-landing-page) — case đó test ở `landing.spec.ts`.
 */

let admin: SupabaseClient;
let email: string;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
  const user = await seedUser(admin, "root-redirect");
  createdUsers.push(user.userId);
  email = user.email;
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_root_path_logged_in_lands_on_candidate", async ({ page }) => {
  // Arrange
  await loginAs(page, email);

  // Act — gõ thẳng "/" như người dùng gõ localhost:3001
  await page.goto("/");

  // Assert — vào màn bắt đầu buổi phỏng vấn, KHÔNG còn dấu vết trang starter
  await expect(page).toHaveURL(/\/candidate$/);
  await expect(page.getByText("To get started")).toHaveCount(0);
});

test("test_root_path_logged_out_stays_on_landing_page", async ({ page }) => {
  // Act — khách chưa đăng nhập gõ thẳng "/".
  await page.goto("/");

  // Assert — Ở LẠI landing (không còn đá về /login); nội dung landing test kỹ ở landing.spec.ts.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Dùng thử miễn phí" }).first()).toBeVisible();
});
