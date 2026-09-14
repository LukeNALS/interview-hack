import { z } from "zod";

/** Zod mirror của `src/types/events.ts` — dùng validate payload Realtime 2 chiều. */

export const langSchema = z.enum(["vi", "ja", "en"]);
export const speakerSchema = z.enum(["interviewer", "candidate"]);

export const translationsSchema = z.object({
  vi: z.string().nullable().optional(),
  ja: z.string().nullable().optional(),
  en: z.string().nullable().optional(),
});

export const utterancePartialSchema = z.object({
  type: z.literal("utterance.partial"),
  id: z.string(),
  speaker: speakerSchema,
  lang: langSchema.nullable(),
  text: z.string(),
});

export const utteranceFinalSchema = z.object({
  type: z.literal("utterance.final"),
  id: z.string(),
  seq: z.number().int().nonnegative(),
  speaker: speakerSchema,
  lang: langSchema.nullable(),
  text_orig: z.string(),
  translations: translationsSchema,
  question_id: z.string().nullable(),
  time: z.string(),
});

export const suggestionNewSchema = z.object({
  type: z.literal("suggestion.new"),
  id: z.string(),
  text: z.string(),
});

export const insightNewSchema = z.object({
  type: z.literal("insight.new"),
  at: z.string(),
  text: z.string(),
});

export const connDegradedSchema = z.object({ type: z.literal("conn.degraded") });
export const connRestoredSchema = z.object({ type: z.literal("conn.restored") });

/** 7 server event — discriminated union theo `type`. */
export const serverEventSchema = z.discriminatedUnion("type", [
  utterancePartialSchema,
  utteranceFinalSchema,
  suggestionNewSchema,
  insightNewSchema,
  connDegradedSchema,
  connRestoredSchema,
]);

export const suggestionAckSchema = z.object({
  type: z.literal("suggestion.ack"),
  id: z.string(),
  action: z.enum(["added", "skipped"]),
});

export const questionSelectSchema = z.object({
  type: z.literal("question.select"),
  id: z.string(),
});

/** 2 client event — discriminated union theo `type`. */
export const clientEventSchema = z.discriminatedUnion("type", [
  suggestionAckSchema,
  questionSelectSchema,
]);

export type ServerEventInput = z.infer<typeof serverEventSchema>;
export type ClientEventInput = z.infer<typeof clientEventSchema>;
