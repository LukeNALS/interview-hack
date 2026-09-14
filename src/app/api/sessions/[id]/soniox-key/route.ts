import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api-handler";
import { checkRateLimit, rateLimitError } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getServerEnv } from "@/lib/env";
import { computeElapsedSeconds } from "@/lib/cap-clock";

// Endpoint MỚI (SU AC8), chưa có trong SYSTEM_DESIGN §3 gốc.
// POST /api/sessions/:id/soniox-key → cấp/renew temp key Soniox (TTL 3600s — P05 bước 3).
// requireEmailConfirmed: route tốn phí (mở connection ASR) — bắt buộc email đã xác nhận.

type RouteContext = { params: Promise<{ id: string }> };

const SONIOX_TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
const SONIOX_KEY_EXPIRES_IN_SECONDS = 3600;
// Không set max_session_duration_seconds — hiệu lực tham số này CHƯA xác định (confound với lỗi
// 408 quan sát ở POC, xem docs/soniox-integration-notes.md) nên bỏ qua để tránh cắt sớm ngoài ý muốn.

interface SonioxTempKeyResponse {
  api_key: string;
  expires_at: string;
}

async function fetchSonioxTempKey(): Promise<SonioxTempKeyResponse> {
  const { SONIOX_API_KEY } = getServerEnv();
  const res = await fetch(SONIOX_TEMP_KEY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SONIOX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      usage_type: "transcribe_websocket",
      expires_in_seconds: SONIOX_KEY_EXPIRES_IN_SECONDS,
      single_use: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[soniox-key] Soniox API lỗi", { status: res.status, body: text.slice(0, 500) });
    throw new AppError("Không thể cấp Soniox key — thử lại", 502, "soniox_key_failed");
  }
  return (await res.json()) as SonioxTempKeyResponse;
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

    // fail-OPEN khi 42501 [P07 fix H-1]: đây là CỬA VÀO của cả đường thu âm.
    // Fail-closed ở đây làm ngoại lệ fail-open của /utterances thành vô nghĩa —
    // không lấy được temp key thì không stream nào mở, không có utterance nào
    // để mà cứu. Buổi đang chạy còn tệ hơn: renew() hỏng là stream chết câm.
    const decision = await checkRateLimit({
      key: `soniox-key:${id}`,
      windowSeconds: 3600,
      limit: 60,
      onPermissionDenied: "open",
    });
    if (!decision.allowed) {
      throw rateLimitError(decision.reason, "Vượt giới hạn cấp key trong giờ — thử lại sau");
    }

    const key = await fetchSonioxTempKey();
    return NextResponse.json({ keys: [key.api_key], expires_at: key.expires_at });
  },
  { requireEmailConfirmed: true },
);
