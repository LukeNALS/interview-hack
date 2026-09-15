import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2eAdminClient, deleteTestUsers, seedUser, TEST_PASSWORD, uniqueEmail } from "../helpers/seed";
import { extractConfirmLink, waitForMailsTo, waitForMailTo } from "../helpers/mailpit";

/**
 * E2E quên mật khẩu — đi qua MAIL THẬT của Mailpit (local Supabase stack), KHÔNG mock
 * (test-standards: external phải qua mail thật cho spec này). Ca: đổi mật khẩu thành
 * công qua link trong mail, yêu cầu 2 lần (link cũ báo "chỉ email mới nhất", link mới
 * dùng được), nhập lại mật khẩu cũ bị từ chối bằng tiếng Việt, token sai -> lỗi ở /login,
 * email không tồn tại vẫn thấy thông báo trung tính (chống dò tài khoản).
 */

const HOME_URL = /\/candidate$/;
const LINK_INVALID_TEXT =
  "Đường dẫn không hợp lệ hoặc đã được dùng. Nếu bạn đã yêu cầu nhiều lần, chỉ đường dẫn trong email mới nhất còn dùng được.";
const OPEN_LATEST_EMAIL_HINT = "Hãy mở email mới nhất — các đường dẫn cũ sẽ không còn dùng được.";
// > `[auth.email] max_frequency = "1s"` trong supabase/config.toml (dư biên cho máy chậm) — gửi lại sớm hơn bị 429.
const RESEND_WAIT_MS = 2_000;
// Tiêu đề mang 2 số đầu OTP (config.toml) — mỗi lần yêu cầu một tiêu đề, Gmail không gộp thread.
const RECOVERY_SUBJECT_PATTERN = /\(yêu cầu #\d{2}\)$/;

let admin: SupabaseClient;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

async function requestPasswordReset(page: Page, email: string) {
  await page.goto("/forgot-password");
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Gửi đường dẫn đặt lại" }).click();
  await expect(page.getByText(/Nếu email này có tài khoản/)).toBeVisible();
  await expect(page.getByText(OPEN_LATEST_EMAIL_HINT)).toBeVisible();
}

async function submitNewPassword(page: Page, password: string) {
  await page.locator("#password").fill(password);
  await page.locator("#password-confirm").fill(password);
  await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
}

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
  await submitNewPassword(page, newPassword);
  await expect(page).toHaveURL(HOME_URL);

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
  await expect(page).toHaveURL(HOME_URL);
});

test("test_forgot_password_requested_twice_old_link_explains_latest_only_and_new_link_works", async ({ page }) => {
  // Arrange — yêu cầu đặt lại 2 lần (tái hiện ca prod 2026-09-15: user bấm nhầm mail cũ)
  const user = await seedUser(admin, "forgot-pw-twice");
  createdUsers.push(user.userId);
  const newPassword = "NewPass789!eF";

  await requestPasswordReset(page, user.email);
  await waitForMailsTo(user.email, 1);
  await page.waitForTimeout(RESEND_WAIT_MS);
  await requestPasswordReset(page, user.email);
  const [oldMail, newMail] = await waitForMailsTo(user.email, 2);
  const oldLink = extractConfirmLink(oldMail.content, "recovery");
  const newLink = extractConfirmLink(newMail.content, "recovery");

  // Tiêu đề render số yêu cầu từ OTP (không so khác nhau: 2 số có 1% trùng → test chập chờn)
  expect(oldMail.subject).toMatch(RECOVERY_SUBJECT_PATTERN);
  expect(newMail.subject).toMatch(RECOVERY_SUBJECT_PATTERN);

  // Act — mở link trong mail CŨ
  await page.goto(oldLink);

  // Assert — báo rõ chỉ email mới nhất còn dùng được + nút gửi lại
  await expect(page).toHaveURL(/\/login\?error=link_invalid/);
  await expect(page.getByText(LINK_INVALID_TEXT)).toBeVisible();
  await page.getByRole("link", { name: "Gửi lại email đặt lại mật khẩu" }).click();
  await expect(page).toHaveURL(/\/forgot-password/);

  // Act — mở link trong mail MỚI rồi đổi mật khẩu
  await page.goto(newLink);
  await expect(page).toHaveURL(/\/reset-password/);
  await submitNewPassword(page, newPassword);

  // Assert
  await expect(page).toHaveURL(HOME_URL);
});

test("test_reset_password_reusing_current_password_shows_must_differ_message", async ({ page }) => {
  // Arrange — mở link đặt lại hợp lệ
  const user = await seedUser(admin, "forgot-pw-same");
  createdUsers.push(user.userId);
  await requestPasswordReset(page, user.email);
  const mail = await waitForMailTo(user.email);
  await page.goto(extractConfirmLink(mail, "recovery"));
  await expect(page).toHaveURL(/\/reset-password/);

  // Act — nhập lại đúng mật khẩu đang dùng
  await submitNewPassword(page, TEST_PASSWORD);

  // Assert — GoTrue trả 422 same_password → câu tiếng Việt, ở lại trang
  await expect(page.getByText("Mật khẩu mới phải khác mật khẩu hiện tại.")).toBeVisible();
  await expect(page).toHaveURL(/\/reset-password/);
});

test("test_forgot_password_invalid_token_hash_shows_error_on_login", async ({ page }) => {
  // Act — token_hash không tồn tại/sai
  await page.goto("/auth/confirm?token_hash=obviously-invalid-token&type=recovery");

  // Assert
  await expect(page).toHaveURL(/\/login\?error=link_invalid/);
  await expect(page.getByText(LINK_INVALID_TEXT)).toBeVisible();
  await expect(page.getByRole("link", { name: "Gửi lại email đặt lại mật khẩu" })).toBeVisible();
});

test("test_forgot_password_unknown_email_still_shows_neutral_message", async ({ page }) => {
  // Act — email chưa từng đăng ký tài khoản nào
  await page.goto("/forgot-password");
  await page.locator("#email").fill(uniqueEmail("forgot-pw-unknown"));
  await page.getByRole("button", { name: "Gửi đường dẫn đặt lại" }).click();

  // Assert — KHÔNG được lộ khác biệt với case email có tài khoản thật
  await expect(page.getByText(/Nếu email này có tài khoản/)).toBeVisible();
});
