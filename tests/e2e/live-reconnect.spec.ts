import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "../helpers/auth";
import { createE2eAdminClient, deleteTestUsers, seedSession, seedUser } from "../helpers/seed";
import {
  assertSeqUnbroken,
  readBannerTransitions,
  recordBannerTransitions,
  stubSonioxKeyWithScenario,
  waitForUtteranceCount,
} from "../mocks/e2e-support";
import { FIXTURE_TURNS } from "../mocks/soniox-fixtures";

/**
 * Mất kết nối Soniox GIỮA buổi: banner vàng (degraded) → tự nối lại → banner xanh
 * (restored) → transcript vẫn đủ 10 lượt và `seq` liên tục KHÔNG thủng.
 *
 * Mock cắt socket phũ (destroy, không close frame) sau 3 lượt đầu — kịch bản `drop`
 * trong `tests/mocks/soniox-ws-server.ts`. Lượt 4-10 phát ở lần kết nối sau, đúng chỗ
 * đã dừng, nên mất lượt nào là lộ ngay ở phép so nội dung bên dưới.
 *
 * Buổi dùng mode `direct` (1 luồng mic) chứ không phải `online`: `online` gọi
 * `getDisplayMedia` — Playwright không lái được hộp thoại chọn tab của Chrome.
 */

const TURNS_BEFORE_DROP = 3;

let admin: SupabaseClient;
let sessionId: string;
let email: string;
const createdUsers: string[] = [];

test.beforeAll(async () => {
  // Arrange — buổi ĐANG live của user riêng spec này (chạy song song không đụng ai).
  admin = createE2eAdminClient();
  const user = await seedUser(admin, "reconnect");
  createdUsers.push(user.userId);
  email = user.email;
  sessionId = await seedSession(admin, { userId: user.userId, status: "live", mode: "direct" });
});

test.afterAll(async () => {
  await deleteTestUsers(admin, createdUsers);
});

test("test_live_soniox_ws_drop_midsession_shows_degraded_then_restored_with_unbroken_seq", async ({ page }) => {
  // Arrange — key giả mang kịch bản `drop` để mock biết cắt socket sau 3 lượt.
  await stubSonioxKeyWithScenario(page, "drop");
  await recordBannerTransitions(page);
  await loginAs(page, email);

  // Act — vào màn live; mock bắt đầu phát khi nhận chunk audio đầu tiên.
  await page.goto(`/sessions/${sessionId}/live`);

  // Assert — trước khi rớt: đã có transcript và KHÔNG có banner mất kết nối.
  // (Banner hiện sẵn từ đầu nghĩa là Realtime tự rớt → phép thử phía dưới vô nghĩa.)
  await waitForUtteranceCount(admin, sessionId, 1);
  // Mặc định pane hiện BẢN DỊCH (`viewOrig: false`, session-store.ts:109) — đổi sang
  // "Bản gốc" để so đúng câu tiếng Nhật/tiếng Việt gốc như người dùng thật vẫn làm.
  await page.getByRole("button", { name: "Bản gốc" }).click();
  await expect(page.getByText(FIXTURE_TURNS[0].orig)).toBeVisible();
  await expect(page.getByText("Mất kết nối — đang thử lại.")).toHaveCount(0);

  // Assert — mock cắt socket sau lượt thứ 3 → banner vàng (degraded); controller tự mở
  // lại cặp connection → banner xanh (restored). Đọc qua MutationObserver thay vì
  // `toBeVisible()` vì nối lại ở localhost chỉ mất vài chục ms, poll dễ trượt (xem
  // `recordBannerTransitions`). Vẫn là chuỗi hiển thị THẬT của banner, không nới lỏng.
  await expect
    .poll(() => readBannerTransitions(page), {
      timeout: 30_000,
      message: "chờ banner đi qua degraded rồi restored",
    })
    .toEqual(["degraded", "restored"]);

  // Assert — transcript đủ 10 lượt, đúng nội dung, đúng thứ tự, không thừa không thiếu.
  const utterances = await waitForUtteranceCount(admin, sessionId, FIXTURE_TURNS.length);
  expect(utterances).toHaveLength(FIXTURE_TURNS.length);
  utterances.forEach((u, i) => {
    // `toContain` chứ không `toEqual`: `text_orig` hiện bị lặp phần đầu do
    // `TokenSegmentAccumulator` gộp cả token `is_final:false` vào bản final
    // (bug P0 đã báo trong report P07 — KHÔNG sửa ở đây vì src/** ngoài quyền spec này).
    // Bản dịch không dính bug nên vẫn so khớp TUYỆT ĐỐI ngay bên dưới.
    expect(u.text_orig).toContain(FIXTURE_TURNS[i].orig);
    expect(u.lang).toBe(FIXTURE_TURNS[i].lang);
    expect(u.translations?.en).toBe(FIXTURE_TURNS[i].en);
  });

  // Assert — điều cốt lõi: seq liên tục 1..10, KHÔNG thủng quanh chỗ rớt.
  assertSeqUnbroken(utterances);

  // Assert — hai lượt sát mép cắt đều còn (không nuốt lượt biên).
  expect(utterances[TURNS_BEFORE_DROP - 1].text_orig).toContain(FIXTURE_TURNS[TURNS_BEFORE_DROP - 1].orig);
  expect(utterances[TURNS_BEFORE_DROP].text_orig).toContain(FIXTURE_TURNS[TURNS_BEFORE_DROP].orig);

  // Assert — lượt cuối (phát SAU khi nối lại) hiện trên màn hình. `.first()` vì bong bóng
  // partial (id `utt--1`) vẫn giữ nguyên văn lượt cuối bên cạnh bong bóng final.
  await expect(page.getByText(FIXTURE_TURNS[FIXTURE_TURNS.length - 1].orig).first()).toBeVisible();

  // Assert — N13a list phẳng nhóm theo người nói (plan 20260825-1905, pivot 2026-09-03):
  // fixture ja = speaker 1 → nhóm PV (`data-pv="1"`), vi = speaker 2 → nhóm ứng viên
  // (`data-pv="0"`) — cả hai vai cùng hiển thị, mỗi nhóm có hàng transcript bên trong.
  // Đặt ở spec này thay vì responsive-1100 vì chỉ harness này phát transcript thật —
  // responsive-1100 cố tình giữ transcript RỖNG (assert TRANSCRIPT_EMPTY). Spec chạy ở cả
  // 2 project viewport nên phủ luôn narrow lẫn wide.
  await expect(page.locator('section[data-pv="1"] [id^="utt-"]').first()).toBeVisible();
  await expect(page.locator('section[data-pv="0"] [id^="utt-"]').first()).toBeVisible();
});
