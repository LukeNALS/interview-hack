import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedUser } from "../helpers/seed";
import { readToasts, recordToasts } from "../mocks/e2e-support";

/**
 * Admin phase 01 (plan 20260904-1150): user thường vào /admin → 404 fail-closed;
 * admin (email cố định trong ADMIN_EMAILS của playwright.config) sửa quota →
 * DB free_sessions_left đổi thật qua PATCH /api/admin/users/:id service-role.
 */

test.setTimeout(90_000);

/** Phải khớp ADMIN_EMAILS trong playwright.config.ts (env tĩnh lúc server start). */
const ADMIN_FIXED_EMAIL = "e2e-admin-fixed@example.com";

let admin: SupabaseClient;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
  // Run trước có thể crash giữa chừng để lại user email cố định → dọn trước khi seed lại.
  const { data: stale } = await admin.from("profiles").select("id").eq("email", ADMIN_FIXED_EMAIL);
  if (stale?.length) await deleteTestUsers(admin, stale.map((r) => r.id as string));
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_regular_user_opening_admin_page_gets_404", async ({ page }) => {
  // Arrange — user thường (email random, ngoài allowlist).
  const user = await seedUser(admin, "notadmin", { freeSessionsLeft: 3 });
  createdUsers.push(user.userId);
  await loginAs(page, user.email);

  // Assert — /candidate không có nút Admin (badge FREE đã render = /api/me đã về, không phải đang chờ).
  await expect(page.getByText(/CÒN \d+ BUỔI FREE/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);

  // Act
  const response = await page.goto("/admin");

  // Assert — 404 fail-closed, không lộ sự tồn tại trang.
  expect(response?.status()).toBe(404);
});

test("test_admin_edits_user_quota_and_db_reflects_new_value", async ({ page }) => {
  // Arrange — admin theo email cố định + 1 user mục tiêu để sửa quota.
  const adminUser = await seedUser(admin, "adminfixed", { freeSessionsLeft: 3, email: ADMIN_FIXED_EMAIL });
  createdUsers.push(adminUser.userId);
  const target = await seedUser(admin, "quotatarget", { freeSessionsLeft: 0 });
  createdUsers.push(target.userId);
  await recordToasts(page);
  await loginAs(page, ADMIN_FIXED_EMAIL);

  // Act — vào admin qua NÚT ở header /candidate (chỉ hiện khi is_admin), redirect /admin/users,
  // rồi sửa quota của user mục tiêu thành 7.
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/, { timeout: 15_000 });
  const targetRow = page.locator("tr", { hasText: target.email });
  await expect(targetRow).toBeVisible({ timeout: 15_000 });
  await targetRow.getByRole("button", { name: "Sửa" }).click();
  await targetRow.getByLabel(`Buổi free còn của ${target.email}`).fill("7");
  await targetRow.getByRole("button", { name: "Lưu" }).click();

  // Assert — toast + giá trị mới hiển thị + DB đổi thật.
  await expect.poll(() => readToasts(page), { timeout: 15_000 }).toContain("Đã lưu");
  await expect
    .poll(
      async () =>
        (await admin.from("profiles").select("free_sessions_left").eq("id", target.userId).maybeSingle()).data
          ?.free_sessions_left,
      { timeout: 15_000, message: "chờ quota mới ghi vào DB" },
    )
    .toBe(7);
  await expect(targetRow.getByText("7", { exact: true })).toBeVisible();
});
