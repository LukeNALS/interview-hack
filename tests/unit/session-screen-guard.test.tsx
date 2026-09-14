import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionScreenGuard } from "@/app/(app)/sessions/[id]/session-screen-guard";
import { renderWithQuery } from "../test-utils";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  replaceMock.mockClear();
});

// vitest không bật globals → RTL không tự cleanup, phải gọi tay.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("test_session_screen_guard_status_prep_on_live_screen_redirects_to_allowed_screen", async () => {
  // Arrange — session thật status='prep' (STATUS_SCREENS chỉ cho prep/setup)
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse(200, {
        session: {
          id: "sess-1",
          status: "prep",
          mode: "online",
          candidate_name: null,
          position: null,
          created_at: "2026-08-11T00:00:00Z",
        },
      }),
    ),
  );

  // Act — route vào /sessions/sess-1/live trong khi status thật là 'prep'
  renderWithQuery(
    <SessionScreenGuard sessionId="sess-1" screen="live">
      <div>Live content</div>
    </SessionScreenGuard>,
  );

  // Assert — assertScreenAllowed ném lỗi → guard redirect về màn đầu tiên hợp lệ (setup)
  await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/sessions/sess-1/setup"));
});

test("test_session_screen_guard_status_prep_on_setup_screen_does_not_redirect", async () => {
  // Arrange — setup nằm trong STATUS_SCREENS['prep'] → hợp lệ, không redirect
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse(200, {
        session: {
          id: "sess-1",
          status: "prep",
          mode: "online",
          candidate_name: null,
          position: null,
          created_at: "2026-08-11T00:00:00Z",
        },
      }),
    ),
  );

  // Act
  renderWithQuery(
    <SessionScreenGuard sessionId="sess-1" screen="setup">
      <div>Setup content</div>
    </SessionScreenGuard>,
  );
  await screen.findByText("Setup content");

  // Assert
  expect(replaceMock).not.toHaveBeenCalled();
});

test("test_session_screen_guard_get_session_unavailable_allows_mock_flow_to_continue", async () => {
  // Arrange — GET /api/sessions/:id hiện là stub 501 (BE chưa triển khai, xem report P04-FE)
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse(501, { error: { code: "not_implemented", message: "Chưa triển khai" } }),
    ),
  );

  // Act — màn live vẫn chạy mock demo, guard không có status thật để enforce
  renderWithQuery(
    <SessionScreenGuard sessionId="sess-1" screen="live">
      <div>Live content</div>
    </SessionScreenGuard>,
  );
  await screen.findByText("Live content");

  // Assert — không redirect khi chưa có dữ liệu status thật
  expect(replaceMock).not.toHaveBeenCalled();
});
