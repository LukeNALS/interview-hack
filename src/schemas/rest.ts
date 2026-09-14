import { z } from "zod";

/** Zod DTO cho REST — Interview Hack chỉ dành cho ứng viên (mọi session kind='candidate'). */

export const sessionModeSchema = z.enum(["online", "direct"]);
export const langCodeSchema = z.enum(["vi", "ja", "en"]);
export const speakerSchema = z.enum(["interviewer", "candidate"]);

export const createSessionSchema = z.object({
  candidate_name: z.string().min(1).optional(),
  position: z.string().min(1).optional(),
  mode: sessionModeSchema,
  jd_text: z.string().optional(),
  wish_text: z.string().optional(),
  /** Chỉ còn chế độ ứng viên — literal + default để mọi caller (cũ lẫn mới) luôn
   *  tạo session kind='candidate' (plan candidate-only 2026-09-14). */
  kind: z.literal("candidate").default("candidate"),
});

/**
 * POST /sessions/:id/start body — chốt chế độ buổi phỏng vấn NGAY lúc chuyển sang live
 * (BUG #4: trước đây card "online/trực tiếp" ở màn setup chỉ `patch()` vào store client,
 * server giữ nguyên `mode` lúc TẠO session, còn màn live lại đọc `mode` từ server ->
 * chọn "trực tiếp" vẫn chạy nhánh online và bị hỏi chia sẻ tab giữa buổi).
 * `mode` optional để caller cũ (POST không body) không vỡ: thiếu -> giữ nguyên mode cũ.
 */
export const startSessionSchema = z.object({
  mode: sessionModeSchema.optional(),
});

/** POST /end body — hiện không còn field nào (buổi kết thúc thẳng, không tạo báo cáo);
 *  giữ object rỗng thay vì bỏ hẳn parse để route không vỡ khi caller cũ còn gửi JSON body. */
export const endSessionSchema = z.object({});

/**
 * PATCH /api/admin/users/[id] — sửa quota/plan (admin phase 01 F4). Chặt:
 * quota 0-999 int; plan slug ngắn (cột text tự do, hiện chỉ 'free' — không bịa
 * enum để khỏi khoá giá trị tương lai). Ít nhất 1 field.
 */
export const adminPatchUserSchema = z
  .object({
    free_sessions_left: z.number().int().min(0).max(999).optional(),
    plan: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_-]+$/, "plan chỉ gồm a-z, 0-9, '_', '-'")
      .optional(),
  })
  .refine((v) => v.free_sessions_left !== undefined || v.plan !== undefined, {
    message: "Cần ít nhất một field để sửa",
  });

export const sonioxKeyRequestSchema = z.object({
  /** số connection cần cấp key (online = 4, direct = 2). */
  connections: z.number().int().min(1).max(4).optional().default(2),
});

export const translationsInputSchema = z.object({
  vi: z.string().nullable().optional(),
  ja: z.string().nullable().optional(),
  en: z.string().nullable().optional(),
});

export const ingestUtteranceSchema = z.object({
  client_utt_id: z.string().min(1),
  speaker: speakerSchema,
  lang: langCodeSchema.nullable(),
  text_orig: z.string().min(1),
  translations: translationsInputSchema.optional(),
  question_id: z.string().uuid().nullable().optional(),
  t_start_ms: z.number().int().nonnegative().optional(),
  t_end_ms: z.number().int().nonnegative().optional(),
  /** true khi connection `en` chưa kịp trả bản dịch lúc emit (align.ts bù sau — P05). */
  en_pending: z.boolean().optional().default(false),
});

/** POST /utterances body — batch finals, bắt buộc client gộp ≤5/req + debounce 300ms (P05 non-functional). */
export const ingestUtterancesRequestSchema = z.object({
  utterances: z.array(ingestUtteranceSchema).min(1).max(5),
});

export const backfillUtterancesQuerySchema = z.object({
  after_seq: z.coerce.number().int().nonnegative().default(0),
});

// ===== Envelope lỗi chung — {error:{code, message}} =====
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
});

/** Body POST /sessions/:id/answer-hint (N13b/candidate) — card đang hiện chỉ là ngữ cảnh chống trùng, cap chặt. */
export const suggestRequestSchema = z.object({
  visible_suggestions: z.array(z.string().trim().max(500)).max(4).default([]),
});
