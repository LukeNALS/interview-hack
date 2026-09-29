import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api-handler";
import { checkRateLimit, rateLimitError } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getServerEnv } from "@/lib/env";
import { computeElapsedSeconds } from "@/lib/cap-clock";

// Endpoint MỚI (SU AC8), chưa có trong SYSTEM_DESIGN §3 gốc.
// POST /api/sessions/:id/soniox-key → cấp 1 CẶP temp key Soniox SINGLE-USE (canonical + en):
// mỗi key mở đúng 1 connection, dùng lại ⇒ 401 sau khi connect (E1). Không còn renew — client xin
// cặp MỚI ở mỗi lần start/reconnect.
// requireEmailConfirmed: route tốn phí (mở connection ASR) — bắt buộc email đã xác nhận.

type RouteContext = { params: Promise<{ id: string }> };

const SONIOX_TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
// TTL chỉ chặn MỞ stream mới (E3); stream đang chạy sống tiếp qua expiry. Ngắn để key rò không dùng được lâu.
const SONIOX_KEY_TTL_SECONDS = 60;
// Giới hạn provider của max_session_duration_seconds: 1–18000.
const SONIOX_MAX_SESSION_DURATION_SECONDS = 18000;
// Duration đếm PER STREAM từ lúc connect (E4/E5): hết ⇒ server cắt cứng 403 temp_api_key_session_expired.
// Đặt = thời gian còn lại của cap ⇒ vượt cap tối đa = TTL (key mint lúc T, mở trễ nhất T+TTL).
const KEYS_PER_PAIR = 2;

interface SonioxTempKeyResponse {
  api_key: string;
  expires_at: string;
}

function sonioxKeyFailed(): AppError {
  return new AppError("Không thể cấp Soniox key — thử lại", 502, "soniox_key_failed");
}

async function fetchSonioxTempKey(params: { remainingSeconds: number; sessionId: string }): Promise<SonioxTempKeyResponse> {
  const { SONIOX_API_KEY } = getServerEnv();
  const res = await fetch(SONIOX_TEMP_KEY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SONIOX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      usage_type: "transcribe_websocket",
      expires_in_seconds: SONIOX_KEY_TTL_SECONDS,
      single_use: true,
      // remaining là số nguyên ≥ 1: cap_seconds int, elapsed đã floor, guard cap_reached chạy trước.
      max_session_duration_seconds: Math.min(params.remainingSeconds, SONIOX_MAX_SESSION_DURATION_SECONDS),
      // UUID phiên, không PII, gắn phía server ⇒ đối soát chi phí theo phiên qua GET /v1/usage-logs.
      client_reference_id: params.sessionId,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[soniox-key] Soniox API lỗi", { status: res.status, body: text.slice(0, 500) });
    throw sonioxKeyFailed();
  }
  const key = (await res.json()) as Partial<SonioxTempKeyResponse>;
  if (typeof key.api_key !== "string" || key.api_key === "" || typeof key.expires_at !== "string") {
    console.error("[soniox-key] Soniox API trả body thiếu api_key/expires_at");
    throw sonioxKeyFailed();
  }
  return { api_key: key.api_key, expires_at: key.expires_at };
}

export const POST = withAuth(
  async (_req: NextRequest, ctx: RouteContext) => {
    const { id } = await ctx.params;
    const supabase = await createServerSupabaseClient();

    const { data: session } = await supabase
      .from("sessions")
      .select("id, status, started_at, cap_seconds")
      .eq("id", id)
      .maybeSingle();
    if (!session) {
      return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
    }
    if (session.status !== "live") {
      throw new AppError("Session không ở trạng thái live", 409, "invalid_session_status");
    }

    const elapsed = computeElapsedSeconds(session.started_at);
    if (elapsed === null || elapsed >= session.cap_seconds) {
      throw new AppError("Đã chạm giới hạn thời lượng buổi phỏng vấn", 403, "cap_reached");
    }

    // fail-CLOSED khi rate limit KHÔNG kiểm được — cả lỗi quyền (42501) lẫn lỗi hạ tầng (RPC
    // timeout/5xx) ⇒ 503 rate_limit_unavailable, KHÔNG gọi Soniox. Đảo quyết định fail-open ở
    // P07 H-1 CHỈ cho route này: nay endpoint tốn phí thật (mỗi key = 1 stream) và không còn
    // renew định kỳ để "cứu" stream đang chạy; client báo lỗi rõ + reconnect backoff thay vì chết
    // câm. `/utterances`, `/start`, `/end` giữ nguyên fail-open (chặn = mất transcript / kẹt live).
    const decision = await checkRateLimit({
      key: `soniox-key:${id}`,
      windowSeconds: 3600,
      limit: 60,
      onPermissionDenied: "closed",
      onInfraError: "closed",
    });
    if (!decision.allowed) {
      throw rateLimitError(decision.reason, "Vượt giới hạn cấp key trong giờ — thử lại sau");
    }

    const remainingSeconds = session.cap_seconds - elapsed;
    const startedAt = performance.now();
    // 1 request = 1 pair; 2 mint song song nên độ trễ không cộng dồn. Một mint lỗi ⇒ 502 và bỏ
    // key còn lại (chưa mở stream = không tính phí).
    const keys = await Promise.all(
      Array.from({ length: KEYS_PER_PAIR }, () => fetchSonioxTempKey({ remainingSeconds, sessionId: id })),
    );
    // Không log key/expires_at — chỉ số đo độ trễ mint (P04 đọc trên Vercel Logs).
    console.info("[soniox-key] issued", {
      session_id: id,
      soniox_ms: Math.round(performance.now() - startedAt),
      remaining_s: remainingSeconds,
    });

    const earliestExpiry = keys.reduce((min, k) => (Date.parse(k.expires_at) < Date.parse(min) ? k.expires_at : min), keys[0].expires_at);
    return NextResponse.json({ keys: keys.map((k) => k.api_key), expires_at: earliestExpiry });
  },
  { requireEmailConfirmed: true },
);
