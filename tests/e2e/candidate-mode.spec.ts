import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedSession, seedUser } from "../helpers/seed";
import { ANSWER_HINT_FIXTURE_TEXT } from "../mocks/claude-fixtures";
import { readToasts, recordToasts, stubSonioxKeyWithScenario } from "../mocks/e2e-support";

/**
 * Chế độ ỨNG VIÊN (plan 20260905-0820): (1) form mô tả buổi tạo session kind='candidate'
 * và sang setup; (2) trong live, final của NGƯỜI PHỎNG VẤN kích trigger → POST /answer-hint
 * → mock Claude (nhánh properties.answer) trả ANSWER_HINT_FIXTURE_TEXT → card "TRẢ LỜI GỢI Ý"
 * (không có nút thêm vào bộ câu hỏi, không cột câu hỏi); kết thúc → về /candidate, DB done,
 * 0 report_jobs. Mode direct như live-suggestion.spec (Playwright không lái được picker tab).
 */

test.setTimeout(120_000);

let admin: SupabaseClient;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  admin = createE2eAdminClient();
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_candidate_start_form_creates_candidate_session_and_goes_to_setup", async ({ page }) => {
  // Arrange
  const user = await seedUser(admin, "candstart", { freeSessionsLeft: 3 });
  createdUsers.push(user.userId);
  await loginAs(page, user.email);

  // Act — mở /candidate, nhập mô tả, bắt đầu.
  await page.goto("/candidate");
  await page.getByLabel(/Buổi phỏng vấn này là gì/).fill("Phỏng vấn Backend Engineer, vòng kỹ thuật Node.js.");
  await page.getByRole("button", { name: /Bắt đầu buổi phỏng vấn/ }).click();

  // Assert — sang setup + DB đúng kind và brief.
  await expect(page).toHaveURL(/\/setup$/, { timeout: 30_000 });
  const { data } = await admin
    .from("sessions")
    .select("kind, jd_text")
    .eq("user_id", user.userId)
    .limit(1)
    .maybeSingle();
  expect(data?.kind).toBe("candidate");
  expect(data?.jd_text).toContain("Backend Engineer");
});

test("test_candidate_live_shows_answer_hint_after_interviewer_question_and_ends_without_report", async ({ page, viewport }) => {
  // Arrange — buổi candidate đang live, mode direct (mock Soniox phát 10 lượt, có lượt người phỏng vấn).
  const user = await seedUser(admin, "candlive", { freeSessionsLeft: 3 });
  createdUsers.push(user.userId);
  const sessionId = await seedSession(admin, {
    userId: user.userId,
    status: "live",
    mode: "direct",
    kind: "candidate",
    jdText: "Phỏng vấn Backend Engineer, vòng kỹ thuật.",
  });
  await stubSonioxKeyWithScenario(page, "basic");
  await recordToasts(page);
  await loginAs(page, user.email);
  const narrow = (viewport?.width ?? 0) < 1100;

  // Act — vào màn live.
  await page.goto(`/sessions/${sessionId}/live`);
  if (narrow) await page.getByRole("button", { name: /^Gợi ý/ }).click();

  // Assert — card trả lời hiện (mock LLM trả tức thì sau debounce 2.5s), đúng biến thể candidate.
  await expect(page.getByText(ANSWER_HINT_FIXTURE_TEXT).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("TRẢ LỜI GỢI Ý")).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Thêm vào bộ câu hỏi" })).toHaveCount(0);
  if (narrow) {
    await expect(page.getByRole("button", { name: /^Câu hỏi ·/ })).toHaveCount(0);
  }

  // Act — kết thúc buổi (modal candidate: không có checkbox skip).
  await page.getByRole("button", { name: "Kết thúc" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Kết thúc" }).click();

  // Assert — về /candidate, DB done, không có report job (không call LLM report nào).
  await expect(page).toHaveURL(/\/candidate$/, { timeout: 30_000 });
  await expect.poll(() => readToasts(page), { timeout: 15_000 }).toContain("Đã kết thúc buổi phỏng vấn");
  await expect
    .poll(
      async () => (await admin.from("sessions").select("status").eq("id", sessionId).maybeSingle()).data?.status,
      { timeout: 15_000 },
    )
    .toBe("done");
  const { data: jobs } = await admin.from("report_jobs").select("id").eq("session_id", sessionId);
  expect(jobs ?? []).toHaveLength(0);
});
