import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

// Route/lib dưới test có `import "server-only"` — mock rỗng để chạy được dưới vitest (P05).
vi.mock("server-only", () => ({}));

/**
 * Integration test cho POST/GET /api/sessions/:id/utterances — mock Supabase
 * (bespoke, không dùng chainable generic vì insert/select/update rẽ nhánh
 * khác chain shape) + mock broadcast-server (không gọi Realtime thật), AAA,
 * khớp tên test phase-05 bước 17.
 */

interface ExistingRow {
  id: string;
  seq: number;
  client_utt_id: string;
  speaker: string;
  lang: string | null;
  text_orig: string;
  question_id: string | null;
  t_start_ms: number | null;
}

let sessionRow: Record<string, unknown> | null = null;
let existingUtterances: ExistingRow[] = [];
let seqCounter = 0;
let insertedIdCounter = 0;

const insertSpy = vi.fn();
const utteranceUpdateSpy = vi.fn();
const sessionUpdateSpy = vi.fn();

function makeFakeClient() {
  const from = vi.fn((table: string) => {
    if (table === "sessions") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: sessionRow, error: null }) }) }),
        update: (payload: Record<string, unknown>) => {
          sessionUpdateSpy(payload);
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    }
    if (table === "utterances") {
      return {
        select: () => ({
          eq: () => ({ in: async () => ({ data: existingUtterances, error: null }) }),
        }),
        insert: (payload: Record<string, unknown>) => {
          insertSpy(payload);
          return {
            select: () => ({
              single: async () => {
                insertedIdCounter += 1;
                return { data: { ...payload, id: `utt-${insertedIdCounter}` }, error: null };
              },
            }),
          };
        },
        update: (payload: Record<string, unknown>) => {
          utteranceUpdateSpy(payload);
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    }
    throw new Error(`bảng không mong đợi trong test: ${table}`);
  });

  const rpc = vi.fn(async (name: string) => {
    if (name === "next_utterance_seq") {
      seqCounter += 1;
      return { data: seqCounter, error: null };
    }
    // bump_rate_limit — fail-open mặc định (true), không test rate-limit-exceeded ở đây.
    return { data: true, error: null };
  });

  const auth = { getUser: vi.fn(async () => ({ data: { user: { id: "user-1", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null })) };
  return { from, rpc, auth };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => makeFakeClient()),
}));

const broadcastEventMock = vi.fn(async () => undefined);
vi.mock("@/lib/realtime/broadcast-server", () => ({
  broadcastEvent: broadcastEventMock,
}));

const { POST } = await import("@/app/api/sessions/[id]/utterances/route");

function liveSessionRow(overrides: Record<string, unknown> = {}) {
  return { id: "session-1", status: "live", started_at: new Date().toISOString(), cap_seconds: 5400, ...overrides };
}

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function makeCtx(id = "session-1") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/sessions/:id/utterances", () => {
  beforeEach(() => {
    sessionRow = liveSessionRow();
    existingUtterances = [];
    seqCounter = 0;
    insertedIdCounter = 0;
    insertSpy.mockClear();
    utteranceUpdateSpy.mockClear();
    sessionUpdateSpy.mockClear();
    broadcastEventMock.mockClear();
  });

  test("test_utterances_ingest_after_cap_marks_session_ended_and_returns_409", async () => {
    // Arrange — started_at 6000s trước (> cap_seconds=5400)
    sessionRow = liveSessionRow({ started_at: new Date(Date.now() - 6000 * 1000).toISOString() });
    const body = {
      utterances: [
        {
          client_utt_id: "c1",
          speaker: "interviewer",
          lang: "vi",
          text_orig: "Bạn giới thiệu bản thân",
          t_start_ms: 5900_000,
          t_end_ms: 5903_000,
        },
      ],
    };
    // Act
    const res = await POST(makeRequest(body), makeCtx());
    const responseBody = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(409);
    expect(responseBody.error.code).toBe("session_ended");
    expect(sessionUpdateSpy).toHaveBeenCalledWith({ status: "processing", ended_reason: "cap" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  test("test_utterances_ingest_duplicate_client_utt_id_does_not_create_second_row", async () => {
    // Arrange — utterance "c1" đã tồn tại với seq=7
    existingUtterances = [
      {
        id: "utt-existing-1",
        seq: 7,
        client_utt_id: "c1",
        speaker: "interviewer",
        lang: "vi",
        text_orig: "Xin chào",
        question_id: null,
        t_start_ms: 1000,
      },
    ];
    const body = {
      utterances: [
        {
          client_utt_id: "c1",
          speaker: "interviewer",
          lang: "vi",
          text_orig: "Xin chào",
          translations: { en: "Hello (bù sau)" },
          t_start_ms: 1000,
          t_end_ms: 2000,
        },
      ],
    };
    // Act
    const res = await POST(makeRequest(body), makeCtx());
    const responseBody = (await res.json()) as { results: { client_utt_id: string; seq: number }[] };
    // Assert
    expect(res.status).toBe(200);
    expect(responseBody.results).toEqual([{ client_utt_id: "c1", seq: 7 }]);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(utteranceUpdateSpy).toHaveBeenCalledWith({
      translations: { vi: null, ja: null, en: "Hello (bù sau)" },
      en_pending: false,
    });
  });

  test("test_utterances_ingest_assigns_monotonic_seq_under_parallel_requests", async () => {
    // Arrange — 2 request khác client_utt_id trên cùng session, gửi "song song"
    const body1 = {
      utterances: [{ client_utt_id: "c1", speaker: "interviewer", lang: "vi", text_orig: "Câu 1", t_start_ms: 0, t_end_ms: 1000 }],
    };
    const body2 = {
      utterances: [{ client_utt_id: "c2", speaker: "candidate", lang: "vi", text_orig: "Câu 2", t_start_ms: 1000, t_end_ms: 2000 }],
    };
    // Act
    const [res1, res2] = await Promise.all([POST(makeRequest(body1), makeCtx()), POST(makeRequest(body2), makeCtx())]);
    const [json1, json2] = await Promise.all([res1.json(), res2.json()]) as [
      { results: { seq: number }[] },
      { results: { seq: number }[] },
    ];
    // Assert — 2 seq riêng biệt, tăng dần (1 và 2, thứ tự bất kỳ)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const seqs = [json1.results[0].seq, json2.results[0].seq].sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);
  });

  test("test_english_only_utterance_stores_null_vi_and_ja_translations", async () => {
    // Arrange — lượt thuần tiếng Anh, chỉ có translations.en
    const body = {
      utterances: [
        {
          client_utt_id: "en-1",
          speaker: "candidate",
          lang: "en",
          text_orig: "I have five years of experience",
          translations: { en: "I have five years of experience" },
          t_start_ms: 5000,
          t_end_ms: 8000,
        },
      ],
    };
    // Act
    const res = await POST(makeRequest(body), makeCtx());
    // Assert
    expect(res.status).toBe(200);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        translations: { vi: null, ja: null, en: "I have five years of experience" },
      }),
    );
  });

  test("test_utterances_ingest_session_not_owned_returns_404", async () => {
    // Arrange — session không tồn tại/không thuộc user (RLS trả 0 dòng)
    sessionRow = null;
    const body = { utterances: [{ client_utt_id: "c1", speaker: "interviewer", lang: "vi", text_orig: "A" }] };
    // Act
    const res = await POST(makeRequest(body), makeCtx("other-session"));
    const responseBody = (await res.json()) as { error: { code: string } };
    // Assert
    expect(res.status).toBe(404);
    expect(responseBody.error.code).toBe("not_found");
  });

  test("test_utterances_ingest_empty_batch_returns_400_validation_error", async () => {
    // Arrange
    const body = { utterances: [] };
    // Act
    const res = await POST(makeRequest(body), makeCtx());
    // Assert
    expect(res.status).toBe(400);
  });
});
