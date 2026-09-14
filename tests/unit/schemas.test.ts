import { describe, expect, test } from "vitest";
import {
  serverEventSchema,
  clientEventSchema,
  utterancePartialSchema,
  utteranceFinalSchema,
  suggestionNewSchema,
  insightNewSchema,
  connDegradedSchema,
  connRestoredSchema,
  suggestionAckSchema,
  questionSelectSchema,
} from "@/schemas/events";
import {
  createSessionSchema,
  ingestUtteranceSchema,
  backfillUtterancesQuerySchema,
  errorBodySchema,
} from "@/schemas/rest";

// ===== Event contract — 6 server event =====
describe("events schema — 6 server event round-trip", () => {
  const cases: Array<[string, unknown]> = [
    [
      "utterance.partial",
      { type: "utterance.partial", id: "u1", speaker: "interviewer", lang: "ja", text: "こんにちは" },
    ],
    [
      "utterance.final",
      {
        type: "utterance.final",
        id: "u1",
        seq: 3,
        speaker: "candidate",
        lang: "vi",
        text_orig: "Chào anh",
        translations: { ja: "こんにちは", en: null },
        question_id: null,
        time: "00:04:15",
      },
    ],
    ["suggestion.new", { type: "suggestion.new", id: "s1", text: "Gợi ý trả lời ngắn gọn" }],
    ["insight.new", { type: "insight.new", at: "12:40", text: "Trả lời chi tiết, tự tin" }],
    ["conn.degraded", { type: "conn.degraded" }],
    ["conn.restored", { type: "conn.restored" }],
  ];

  test.each(cases)("test_events_schema_server_event_%s_roundtrip_ok", (_type, payload) => {
    // Arrange — payload mẫu đúng shape
    // Act
    const result = serverEventSchema.safeParse(payload);
    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(payload);
    }
  });

  test("test_events_schema_all_contract_events_roundtrip_ok", () => {
    // Arrange + Act + Assert — toàn bộ 6 event parse thành công qua union
    for (const [, payload] of cases) {
      expect(serverEventSchema.safeParse(payload).success).toBe(true);
    }
  });

  test("test_events_schema_individual_event_schemas_match_union_member", () => {
    expect(utterancePartialSchema.safeParse(cases[0][1]).success).toBe(true);
    expect(utteranceFinalSchema.safeParse(cases[1][1]).success).toBe(true);
    expect(suggestionNewSchema.safeParse(cases[2][1]).success).toBe(true);
    expect(insightNewSchema.safeParse(cases[3][1]).success).toBe(true);
    expect(connDegradedSchema.safeParse(cases[4][1]).success).toBe(true);
    expect(connRestoredSchema.safeParse(cases[5][1]).success).toBe(true);
  });
});

// ===== Event contract — 2 client event =====
describe("events schema — 2 client event round-trip", () => {
  test("test_events_schema_suggestion_ack_roundtrip_ok", () => {
    const payload = { type: "suggestion.ack", id: "s1", action: "added" };
    const result = clientEventSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(suggestionAckSchema.safeParse(payload).success).toBe(true);
  });

  test("test_events_schema_question_select_roundtrip_ok", () => {
    const payload = { type: "question.select", id: "q1" };
    const result = clientEventSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(questionSelectSchema.safeParse(payload).success).toBe(true);
  });

  test("test_events_schema_unknown_event_type_rejected", () => {
    const result = clientEventSchema.safeParse({ type: "hack.attempt", id: "x" });
    expect(result.success).toBe(false);
  });
});

// ===== REST DTO chính =====
describe("rest schema — REST DTO chính", () => {
  test("test_rest_schema_create_session_valid_input_ok", () => {
    const result = createSessionSchema.safeParse({ mode: "direct", candidate_name: "Nguyễn A" });
    expect(result.success).toBe(true);
  });

  test("test_rest_schema_create_session_invalid_mode_rejected", () => {
    const result = createSessionSchema.safeParse({ mode: "hybrid" });
    expect(result.success).toBe(false);
  });

  test("test_rest_schema_create_session_kind_defaults_and_locks_to_candidate", () => {
    // Interview Hack chỉ ứng viên — `kind` là literal "candidate" với default (P0 candidate-only).
    const result = createSessionSchema.safeParse({ mode: "online" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe("candidate");
    expect(createSessionSchema.safeParse({ mode: "online", kind: "interviewer" }).success).toBe(false);
  });

  test("test_rest_schema_ingest_utterance_valid_payload_ok", () => {
    const result = ingestUtteranceSchema.safeParse({
      client_utt_id: "c1",
      speaker: "interviewer",
      lang: "en",
      text_orig: "Tell me about yourself",
      translations: { vi: null, ja: null },
    });
    expect(result.success).toBe(true);
  });

  test("test_rest_schema_backfill_query_coerces_after_seq_string_to_number", () => {
    const result = backfillUtterancesQuerySchema.safeParse({ after_seq: "5" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.after_seq).toBe(5);
    }
  });

  test("test_rest_schema_backfill_query_defaults_after_seq_zero", () => {
    const result = backfillUtterancesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.after_seq).toBe(0);
    }
  });

  test("test_rest_schema_error_body_matches_not_implemented_shape", () => {
    const result = errorBodySchema.safeParse({ error: { code: "not_implemented" } });
    expect(result.success).toBe(true);
  });
});
