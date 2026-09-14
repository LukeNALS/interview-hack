import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { AppError, errorResponseBody } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { computeElapsedSeconds, formatElapsedClock } from "@/lib/cap-clock";
import { broadcastEvent } from "@/lib/realtime/broadcast-server";
import { ingestUtteranceSchema, ingestUtterancesRequestSchema, backfillUtterancesQuerySchema } from "@/schemas/rest";
import type { UtteranceFinalEvent, Lang, Translations } from "@/types/events";

// Endpoint MỚI (SU AC8), chưa có trong SYSTEM_DESIGN §3 gốc.
// POST /api/sessions/:id/utterances → ingest batch finals (P05 bước 9); GET → backfill ?after_seq= (bước 10).
export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };
type IngestUtteranceItem = z.infer<typeof ingestUtteranceSchema>;

const MAX_UTTERANCE_BYTES = 8 * 1024;
const BACKFILL_LIMIT = 500;

interface ExistingUtterance {
  id: string;
  seq: number;
  client_utt_id: string | null;
  speaker: "interviewer" | "candidate";
  lang: string | null;
  text_orig: string;
  question_id: string | null;
  t_start_ms: number | null;
}

function normalizeTranslations(input?: { vi?: string | null; ja?: string | null; en?: string | null }): Translations {
  return { vi: input?.vi ?? null, ja: input?.ja ?? null, en: input?.en ?? null };
}

function buildFinalEvent(row: ExistingUtterance, translations: Translations): UtteranceFinalEvent {
  return {
    type: "utterance.final",
    id: row.id,
    seq: row.seq,
    speaker: row.speaker,
    lang: (row.lang as Lang | null) ?? null,
    text_orig: row.text_orig,
    translations,
    question_id: row.question_id,
    time: formatElapsedClock(row.t_start_ms ?? 0),
    client_utt_id: row.client_utt_id,
    t_start_ms: row.t_start_ms,
  };
}

export const POST = withAuth(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("Body JSON không hợp lệ", 400, "validation_error");
  }
  const parsed = ingestUtterancesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ", 400, "validation_error");
  }
  const items: IngestUtteranceItem[] = parsed.data.utterances;
  for (const item of items) {
    if (Buffer.byteLength(JSON.stringify(item), "utf8") > MAX_UTTERANCE_BYTES) {
      throw new AppError("Utterance vượt quá 8KB", 400, "utterance_too_large");
    }
  }

  const supabase = await createServerSupabaseClient();
  const { data: session } = await supabase
    .from("sessions")
    .select("id, status, started_at, cap_seconds")
    .eq("id", id)
    .maybeSingle();
  if (!session) {
    return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
  }

  const elapsed = computeElapsedSeconds(session.started_at);
  if (session.status !== "live" || (elapsed !== null && elapsed > session.cap_seconds)) {
    if (session.status === "live") {
      await supabase.from("sessions").update({ status: "processing", ended_reason: "cap" }).eq("id", id);
    }
    return NextResponse.json(errorResponseBody("session_ended", "Buổi phỏng vấn đã kết thúc"), { status: 409 });
  }

  // `onPermissionDenied: "open"` — NGOẠI LỆ DUY NHẤT của fail-closed [P07 H3]:
  // chặn ingest giữa buổi = MẤT TRANSCRIPT đang thu (client chỉ giữ trong RAM),
  // thiệt hại lớn hơn hẳn việc mất trần rate limit cho tới khi grant được vá.
  const minute = await checkRateLimit({
    key: `utterances:min:${id}`,
    windowSeconds: 60,
    limit: 60,
    onPermissionDenied: "open",
  });
  const burst = await checkRateLimit({
    key: `utterances:burst:${id}`,
    windowSeconds: 10,
    limit: 20,
    onPermissionDenied: "open",
  });
  if (!minute.allowed || !burst.allowed) {
    throw new AppError("Vượt giới hạn ingest — thử lại sau", 429, "rate_limit_exceeded");
  }

  const clientUttIds = items.map((u) => u.client_utt_id);
  const { data: existingRows } = await supabase
    .from("utterances")
    .select("id, seq, client_utt_id, speaker, lang, text_orig, question_id, t_start_ms")
    .eq("session_id", id)
    .in("client_utt_id", clientUttIds);

  const existingMap = new Map<string, ExistingUtterance>();
  for (const row of existingRows ?? []) {
    if (row.client_utt_id) existingMap.set(row.client_utt_id, row as ExistingUtterance);
  }

  const results: { client_utt_id: string; seq: number }[] = [];

  for (const item of items) {
    const translations = normalizeTranslations(item.translations);
    const existing = existingMap.get(item.client_utt_id);

    if (existing) {
      await supabase
        .from("utterances")
        .update({ translations, en_pending: item.en_pending ?? false })
        .eq("id", existing.id);
      results.push({ client_utt_id: item.client_utt_id, seq: existing.seq });
      await broadcastEvent(id, buildFinalEvent(existing, translations));
      continue;
    }

    const { data: seqData, error: seqError } = await supabase.rpc("next_utterance_seq", { p_session: id });
    if (seqError || seqData == null) {
      console.error("[utterances] next_utterance_seq lỗi", { sessionId: id, error: seqError?.message });
      throw new AppError("Không cấp được số thứ tự — thử lại", 500, "internal_error");
    }
    const seq = seqData;

    const { data: inserted, error: insertError } = await supabase
      .from("utterances")
      .insert({
        session_id: id,
        seq,
        client_utt_id: item.client_utt_id,
        speaker: item.speaker,
        lang: item.lang,
        text_orig: item.text_orig,
        translations,
        en_pending: item.en_pending ?? false,
        question_id: item.question_id ?? null,
        t_start_ms: item.t_start_ms ?? null,
        t_end_ms: item.t_end_ms ?? null,
      })
      .select("id, seq, client_utt_id, speaker, lang, text_orig, question_id, t_start_ms")
      .single();

    if (insertError || !inserted) {
      console.error("[utterances] insert lỗi", { sessionId: id, seq, error: insertError?.message });
      throw new AppError("Ghi lượt thoại thất bại — thử lại", 500, "internal_error");
    }

    const row = inserted as ExistingUtterance;
    existingMap.set(item.client_utt_id, row);
    results.push({ client_utt_id: item.client_utt_id, seq: row.seq });
    await broadcastEvent(id, buildFinalEvent(row, translations));
  }

  return NextResponse.json({ results });
});

export const GET = withAuth(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const parsedQuery = backfillUtterancesQuerySchema.safeParse({
    after_seq: url.searchParams.get("after_seq") ?? undefined,
  });
  if (!parsedQuery.success) {
    throw new AppError(parsedQuery.error.issues[0]?.message ?? "Dữ liệu không hợp lệ", 400, "validation_error");
  }
  const { after_seq } = parsedQuery.data;

  // Backfill trả tới BACKFILL_LIMIT (500) dòng/lần — reconnect loop có thể gọi liên
  // tục, đốt egress + invocation không phanh. Scope theo SESSION như POST (không theo
  // user): backfill là hành vi của 1 buổi, và 2 tab cùng buổi vẫn nên chung ngân sách.
  // Ngưỡng rộng hơn POST vì reconnect thật cần vài nhịp kéo bù transcript [P07].
  // fail-open khi 42501 như đường POST — backfill là đường KHÔI PHỤC transcript
  // sau reconnect, chặn nó cũng là mất transcript của buổi đang chạy [P07 H3].
  const backfill = await checkRateLimit({
    key: `utterances:backfill:${id}`,
    windowSeconds: 60,
    limit: 30,
    onPermissionDenied: "open",
  });
  if (!backfill.allowed) {
    throw new AppError("Vượt giới hạn tải lại transcript — thử lại sau", 429, "rate_limit_exceeded");
  }

  const supabase = await createServerSupabaseClient();
  const { data: session } = await supabase.from("sessions").select("id").eq("id", id).maybeSingle();
  if (!session) {
    return NextResponse.json(errorResponseBody("not_found", "Session không tồn tại"), { status: 404 });
  }

  const { data, error } = await supabase
    .from("utterances")
    .select("*")
    .eq("session_id", id)
    .gt("seq", after_seq)
    .order("seq", { ascending: true })
    .limit(BACKFILL_LIMIT);
  if (error) {
    throw new AppError("Không đọc được transcript — thử lại", 500, "internal_error");
  }

  const rows = data ?? [];
  const next_after_seq = rows.length === BACKFILL_LIMIT ? rows[rows.length - 1].seq : null;
  return NextResponse.json({ utterances: rows, next_after_seq });
});
