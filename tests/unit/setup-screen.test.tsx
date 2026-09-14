import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SetupScreen } from "@/components/setup/setup-screen";
import { clockOffsetStorageKey } from "@/hooks/use-session";
import { createInitialState, useSessionStore } from "@/stores/session-store";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// P05: goLive() giờ gọi POST /start thật (useStartSession) trước khi điều
// hướng /live — cần QueryClientProvider + mock fetch (không gọi API thật).
function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(ui, { wrapper: Wrapper });
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  useSessionStore.setState(createInitialState());
  pushMock.mockClear();
  window.localStorage.clear();
  // Định tuyến theo URL: header màn Setup giờ đọc tên ứng viên từ `GET /sessions/:id`
  // (trước đây lấy MOCK_SESSION), nên mock "trả một body cho mọi request" không còn đúng.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/start")) {
        return Promise.resolve(jsonResponse(200, { started_at: "2026-08-12T00:00:00.000Z", cap_seconds: 5400 }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          session: { id: "demo", status: "prep", mode: "online", candidate_name: "Trần Thị B", position: "Kỹ sư Backend" },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("test_setup_mode_online_pick_shows_tab_guide_screen", () => {
  // Arrange
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(screen.getByText("Phỏng vấn online"));

  // Assert — sang màn hướng dẫn chọn tab, CHƯA vào buổi, KHÔNG gọi /start
  expect(
    screen.getByRole("heading", { name: "Chọn tab cuộc họp" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Chia sẻ âm thanh của thẻ")).toBeInTheDocument();
  expect(pushMock).not.toHaveBeenCalled();
  // Ý của ca này: chọn mode CHƯA được trừ quota — tức chưa gọi POST /start.
  // (GET /sessions/:id vẫn chạy để lấy tên ứng viên cho header, không tính.)
  expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/start"))).toHaveLength(0);
});

test("test_setup_mode_direct_pick_navigates_to_live_immediately", async () => {
  // Arrange
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act — trực tiếp vào buổi NGAY (không test mic, không consent); goLive()
  // giờ async (chờ POST /start xong) nên assert qua waitFor.
  fireEvent.click(screen.getByText("Phỏng vấn trực tiếp"));

  // Assert
  await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/sessions/demo/live"));
  expect(useSessionStore.getState().mode).toBe("direct");
  expect(window.localStorage.getItem(clockOffsetStorageKey("demo"))).not.toBeNull();
});

test("test_setup_tab_guide_choose_tab_cta_navigates_to_live", async () => {
  // Arrange
  useSessionStore.setState({ setupStep: "tab-guide", mode: "online" });
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "Chọn tab cuộc họp" }));

  // Assert — chọn tab xong vào buổi ngay (không có bước kiểm âm)
  await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/sessions/demo/live"));
});

test("test_setup_mode_direct_pick_sends_mode_to_start_endpoint", async () => {
  // Arrange — BUG #4: mode chọn ở setup PHẢI lên server, vì màn live đọc `mode` từ
  // GET /sessions/:id chứ không đọc store client.
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(screen.getByText("Phỏng vấn trực tiếp"));

  // Assert
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  const startCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith("/start"));
  const [url, init] = startCall as [string, RequestInit];
  expect(url).toBe("/api/sessions/demo/start");
  expect(JSON.parse(String(init.body))).toEqual({ mode: "direct" });
});

test("test_setup_mode_online_choose_tab_sends_online_mode_to_start_endpoint", async () => {
  // Arrange
  useSessionStore.setState({ setupStep: "tab-guide", mode: "online" });
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(screen.getByRole("button", { name: "Chọn tab cuộc họp" }));

  // Assert
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  const startCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith("/start"));
  const [, init] = startCall as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({ mode: "online" });
});

test("test_setup_start_without_free_sessions_shows_reason_and_stays_on_setup", async () => {
  // Arrange — BUG #5: /start trả 409 no_free_sessions; trước đây lỗi bị nuốt và vẫn
  // điều hướng /live, guard đá về /prep mà KHÔNG giải thích gì.
  vi.mocked(fetch).mockResolvedValue(
    jsonResponse(409, { error: { code: "no_free_sessions", message: "Đã dùng hết số buổi miễn phí" } }),
  );
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(screen.getByText("Phỏng vấn trực tiếp"));

  // Assert — hiện đúng lời giải thích từ server, KHÔNG điều hướng
  expect(await screen.findByRole("alert")).toHaveTextContent(/hết\s+(số\s+)?buổi\s+(miễn phí|free)/i);
  expect(pushMock).not.toHaveBeenCalled();
});

test("test_setup_start_already_started_race_still_navigates_to_live", async () => {
  // Arrange — 409 session_already_started = buổi ĐÃ live thật (race 2 tab): vẫn phải
  // đi tiếp /live như cũ, chỉ `no_free_sessions` mới chặn.
  vi.mocked(fetch).mockResolvedValue(
    jsonResponse(409, { error: { code: "session_already_started", message: "Buổi này đã được bắt đầu rồi" } }),
  );
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(screen.getByText("Phỏng vấn trực tiếp"));

  // Assert
  await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/sessions/demo/live"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("test_setup_tab_guide_back_link_returns_to_mode_step", () => {
  // Arrange
  useSessionStore.setState({ setupStep: "tab-guide", mode: "online" });
  renderWithClient(<SetupScreen sessionId="demo" />);

  // Act
  fireEvent.click(
    screen.getByRole("button", { name: "← Quay lại chọn chế độ" }),
  );

  // Assert
  expect(
    screen.getByRole("heading", { name: "Buổi phỏng vấn diễn ra thế nào?" }),
  ).toBeInTheDocument();
});
