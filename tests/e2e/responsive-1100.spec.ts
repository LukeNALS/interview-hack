import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs, stubSonioxKey } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedSession, seedUser } from "../helpers/seed";

/**
 * Breakpoint DUY NHẤT của màn live: ≥1100px 2 cột (transcript / gợi ý trả lời),
 * <1100px 1 cột + thanh tab pill. Spec chạy ở CẢ HAI project của
 * `playwright.config.ts` (`desktop-1440` 1440px và `narrow-1024` 1024px), mỗi
 * test tự bỏ qua ở phía viewport không liên quan.
 *
 * 1100 CỐ Ý viết cứng ở đây thay vì import `NARROW_BREAKPOINT_PX`: test phải là
 * bên khẳng định con số, import lại chính hằng đang test thì đổi hằng cũng xanh.
 */
const NARROW_BREAKPOINT_PX = 1100;

/**
 * Label cột gợi ý — mốc nhận diện cột đang hiển thị hay không. `^…$` để khớp
 * ĐÚNG label cột, không dính placeholder "Khi người phỏng vấn đặt câu hỏi...".
 */
const SUGGEST_COLUMN = /^TRẢ LỜI GỢI Ý$/;
const TRANSCRIPT_EMPTY = "Bắt đầu nói chuyện, transcript sẽ hiện ở đây";

let admin: SupabaseClient;
let liveSessionId: string;
const createdUsers: string[] = [];
let userEmail: string;

test.beforeAll(async () => {
  // Arrange — 1 buổi đang live để vào thẳng màn live. mode 'direct' dùng micro giả
  // của Chrome (online cần getDisplayMedia — không có trong headless).
  admin = createE2eAdminClient();
  const user = await seedUser(admin, "responsive");
  createdUsers.push(user.userId);
  userEmail = user.email;
  liveSessionId = await seedSession(admin, { userId: user.userId, status: "live", mode: "direct" });
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_live_screen_below_1100px_shows_tab_bar_with_one_column_at_a_time", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) >= NARROW_BREAKPOINT_PX, "chỉ áp dụng cho viewport dưới 1100px");

  // Arrange
  await stubSonioxKey(page);
  await loginAs(page, userEmail);

  // Act
  await page.goto(`/sessions/${liveSessionId}/live`);

  // Assert — có thanh tab pill (chỉ còn Transcript · Gợi ý — Interview Hack không còn tab Câu hỏi).
  const transcriptTab = page.getByRole("button", { name: "Transcript" });
  await expect(transcriptTab).toBeVisible();
  await expect(page.getByRole("button", { name: /^Gợi ý/ })).toBeVisible();

  // Assert — 1 cột: chỉ tab đang chọn (mặc định Transcript) hiển thị.
  await expect(page.getByText(TRANSCRIPT_EMPTY)).toBeVisible();
  await expect(page.getByText(SUGGEST_COLUMN)).toHaveCount(0);

  // Act + Assert — đổi tab thì đổi cột, vẫn 1 cột.
  await page.getByRole("button", { name: /^Gợi ý/ }).click();
  await expect(page.getByText(SUGGEST_COLUMN)).toBeVisible();
  await expect(page.getByText(TRANSCRIPT_EMPTY)).toBeHidden();
});

test("test_live_screen_at_or_above_1100px_shows_two_columns_without_tab_bar", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < NARROW_BREAKPOINT_PX, "chỉ áp dụng cho viewport từ 1100px trở lên");

  // Arrange
  await stubSonioxKey(page);
  await loginAs(page, userEmail);

  // Act
  await page.goto(`/sessions/${liveSessionId}/live`);

  // Assert — cả 2 cột cùng hiển thị.
  const transcript = page.getByText(TRANSCRIPT_EMPTY);
  const suggestColumn = page.getByText(SUGGEST_COLUMN);
  await expect(transcript).toBeVisible();
  await expect(suggestColumn).toBeVisible();

  // Assert — nằm CẠNH nhau (transcript trái · gợi ý phải) chứ không xếp dọc. Chữ trạng thái
  // trống của transcript căn GIỮA theo chiều dọc còn nhãn cột gợi ý nằm sát đỉnh, nên không so
  // bằng y; nếu xếp chồng thì nhãn cột gợi ý phải nằm DƯỚI toàn bộ vùng chữ transcript.
  const transcriptBox = (await transcript.boundingBox())!;
  const suggestBox = (await suggestColumn.boundingBox())!;
  expect(transcriptBox.x + transcriptBox.width).toBeLessThanOrEqual(suggestBox.x);
  expect(suggestBox.y).toBeLessThan(transcriptBox.y + transcriptBox.height);

  // Assert — KHÔNG có thanh tab pill.
  await expect(page.getByRole("button", { name: "Transcript" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Gợi ý/ })).toHaveCount(0);
});
