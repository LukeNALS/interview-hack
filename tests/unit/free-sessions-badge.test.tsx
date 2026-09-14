import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FreeSessionsBadge } from "@/components/common/free-sessions-badge";
import { renderWithQuery } from "../test-utils";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => {
  // vitest không bật globals → RTL không tự cleanup, phải gọi tay.
  cleanup();
  vi.unstubAllGlobals();
});

test("test_free_sessions_badge_renders_real_count_from_me_endpoint", async () => {
  // Arrange — GET /api/me trả quota thật (không phải mock 3 buổi cứng cũ)
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/me") {
      return jsonResponse(200, { free_sessions_left: 2, plan: "free", retention_days: 90 });
    }
    return jsonResponse(404, { error: { code: "not_found" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  // Act
  renderWithQuery(<FreeSessionsBadge />);

  // Assert — hiện đúng số server trả
  expect(await screen.findByText("CÒN 2 BUỔI FREE")).toBeInTheDocument();
});

test("test_free_sessions_badge_hides_while_loading_instead_of_flashing_zero", async () => {
  // Arrange — request treo (chưa resolve) → mô phỏng khoảnh khắc đang tải
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal("fetch", vi.fn(() => pending));

  // Act
  const { container } = renderWithQuery(<FreeSessionsBadge />);

  // Assert — KHÔNG nháy "CÒN 0 BUỔI FREE", không render gì cả
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText(/BUỔI FREE/)).not.toBeInTheDocument();
});

test("test_free_sessions_badge_hides_when_me_endpoint_fails", async () => {
  // Arrange — /api/me lỗi 500 (mạng chập / chưa đăng nhập)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(500, { error: { code: "internal_error" } })),
  );

  // Act
  const { container } = renderWithQuery(<FreeSessionsBadge />);

  // Assert — ẩn badge, tuyệt đối không hiện số 0 sai lệch
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(screen.queryByText(/BUỔI FREE/)).not.toBeInTheDocument();
});
