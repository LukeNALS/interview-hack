import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedUser } from "../helpers/seed";

/**
 * Thoát phiên phải dọn cookie thật: sau khi đăng xuất, gõ lại đường trong app
 * KHÔNG được vào — nếu chỉ điều hướng mà không `signOut` thì bước cuối sẽ lọt.
 */

let admin: SupabaseClient;
let email: string;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
  const user = await seedUser(admin, "logout");
  createdUsers.push(user.userId);
  email = user.email;
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_logout_from_candidate_header_clears_session", async ({ page }) => {
  // Arrange
  await loginAs(page, email);

  // Act
  await page.getByRole("button", { name: "ĐĂNG XUẤT" }).click();

  // Assert — về login, và phiên đã bị dọn nên không quay lại candidate được
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/candidate");
  await expect(page).toHaveURL(/\/login/);
});
