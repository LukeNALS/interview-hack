import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchSonioxPairKeys } from "@/hooks/live-session/live-session-api-client";
import { ApiError } from "@/hooks/use-session";

/** `POST /api/sessions/:id/soniox-key` trả `{ keys: [canonical, en], expires_at }` — 2 key single-use KHÁC nhau. */

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

describe("fetchSonioxPairKeys", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("test_soniox_pair_keys_fetch_maps_two_keys_to_canonical_and_en", async () => {
    // Arrange
    fetchMock.mockResolvedValue(jsonResponse({ keys: ["temp:aaa", "temp:bbb"], expires_at: "2026-09-29T12:01:00Z" }));

    // Act
    const keys = await fetchSonioxPairKeys("session-1");

    // Assert — thứ tự route: keys[0] = canonical, keys[1] = en; POST đúng path
    expect(keys).toEqual({ canonical: "temp:aaa", en: "temp:bbb" });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/soniox-key", { method: "POST" });
  });

  test("test_soniox_pair_keys_fetch_when_fewer_than_two_keys_throws", async () => {
    // Arrange — route bản cũ (rollback) trả 1 key: dùng chung cho 2 connection ⇒ connection thứ 2 nhận 401
    fetchMock.mockResolvedValue(jsonResponse({ keys: ["temp:only"], expires_at: "2026-09-29T12:01:00Z" }));

    // Act + Assert
    await expect(fetchSonioxPairKeys("session-1")).rejects.toThrow("2 key khác nhau");
  });

  test("test_soniox_pair_keys_fetch_when_two_keys_identical_throws", async () => {
    // Arrange
    fetchMock.mockResolvedValue(jsonResponse({ keys: ["temp:same", "temp:same"], expires_at: "2026-09-29T12:01:00Z" }));

    // Act + Assert
    await expect(fetchSonioxPairKeys("session-1")).rejects.toThrow("2 key khác nhau");
  });

  test("test_soniox_pair_keys_fetch_when_route_returns_503_throws_api_error_with_code", async () => {
    // Arrange — route fail-closed khi rate-limit không kiểm được
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "rate_limit_unavailable", message: "Dịch vụ tạm thời không khả dụng" } }, false),
    );

    // Act
    const failure = await fetchSonioxPairKeys("session-1").catch((err: unknown) => err);

    // Assert — giữ nguyên ApiError.code để reconnectWithBackoff/toast phân loại
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("rate_limit_unavailable");
  });
});
