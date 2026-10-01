import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useBackfill, type UtteranceRow } from "@/hooks/use-backfill";

/**
 * Audit #8: `GET /utterances` trả tối đa 500 dòng + `next_after_seq`; bootstrap/gap/reconnect chỉ đọc 1 trang nên phiên
 * dài (> 500 lượt) thiếu lời thoại trên màn live. `backfillFrom` phải tự lặp theo con trỏ tới khi hết.
 */

const PAGE = 500;
const row = (seq: number): UtteranceRow => ({ seq, text_orig: `câu ${seq}` }) as UtteranceRow;
const jsonResponse = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;

/** Server giả: có `total` lượt (seq 1..total), trả tối đa PAGE dòng sau `after_seq`, `next_after_seq` đúng như route thật. */
function fakeServer(total: number) {
  const afterSeqs: number[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const after = Number(new URL(String(input), "http://x").searchParams.get("after_seq"));
    afterSeqs.push(after);
    const rows: UtteranceRow[] = [];
    for (let seq = after + 1; seq <= total && rows.length < PAGE; seq++) rows.push(row(seq));
    return jsonResponse({ utterances: rows, next_after_seq: rows.length === PAGE ? rows[rows.length - 1].seq : null });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { afterSeqs, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("test_backfill_from_follows_next_after_seq_until_all_1200_utterances_are_loaded", async () => {
  // Arrange — reload phiên có 1.200 lượt (3 trang)
  const server = fakeServer(1200);
  const { result } = renderHook(() => useBackfill("sess-1"));

  // Act
  const res = await result.current.backfillFrom(0);

  // Assert — đủ 1200 dòng, đúng thứ tự, 3 request theo con trỏ, hết trang thì con trỏ null
  expect(res.utterances).toHaveLength(1200);
  expect(res.utterances.map((u) => u.seq)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
  expect(server.afterSeqs).toEqual([0, 500, 1000]);
  expect(res.next_after_seq).toBeNull();
});

test("test_backfill_from_with_exactly_one_full_page_asks_once_more_and_stops_on_the_empty_page", async () => {
  // Arrange — đúng 500 lượt: route trả next_after_seq=500 nên trang kế rỗng
  const server = fakeServer(500);
  const { result } = renderHook(() => useBackfill("sess-1"));

  // Act
  const res = await result.current.backfillFrom(0);

  // Assert
  expect(res.utterances).toHaveLength(500);
  expect(server.afterSeqs).toEqual([0, 500]);
});

test("test_backfill_from_gap_recovery_loads_every_missing_page_after_the_given_seq", async () => {
  // Arrange — gap ở seq 700 trên phiên 1.650 lượt: cần 701..1650 (2 trang: 500 + 450)
  const server = fakeServer(1650);
  const { result } = renderHook(() => useBackfill("sess-1"));

  // Act
  const res = await result.current.backfillFrom(700);

  // Assert
  expect(res.utterances.map((u) => u.seq)).toEqual(Array.from({ length: 950 }, (_, i) => 701 + i));
  expect(server.afterSeqs).toEqual([700, 1200]);
});

test("test_backfill_from_stops_when_the_server_cursor_does_not_advance", async () => {
  // Arrange — server lỗi trả mãi cùng con trỏ: không được lặp vô hạn
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return jsonResponse({ utterances: [row(1)], next_after_seq: 0 });
    }),
  );
  const { result } = renderHook(() => useBackfill("sess-1"));

  // Act
  const res = await result.current.backfillFrom(0);

  // Assert
  expect(calls).toBe(1);
  expect(res.utterances).toHaveLength(1);
});

test("test_backfill_from_caps_the_number_of_pages_per_call", async () => {
  // Arrange — 100 trang giả (50.000 lượt): chặn ở MAX trang để không dội server
  const server = fakeServer(50_000);
  const { result } = renderHook(() => useBackfill("sess-1"));

  // Act
  const res = await result.current.backfillFrom(0);

  // Assert — dừng ở 40 trang (20.000 lượt), con trỏ còn lại báo cho caller
  expect(server.fetchMock).toHaveBeenCalledTimes(40);
  expect(res.utterances).toHaveLength(20_000);
  expect(res.next_after_seq).toBe(20_000);
});

test("test_backfill_from_without_session_returns_empty_without_requests", async () => {
  // Arrange
  const server = fakeServer(10);
  const { result } = renderHook(() => useBackfill(null));

  // Act
  const res = await result.current.backfillFrom(0);

  // Assert
  expect(res).toEqual({ utterances: [], next_after_seq: null });
  expect(server.fetchMock).not.toHaveBeenCalled();
});
