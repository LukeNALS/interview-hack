import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { throwOnError } from "../integration/db-test-support";
import { loginAs, stubSonioxKey } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, MINUTE_MS, seedSession, seedUser } from "../helpers/seed";

/**
 * Quota buổi free + cap 90'. KHÔNG phát audio thật: quota đi qua UI thật
 * (setup → /start), phần "buổi đã chạy N phút" seed thẳng DB bằng cách lùi
 * `started_at` — cap/duration phía server luôn tính lại `now() - started_at`
 * (`src/lib/cap-clock.ts`), không giữ timer nào để phải chờ.
 */

/** Cap mặc định 5400s (0005_live_fields.sql:10) — 91' vượt cap, còn 60s biên an toàn cho lệch giờ. */
const OVER_CAP_MS = 91 * MINUTE_MS;
/** /end hoàn quota khi duration < 300s (end/route.ts:11). */
const REFUND_THRESHOLD_SEC = 300;

let admin: SupabaseClient;
const createdUsers: string[] = [];

test.beforeAll(() => {
  admin = createE2eAdminClient();
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

async function readSessionStatus(sessionId: string): Promise<string> {
  const { data, error } = await admin.from("sessions").select("status").eq("id", sessionId).single();
  throwOnError(`đọc status session ${sessionId}`, error);
  return data!.status as string;
}

async function readFreeSessionsLeft(userId: string): Promise<number> {
  const { data, error } = await admin.from("profiles").select("free_sessions_left").eq("id", userId).single();
  throwOnError(`đọc quota user ${userId}`, error);
  return data!.free_sessions_left as number;
}

/**
 * Lùi `started_at` theo ĐỒNG HỒ NODE (không phải Postgres): `/end` tính
 * `duration_sec` bằng `computeElapsedSeconds(started_at, new Date())` chạy
 * trong process Next — cùng máy, cùng đồng hồ với process test.
 */
async function rewindStartedAt(sessionId: string, agoMs: number): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({ started_at: new Date(Date.now() - agoMs).toISOString() })
    .eq("id", sessionId);
  throwOnError(`lùi started_at session ${sessionId}`, error);
}

test("test_quota_start_debits_one_session_then_end_under_5min_refunds_it", async ({ page }) => {
  // Arrange — user còn đúng 1 buổi free + 1 buổi ở trạng thái prep. mode 'direct'
  // để màn live dùng micro giả của Chrome (online cần getDisplayMedia — không có
  // trong headless); stub /soniox-key để không chạm Soniox thật.
  const user = await seedUser(admin, "quota-refund", { freeSessionsLeft: 1 });
  createdUsers.push(user.userId);
  const sessionId = await seedSession(admin, { userId: user.userId, status: "prep", mode: "direct" });

  await stubSonioxKey(page);
  await loginAs(page, user.email);
  await expect(page.getByText("CÒN 1 BUỔI FREE")).toBeVisible();

  // Act — chọn chế độ "Phỏng vấn trực tiếp" ⇒ POST /start (trừ quota) rồi vào /live.
  await page.goto(`/sessions/${sessionId}/setup`);
  await page.getByRole("button", { name: /Phỏng vấn trực tiếp/ }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}/live$`));

  // Assert — badge tụt về 0. Badge chỉ có ở màn candidate; `/candidate` (buổi mới) không bị
  // SessionScreenGuard chặn nên đọc được kể cả khi buổi kia đang live.
  await page.goto("/candidate");
  await expect(page.getByText("CÒN 0 BUỔI FREE")).toBeVisible();
  expect(await readFreeSessionsLeft(user.userId)).toBe(0);

  // Act — giả buổi mới chạy 2 phút rồi kết thúc.
  await rewindStartedAt(sessionId, 2 * MINUTE_MS);
  const endResponse = await page.request.post(`/api/sessions/${sessionId}/end`);
  expect(endResponse.status()).toBe(200);
  const ended = await endResponse.json();
  expect(ended.duration_sec).toBeGreaterThanOrEqual(100);
  expect(ended.duration_sec).toBeLessThan(REFUND_THRESHOLD_SEC);

  // Assert — buổi dưới 5 phút được hoàn: badge trở lại 1.
  await page.goto("/candidate");
  await expect(page.getByText("CÒN 1 BUỔI FREE")).toBeVisible();
  expect(await readFreeSessionsLeft(user.userId)).toBe(1);
});

/** Hết quota → bấm "Phỏng vấn trực tiếp" ở màn setup. Trả về session vừa seed. */
async function attemptStartWithoutQuota(page: Page): Promise<{ userId: string; sessionId: string }> {
  const user = await seedUser(admin, "quota-zero", { freeSessionsLeft: 0 });
  createdUsers.push(user.userId);
  const sessionId = await seedSession(admin, { userId: user.userId, status: "prep", mode: "direct" });

  await stubSonioxKey(page);
  await loginAs(page, user.email);
  await expect(page.getByText("CÒN 0 BUỔI FREE")).toBeVisible();

  await page.goto(`/sessions/${sessionId}/setup`);
  await page.getByRole("button", { name: /Phỏng vấn trực tiếp/ }).click();
  return { userId: user.userId, sessionId };
}

test("test_quota_exhausted_start_is_blocked_and_user_stays_on_setup", async ({ page }) => {
  // Arrange + Act
  const { userId, sessionId } = await attemptStartWithoutQuota(page);

  // Assert — buổi KHÔNG được bắt đầu: /start trả 409 no_free_sessions nên SetupScreen
  // dừng tại chỗ (không điều hướng), session ở nguyên 'prep', quota không tụt xuống âm.
  //
  // Ghim CHÍNH XÁC `/setup$`, KHÔNG dùng alternation kiểu `/(setup|candidate)$`: khớp cả
  // hai sẽ nhận luôn hành vi cũ (đẩy sang /live rồi để guard đá về /candidate) — đúng cái
  // BUG #5 vừa sửa, và test sẽ im lặng khi nó tái phát.
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}/setup$`));
  expect(await readSessionStatus(sessionId)).toBe("prep");
  expect(await readFreeSessionsLeft(userId)).toBe(0);
});

/**
 * Regression BUG #5. Trước fix: SetupScreen nuốt lỗi /start rồi vẫn `router.push`
 * sang /live, guard đá ngược về /candidate — user chỉ thấy màn nhấp nháy rồi quay về nút
 * cũ, không một chữ giải thích. Nay lỗi `no_free_sessions` hiện tại chỗ bằng message
 * lấy thẳng từ server (`start/route.ts:26`).
 *
 * Badge "CÒN 0 BUỔI FREE" KHÔNG tính là thông báo: nó hiện y hệt cả TRƯỚC lúc bấm,
 * không nói gì về việc thao tác vừa rồi thất bại — nên assert bắt đúng chữ "hết
 * buổi miễn phí" chứ không bắt badge.
 */
test("test_quota_exhausted_start_shows_message_explaining_why", async ({ page }) => {
  // Arrange + Act
  await attemptStartWithoutQuota(page);

  // Assert — user phải biết vì sao không vào được buổi, và lời báo đó phải nằm trong
  // vùng role="alert" để screen reader đọc lên.
  //
  // `.filter()` chứ không phải `getByRole("alert")` trần: `next dev` tự chèn
  // <next-route-announcer role="alert"> nên locator trần dính strict mode violation
  // (2 phần tử) — hỏng vì hạ tầng dev chứ không phải vì app sai.
  const quotaAlert = page
    .getByRole("alert")
    .filter({ hasText: /hết\s+(số\s+)?buổi\s+(miễn phí|free)/i });
  await expect(quotaAlert).toBeVisible();
});

test("test_cap_90min_exceeded_rejects_soniox_key_403_and_utterances_409", async ({ page }) => {
  // Arrange — 2 buổi live đã chạy 91'. Tách 2 buổi CÓ CHỦ Ý: route /utterances tự
  // set status='processing' khi phát hiện quá cap (utterances/route.ts:84), dùng
  // chung 1 buổi sẽ khiến 2 assert phụ thuộc thứ tự gọi.
  const user = await seedUser(admin, "cap", { freeSessionsLeft: 1 });
  createdUsers.push(user.userId);
  const keySessionId = await seedSession(admin, {
    userId: user.userId,
    status: "live",
    startedAtOffsetMs: -OVER_CAP_MS,
  });
  const ingestSessionId = await seedSession(admin, {
    userId: user.userId,
    status: "live",
    startedAtOffsetMs: -OVER_CAP_MS,
  });
  await loginAs(page, user.email);

  // Act + Assert — hết giờ thì không cấp thêm key ASR nữa (chặn TRƯỚC khi gọi
  // Soniox, nên test này không chạm API thật).
  const keyResponse = await page.request.post(`/api/sessions/${keySessionId}/soniox-key`);
  expect(keyResponse.status()).toBe(403);
  expect((await keyResponse.json()).error.code).toBe("cap_reached");

  // Act + Assert — và không nhận thêm lượt thoại nào.
  const ingestResponse = await page.request.post(`/api/sessions/${ingestSessionId}/utterances`, {
    data: {
      utterances: [
        {
          client_utt_id: randomUUID(),
          speaker: "candidate",
          lang: "vi",
          text_orig: "Câu này gửi sau khi đã quá giờ",
        },
      ],
    },
  });
  expect(ingestResponse.status()).toBe(409);
  expect((await ingestResponse.json()).error.code).toBe("session_ended");

  // Assert — buổi quá cap bị chốt lại (processing) để luồng /end xử lý tiếp.
  expect(await readSessionStatus(ingestSessionId)).toBe("processing");
});
