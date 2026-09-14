/**
 * Fixture 10 lượt thoại cho mock Soniox — ja (người phỏng vấn) xen kẽ vi (ứng viên),
 * cố ý chứa dấu tiếng Việt đầy đủ + tiếng Nhật để spec i18n-diacritics so text thật.
 * NỘI DUNG CỐ ĐỊNH, KHÔNG random (plan §Risk "E2E dễ vỡ (flaky)").
 */

export interface FixtureTurn {
  /** Ngôn ngữ nguồn — quyết định translation đi về phía nào ở kênh canonical. */
  lang: "ja" | "vi";
  orig: string;
  /** Bản dịch phía còn lại của cặp two_way (ja↔vi). */
  counterpart: string;
  /** Bản dịch tiếng Anh — kênh `en` one_way. */
  en: string;
}

export const DIACRITICS_VI = "Tổng quan về Chuyển đổi số";
export const DIACRITICS_JA = "御社の課題を伺えますか";

export const FIXTURE_TURNS: FixtureTurn[] = [
  { lang: "ja", orig: "こんにちは、自己紹介をお願いします", counterpart: "Xin chào, hãy tự giới thiệu bản thân", en: "Hello, please introduce yourself" },
  { lang: "vi", orig: "Chào anh, tôi là kỹ sư backend với năm năm kinh nghiệm.", counterpart: "こんにちは、5年経験のバックエンドエンジニアです。", en: "Hello, I am a backend engineer with five years of experience." },
  { lang: "ja", orig: DIACRITICS_JA, counterpart: "Anh có thể cho biết thách thức của công ty không", en: "Could you share the challenges you faced" },
  { lang: "vi", orig: `${DIACRITICS_VI} là trọng tâm của dự án vừa rồi.`, counterpart: "デジタル変革の概要が直近プロジェクトの中心でした。", en: "Digital transformation overview was the focus of the recent project." },
  { lang: "ja", orig: "具体的な数字はありますか", counterpart: "Có con số cụ thể nào không", en: "Do you have concrete numbers" },
  { lang: "vi", orig: "Tôi giảm p95 từ 800ms xuống còn 120ms nhờ đánh chỉ mục lại.", counterpart: "再インデックスによりp95を800msから120msに短縮しました。", en: "I reduced p95 from 800ms to 120ms by reindexing." },
  { lang: "ja", orig: "チームでの役割を教えてください", counterpart: "Hãy cho biết vai trò của anh trong đội", en: "Tell me about your role on the team" },
  { lang: "vi", orig: "Tôi dẫn dắt nhóm bốn người và phụ trách kiến trúc dịch vụ.", counterpart: "4人のチームを率い、サービス設計を担当しました。", en: "I led a team of four and owned the service architecture." },
  { lang: "ja", orig: "最後に質問はありますか", counterpart: "Cuối cùng, anh có câu hỏi nào không", en: "Finally, do you have any questions" },
  { lang: "vi", orig: "Tôi muốn hiểu thêm về lộ trình phát triển sản phẩm.", counterpart: "製品ロードマップについてもっと知りたいです。", en: "I would like to understand the product roadmap." },
];

export interface SonioxToken {
  text: string;
  confidence: number;
  is_final: boolean;
  language?: string;
  speaker?: string;
  start_ms?: number;
  end_ms?: number;
  translation_status?: "original" | "translation";
}

/** Chia text thành vài mảnh để mô phỏng token streaming — cắt theo ĐỘ DÀI CỐ ĐỊNH, không random. */
function chunkText(text: string, pieces: number): string[] {
  const size = Math.ceil(text.length / pieces);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Token partial (chưa `<end>`) — app hiển thị bubble mờ opacity-55. */
export function partialTokens(turn: FixtureTurn, index: number): SonioxToken[] {
  const startMs = index * 4000;
  return chunkText(turn.orig, 3)
    .slice(0, 2)
    .map((text, i) => ({
      text,
      confidence: 0.7,
      is_final: false,
      language: turn.lang,
      speaker: turn.lang === "ja" ? "1" : "2",
      start_ms: startMs + i * 300,
      end_ms: startMs + i * 300 + 280,
      translation_status: "original" as const,
    }));
}

/**
 * Token final của 1 lượt: các mảnh original + các mảnh translation + `<end>`.
 * `channel`:
 *  - `canonical` (two_way ja↔vi) → translation = `counterpart`
 *  - `en` (one_way → en)         → translation = `en`
 */
export function finalTokens(turn: FixtureTurn, index: number, channel: "canonical" | "en"): SonioxToken[] {
  const startMs = index * 4000;
  const speaker = turn.lang === "ja" ? "1" : "2";
  const original = chunkText(turn.orig, 3).map((text, i) => ({
    text,
    confidence: 0.96,
    is_final: true,
    language: turn.lang,
    speaker,
    start_ms: startMs + i * 400,
    end_ms: startMs + i * 400 + 380,
    translation_status: "original" as const,
  }));
  const translated = channel === "canonical" ? turn.counterpart : turn.en;
  const translation = chunkText(translated, 2).map((text) => ({
    text,
    confidence: 0.9,
    is_final: true,
    language: turn.lang,
    speaker,
    translation_status: "translation" as const,
  }));
  return [...original, ...translation, { text: "<end>", confidence: 1, is_final: true }];
}
