import type { UiInsight, UiSuggestion, UiUtterance, UttLang } from "@/types/ui";

interface RawUtterance {
  pv: 0 | 1;
  lang: UttLang;
  orig: string;
  vi?: string;
  ja?: string;
  en?: string;
  time: string;
  /** Lượt cuối đang stream dở (partial, chưa có timestamp). */
  slow?: boolean;
}

/** Port nguyên văn từ RAW() file design — dữ liệu mô phỏng, không PII thật. */
export const RAW_UTTERANCES: readonly RawUtterance[] = [
  { pv: 1, lang: "JA", orig: "まず、簡単に自己紹介をお願いできますか。", vi: "Trước tiên, anh có thể giới thiệu ngắn gọn về bản thân được không?", en: "First of all, could you briefly introduce yourself?", time: "00:02:14" },
  { pv: 0, lang: "VI", orig: "Vâng, em là Tuấn. Em có 5 năm kinh nghiệm backend với Java và Spring Boot, chủ yếu làm hệ thống thương mại điện tử cho khách hàng Nhật.", ja: "はい、トゥアンです。JavaとSpring Bootで5年のバックエンド経験があり、主に日本のお客様向けのECシステムを開発してきました。", en: "Yes, I'm Tuan. I have 5 years of backend experience with Java and Spring Boot, mostly building e-commerce systems for Japanese clients.", time: "00:02:21" },
  { pv: 1, lang: "JA", orig: "直近のプロジェクトで、あなたが担当した部分を詳しく教えてください。", vi: "Trong dự án gần nhất, phần nào do anh trực tiếp đảm nhận? Hãy nói cụ thể hơn.", en: "In your most recent project, which part were you directly responsible for? Please be specific.", time: "00:03:05" },
  { pv: 0, lang: "VI", orig: "Dự án gần nhất là hệ thống quản lý kho cho một chuỗi bán lẻ. Em phụ trách API phân hệ tồn kho và tối ưu truy vấn khi dữ liệu lên khoảng 10 triệu bản ghi.", ja: "直近は小売チェーン向けの倉庫管理システムです。在庫APIと、約1,000万件規模のデータのクエリ最適化を担当しました。", en: "My latest project was a warehouse management system for a retail chain. I owned the inventory APIs and query optimization at around 10 million records.", time: "00:03:18" },
  { pv: 1, lang: "JA", orig: "そのとき、一番大きな課題は何でしたか。", vi: "Khi đó, khó khăn lớn nhất là gì?", en: "What was the biggest challenge back then?", time: "00:04:02" },
  { pv: 0, lang: "VI", orig: "Báo cáo tồn kho cuối ngày chạy hơn 40 phút. Em đánh lại index, gom truy vấn và chuyển phần tổng hợp sang chạy nền — cuối cùng còn khoảng 4 phút.", ja: "日次の在庫レポートに40分以上かかっていました。インデックスの再設計、クエリの集約、集計のバッチ化で約4分まで短縮しました。", en: "The end-of-day inventory report took over 40 minutes. I rebuilt the indexes, consolidated queries and moved aggregation to a background job — down to about 4 minutes.", time: "00:04:15" },
  { pv: 1, lang: "JA", orig: "日本語はどのくらい使えますか。", vi: "Anh dùng được tiếng Nhật đến mức nào?", en: "How well can you use Japanese?", time: "00:05:30" },
  { pv: 0, lang: "JA", orig: "はい、少し話せます。前の会社で日本のお客様と直接やり取りしていました。", vi: "Vâng, em nói được một chút. Ở công ty trước em trao đổi trực tiếp với khách hàng Nhật.", en: "Yes, I can speak a little. At my previous company I communicated directly with Japanese clients.", time: "00:05:41" },
  { pv: 0, lang: "VI", orig: "Về đọc viết thì em đọc được tài liệu kỹ thuật, còn hội thoại nhanh thì em vẫn đang luyện thêm mỗi tuần.", ja: "読み書きは技術文書なら対応できますが、速い会話は毎週練習を続けているところです。", en: "For reading and writing I can handle technical documents; for fast conversation I'm still practicing every week.", time: "", slow: true },
];

/** Transcript giữa buổi — port từ seedUtts() file design (lượt cuối partial). */
export function mockUtterances(): UiUtterance[] {
  return RAW_UTTERANCES.map((u, i) => ({
    id: i + 1,
    pv: u.pv,
    lang: u.lang,
    orig: u.orig,
    vi: u.vi ?? u.orig,
    ja: u.ja ?? u.orig,
    en: u.en ?? u.orig,
    disp: u.orig,
    partial: !!u.slow,
    time: u.time,
  }));
}

/** 2 card "TRẢ LỜI GỢI Ý" đang hiện — port từ seedLive() file design. */
export const MOCK_SUGGESTIONS: readonly UiSuggestion[] = [
  { id: 1, text: "Anh Tuấn trực tiếp viết phần tối ưu truy vấn hay cả nhóm cùng làm?" },
  { id: 2, text: 'Kết quả "còn 4 phút" — hỏi cách đo và điều kiện tải thực tế.' },
];

/** Dòng thời gian "NHẬN ĐỊNH CHUNG" — port từ seedLive() file design. */
export const MOCK_INSIGHTS: readonly UiInsight[] = [
  { time: "08:12", text: "Trả lời có cấu trúc, hay dẫn số liệu." },
  { time: "12:40", text: "Nên kiểm chứng tiếng Nhật bằng 1–2 câu hỏi trực tiếp bằng tiếng Nhật." },
];
