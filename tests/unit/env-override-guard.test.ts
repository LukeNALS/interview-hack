import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Guard test cho H1 (code review P07): env override CHỈ được có hiệu lực NGOÀI production.
 *
 * Mối đe doạ: thiếu guard thì set 1 biến env trên Vercel là bẻ hướng toàn bộ audio live +
 * temp key Soniox (`NEXT_PUBLIC_SONIOX_WS_URL`) hoặc toàn bộ request Claude KÈM header API
 * key (`ANTHROPIC_BASE_URL`) sang host bất kỳ — KHÔNG cần deploy lại code. Test này khoá
 * cả 2 chiều: prod bỏ qua override, non-prod vẫn nhận override (đường E2E phải còn chạy).
 *
 * KỸ THUẬT: cả 2 giá trị đều đánh giá theo `process.env` ở thời điểm import/khởi tạo
 * (`SONIOX_WS_URL` là const module-scope; `llm/client.ts` cache `cachedClient`) → mỗi ca
 * phải `vi.stubEnv` TRƯỚC, rồi `vi.resetModules()` + `await import()` lại.
 */

const SONIOX_WS_URL_PRODUCTION = "wss://stt-rt.soniox.com/transcribe-websocket";
const EVIL_WS_URL = "ws://evil.example";
const EVIL_BASE_URL = "http://evil.example";

/** Options truyền vào `new Anthropic(...)` của lần khởi tạo gần nhất. */
const anthropicCtorSpy = vi.fn<(opts: Record<string, unknown>) => void>();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: vi.fn(async () => ({
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
      })),
    };
    constructor(opts: Record<string, unknown>) {
      anthropicCtorSpy(opts);
    }
  }
  return { default: FakeAnthropic };
});

// getServerEnv() throw khi `window` tồn tại (test env = jsdom) và cần secret thật —
// thay bằng stub: test này chỉ quan tâm tới `baseURL`, không quan tâm key.
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    SONIOX_API_KEY: "test-soniox-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    ANTHROPIC_BASE_URL: undefined,
  }),
}));

/** Re-import `soniox/connection` sau khi env đã stub → đọc const đánh giá lúc import. */
async function loadSonioxWsUrl(): Promise<string> {
  vi.resetModules();
  const mod = await import("@/lib/soniox/connection");
  return mod.SONIOX_WS_URL;
}

/** Re-import `llm/client` (bỏ `cachedClient` cũ), gọi 1 lần để ép khởi tạo Anthropic. */
async function loadAnthropicCtorOptions(): Promise<Record<string, unknown>> {
  vi.resetModules();
  anthropicCtorSpy.mockClear();
  const { callClaude } = await import("@/lib/llm/client");
  await callClaude({ task: "suggest", system: "s", userContent: "u", maxTokens: 16 });
  expect(anthropicCtorSpy).toHaveBeenCalledTimes(1);
  return anthropicCtorSpy.mock.calls[0][0];
}

describe("env override guard (H1)", () => {
  beforeEach(() => {
    anthropicCtorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("test_soniox_ws_url_production_with_env_override_ignores_override", async () => {
    // Arrange — attacker set biến env trên Vercel (prod), không deploy lại code
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SONIOX_WS_URL", EVIL_WS_URL);

    // Act
    const url = await loadSonioxWsUrl();

    // Assert — override bị bỏ qua hoàn toàn, luôn là endpoint Soniox thật
    expect(url).toBe(SONIOX_WS_URL_PRODUCTION);
    expect(url).not.toContain("evil.example");
  });

  test("test_soniox_ws_url_production_without_env_override_uses_production_endpoint", async () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SONIOX_WS_URL", undefined);

    // Act
    const url = await loadSonioxWsUrl();

    // Assert
    expect(url).toBe(SONIOX_WS_URL_PRODUCTION);
  });

  test("test_soniox_ws_url_test_env_with_env_override_uses_override", async () => {
    // Arrange — đường E2E: mock WS server local
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SONIOX_WS_URL", "ws://127.0.0.1:8787/mock-soniox");

    // Act
    const url = await loadSonioxWsUrl();

    // Assert
    expect(url).toBe("ws://127.0.0.1:8787/mock-soniox");
  });

  test("test_soniox_ws_url_development_with_env_override_uses_override", async () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SONIOX_WS_URL", EVIL_WS_URL);

    // Act
    const url = await loadSonioxWsUrl();

    // Assert — ngoài prod thì override có hiệu lực (đúng chủ đích)
    expect(url).toBe(EVIL_WS_URL);
  });

  test("test_soniox_ws_url_development_without_env_override_falls_back_to_production_endpoint", async () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SONIOX_WS_URL", undefined);

    // Act
    const url = await loadSonioxWsUrl();

    // Assert
    expect(url).toBe(SONIOX_WS_URL_PRODUCTION);
  });

  test("test_anthropic_client_production_with_base_url_override_ignores_override", async () => {
    // Arrange — override này sẽ kéo cả header ANTHROPIC_API_KEY sang host lạ
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_BASE_URL", EVIL_BASE_URL);

    // Act
    const opts = await loadAnthropicCtorOptions();

    // Assert — prod luôn dùng base URL thật của SDK (undefined)
    expect(opts.baseURL).toBeUndefined();
  });

  test("test_anthropic_client_test_env_with_base_url_override_uses_override", async () => {
    // Arrange — đường E2E: mock Anthropic server local
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8788");

    // Act
    const opts = await loadAnthropicCtorOptions();

    // Assert
    expect(opts.baseURL).toBe("http://127.0.0.1:8788");
  });

  test("test_anthropic_client_development_with_base_url_override_uses_override", async () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ANTHROPIC_BASE_URL", EVIL_BASE_URL);

    // Act
    const opts = await loadAnthropicCtorOptions();

    // Assert — ngoài prod thì override có hiệu lực (đúng chủ đích)
    expect(opts.baseURL).toBe(EVIL_BASE_URL);
  });

  test("test_anthropic_client_production_without_base_url_override_passes_undefined", async () => {
    // Arrange
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);

    // Act
    const opts = await loadAnthropicCtorOptions();

    // Assert
    expect(opts.baseURL).toBeUndefined();
    expect(opts.apiKey).toBe("test-anthropic-key");
  });
});
