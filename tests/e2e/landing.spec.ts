import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedUser } from "../helpers/seed";

/**
 * Landing page `/` (Interview Hack chỉ dành cho ứng viên): khách lạ thấy trang
 * giới thiệu + CTA đúng đích; user đã đăng nhập mở `/` về /candidate.
 */

test.setTimeout(60_000);

let admin: SupabaseClient;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_anonymous_visitor_sees_landing_with_signup_and_login_ctas", async ({ page }) => {
  // Act — khách lạ mở thẳng root.
  const response = await page.goto("/");

  // Assert — 200 (không redirect sang /login), đủ hero + CTA đúng href.
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Đi phỏng vấn/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dùng thử miễn phí" }).first()).toHaveAttribute("href", "/signup");
  await expect(page.getByRole("link", { name: "Đăng nhập" }).first()).toHaveAttribute("href", "/login");
  // Interview Hack chỉ 1 section tính năng (không còn tách 2 vai người phỏng vấn/ứng viên).
  await expect(page.getByText("CÁCH INTERVIEW HACK GIÚP BẠN")).toBeVisible();
});

test("test_landing_language_switcher_changes_copy_and_persists", async ({ page }) => {
  // Arrange — khách lạ mở landing (mặc định VI).
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Đi phỏng vấn/i })).toBeVisible();

  // Act — bấm switcher chữ "EN".
  await page.getByRole("button", { name: "EN", exact: true }).click();

  // Assert — hero + CTA đổi sang tiếng Anh, CTA vẫn trỏ đúng đích.
  await expect(page.getByRole("heading", { name: /Walk into interviews/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try it free" }).first()).toHaveAttribute("href", "/signup");

  // Act — sang 日本語 rồi reload: lựa chọn phải sống qua localStorage.
  await page.getByRole("button", { name: "日本語", exact: true }).click();
  await expect(page.getByRole("heading", { name: /自信を持って/ })).toBeVisible();
  await page.reload();

  // Assert — sau reload vẫn tiếng Nhật.
  await expect(page.getByRole("heading", { name: /自信を持って/ })).toBeVisible({ timeout: 15_000 });
});

test("test_logged_in_user_opening_root_is_redirected_to_candidate", async ({ page }) => {
  // Arrange
  const user = await seedUser(admin, "landing", { freeSessionsLeft: 3 });
  createdUsers.push(user.userId);
  await loginAs(page, user.email);

  // Act — user đã đăng nhập mở `/`.
  await page.goto("/");

  // Assert — về /candidate, không thấy landing.
  await expect(page).toHaveURL(/\/candidate$/, { timeout: 15_000 });
});
