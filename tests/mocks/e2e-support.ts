import { expect, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tiện ích dùng chung cho 3 spec live/report. Đặt ở `tests/mocks/` (không phải
 * `tests/helpers/`) vì P07 chia quyền sở hữu file: helpers do agent khác giữ.
 */

/** Kịch bản mock Soniox — server đọc từ `api_key` của config frame (soniox-ws-server.ts). */
export type SonioxScenario = "basic" | "drop";

/**
 * Chặn route cấp key Soniox và nhét kịch bản + runId vào chính chuỗi key.
 *
 * Vì sao không dùng `stubSonioxKey` của `tests/helpers/auth.ts`: helper đó trả key
 * cố định `e2e-fake-temp-key` → mock rơi về kịch bản `basic` + runId dùng chung
 * `anon`. Mock đếm số lần kết nối THEO runId để biết đâu là lần reconnect, nên
 * runId dùng chung sẽ khiến 2 spec chạy song song (hoặc 2 lần chạy liên tiếp, vì
 * `reuseExistingServer` giữ nguyên tiến trình mock) đọc nhầm bộ đếm của nhau.
 *
 * Route thật gọi `https://api.soniox.com/...` bằng URL hardcode phía server nên
 * chỉ chặn được ở tầng browser (xem `src/app/api/sessions/[id]/soniox-key/route.ts`).
 */
export async function stubSonioxKeyWithScenario(page: Page, scenario: SonioxScenario): Promise<string> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await page.route("**/api/sessions/*/soniox-key", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        keys: [`e2e:${scenario}:${runId}`],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
  });
  return runId;
}

/** Tên trạng thái banner kết nối, theo đúng chuỗi hiển thị ở `src/components/common/banner.tsx`. */
export type BannerState = "degraded" | "restored" | "silent" | "none";

const BANNER_MARKERS: [string, BannerState][] = [
  ["Mất kết nối — đang thử lại.", "degraded"],
  ["Đã nối lại — transcript được giữ nguyên.", "restored"],
  ["Chưa nhận được âm thanh", "silent"],
];

/**
 * Ghi lại MỌI lần banner đổi trạng thái, bằng MutationObserver cài trước khi trang chạy.
 *
 * Vì sao không dùng thẳng `expect(banner).toBeVisible()`: nối lại với mock ở localhost
 * chỉ mất vài chục ms, nên cặp degraded→restored có thể trôi qua GIỮA hai nhịp poll của
 * Playwright và assertion trượt dù ứng dụng chạy đúng. MutationObserver bắt đúng thời
 * điểm DOM đổi nên không bỏ sót — chặt hơn poll, không nới lỏng điều đang kiểm.
 */
export async function recordBannerTransitions(page: Page): Promise<void> {
  await page.addInitScript((markers: [string, BannerState][]) => {
    const log: BannerState[] = [];
    (window as unknown as { __bannerLog: BannerState[] }).__bannerLog = log;
    let last: BannerState = "none";
    const sample = () => {
      const text = document.body?.textContent ?? "";
      let current: BannerState = "none";
      for (const [needle, name] of markers) {
        if (text.includes(needle)) {
          current = name;
          break;
        }
      }
      if (current !== last) {
        last = current;
        log.push(current);
      }
    };
    // Quan sát chính `document`: init script chạy TRƯỚC khi `documentElement` tồn tại,
    // truyền vào lúc đó sẽ ném "parameter 1 is not of type 'Node'".
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, BANNER_MARKERS);
}

/**
 * Ghi lại mọi nội dung toast từng hiện. Toast tự tắt sau 2.4s
 * (`session-store.ts` TOAST_DURATION_MS) nên `expect(getByRole("status"))` có thể trượt
 * khi máy tải nặng — MutationObserver bắt đúng lúc DOM đổi, không bỏ sót.
 */
export async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __toastLog: string[] }).__toastLog = log;
    const sample = () => {
      const text = document.querySelector('[role="status"]')?.textContent?.trim() ?? "";
      if (text.length > 0 && log[log.length - 1] !== text) log.push(text);
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

/** Danh sách toast đã hiện, theo thứ tự xuất hiện. */
export async function readToasts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __toastLog?: string[] }).__toastLog ?? []);
}

/** Đọc nhật ký banner đã ghi, bỏ các quãng "none" để so trình tự cho gọn. */
export async function readBannerTransitions(page: Page): Promise<BannerState[]> {
  const log = await page.evaluate(
    () => (window as unknown as { __bannerLog?: BannerState[] }).__bannerLog ?? [],
  );
  return log.filter((s) => s !== "none");
}

export interface DbUtterance {
  seq: number;
  text_orig: string;
  lang: string | null;
  speaker: string;
  translations: { vi?: string | null; ja?: string | null; en?: string | null } | null;
}

/** Đọc transcript đã ghi của 1 buổi, sắp theo `seq` tăng dần. */
export async function readUtterances(admin: SupabaseClient, sessionId: string): Promise<DbUtterance[]> {
  const { data, error } = await admin
    .from("utterances")
    .select("seq, text_orig, lang, speaker, translations")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });
  if (error) throw new Error(`Đọc utterances thất bại: ${error.message}`);
  return (data ?? []) as DbUtterance[];
}

/**
 * Chờ transcript đủ `expected` lượt. Dùng `expect.poll` (KHÔNG `waitForTimeout`) —
 * mock phát theo mốc cố định nên số lượt là tất định, chỉ độ trễ mạng/ingest là biến thiên.
 */
export async function waitForUtteranceCount(
  admin: SupabaseClient,
  sessionId: string,
  expected: number,
  timeoutMs = 45_000,
): Promise<DbUtterance[]> {
  await expect
    .poll(async () => (await readUtterances(admin, sessionId)).length, {
      timeout: timeoutMs,
      message: `chờ đủ ${expected} lượt thoại được ingest`,
    })
    .toBeGreaterThanOrEqual(expected);
  return readUtterances(admin, sessionId);
}

/**
 * Chờ tới khi MỌI câu trong `texts` đã có mặt trong transcript.
 *
 * Khác `waitForUtteranceCount`: không đếm số dòng. Buổi vào /live bằng điều hướng
 * client-side có thể chạy pipeline thu âm 2 lần (bug đã báo ở P07) — khi đó đủ N dòng
 * KHÔNG có nghĩa là đủ N lượt khác nhau, vì nửa số dòng chỉ là bản trùng của lượt đầu.
 */
export async function waitForTurnsPresent(
  admin: SupabaseClient,
  sessionId: string,
  texts: string[],
  timeoutMs = 45_000,
): Promise<DbUtterance[]> {
  await expect
    .poll(
      async () => {
        const rows = await readUtterances(admin, sessionId);
        return texts.filter((t) => rows.some((u) => u.text_orig.includes(t))).length;
      },
      { timeout: timeoutMs, message: `chờ đủ ${texts.length} lượt thoại KHÁC NHAU` },
    )
    .toBe(texts.length);
  return readUtterances(admin, sessionId);
}

/**
 * `seq` do RPC `next_utterance_seq` cấp phía server. Buổi phải liên tục 1..N —
 * thủng số nghĩa là có lượt bị mất (hoặc cấp số bị nhảy) quanh lúc rớt kết nối.
 */
export function assertSeqUnbroken(utterances: DbUtterance[]): void {
  const seqs = utterances.map((u) => u.seq);
  const expected = Array.from({ length: seqs.length }, (_, i) => i + 1);
  expect(seqs, "seq phải liên tục 1..N, không thủng").toEqual(expected);
}
