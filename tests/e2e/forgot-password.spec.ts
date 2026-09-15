import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2eAdminClient, deleteTestUsers, seedUser, TEST_PASSWORD, uniqueEmail } from "../helpers/seed";
import { extractConfirmLink, waitForMailTo } from "../helpers/mailpit";

/**
 * E2E quên mật khẩu — đi qua MAIL THẬT của Mailpit (local Supabase stack), KHÔNG mock
 * (test-standards: external phải qua mail thật cho spec này). 3 ca: đổi mật khẩu
 * thành công qua link trong mail, token sai -> lỗi ở /login, email không tồn tại vẫn
 * thấy thông báo trung tính (chống dò tài khoản).
 */

let admin: SupabaseClient;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_forgot_password_full_flow_changes_password_via_real_mail", async ({ page }) => {
  // Arrange — user có mật khẩu cũ (TEST_PASSWORD, seed qua admin API)
  const user = await seedUser(admin, "forgot-pw");
  createdUsers.push(user.userId);
  const newPassword = "NewPass456!cD";

  // Act — bấm "Quên mật khẩu?" từ /login, gửi yêu cầu đặt lại
  await page.goto("/login");
  await page.getByRole("link", { name: "Quên mật khẩu?" }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await page.locator("#email").fill(user.email);
  await page.getByRole("button", { name: "Gửi đường dẫn đặt lại" }).click();
  await expect(page.getByText(/Nếu email này có tài khoản/)).toBeVisible();

  // Đọc mail THẬT từ Mailpit, mở link recovery (token-hash flow — mở được ở tab này dù
  // resetPasswordForEmail() gọi từ tab khác/cùng tab đều được, không phụ thuộc PKCE verifier).
  const mail = await waitForMailTo(user.email);
  const link = extractConfirmLink(mail, "recovery");
  await page.goto(link);
  await expect(page).toHaveURL(/\/reset-password/);

  // Đặt mật khẩu mới
  await page.locator("#password").fill(newPassword);
  await page.locator("#password-confirm").fill(newPassword);
  await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
  await expect(page).toHaveURL(/\/candidate$/);

  // Đăng xuất rồi xác nhận: mật khẩu CŨ bị từ chối, mật khẩu MỚI đăng nhập được
  await page.getByRole("button", { name: "ĐĂNG XUẤT" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByText(/invalid/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.locator("#password").fill(newPassword);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(/\/candidate$/);
});

test("test_forgot_password_invalid_token_hash_shows_error_on_login", async ({ page }) => {
  // Act — token_hash không tồn tại/sai
  await page.goto("/auth/confirm?token_hash=obviously-invalid-token&type=recovery");

  // Assert
  await expect(page).toHaveURL(/\/login\?error=link_invalid/);
  await expect(page.getByText("Đường dẫn không hợp lệ hoặc đã hết hạn. Hãy yêu cầu lại.")).toBeVisible();
});

test("test_forgot_password_unknown_email_still_shows_neutral_message", async ({ page }) => {
  // Act — email chưa từng đăng ký tài khoản nào
  await page.goto("/forgot-password");
  await page.locator("#email").fill(uniqueEmail("forgot-pw-unknown"));
  await page.getByRole("button", { name: "Gửi đường dẫn đặt lại" }).click();

  // Assert — KHÔNG được lộ khác biệt với case email có tài khoản thật
  await expect(page.getByText(/Nếu email này có tài khoản/)).toBeVisible();
});
