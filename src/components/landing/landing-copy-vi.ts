import type { LandingCopy } from "./landing-i18n";

/** Copy landing tiếng Việt — bản gốc (SSR mặc định; e2e anchor bám bản này). */
export const LANDING_COPY_VI: LandingCopy = {
  nav: { login: "Đăng nhập", signup: "Dùng thử miễn phí" },
  hero: {
    badge: "TRỢ LÝ PHỎNG VẤN CHO ỨNG VIÊN",
    titleTop: "Đi phỏng vấn",
    titleBottom: "tự tin hơn",
    sub: "Mô tả buổi phỏng vấn sắp tới — khi người phỏng vấn đặt câu hỏi, AI gợi ý câu trả lời ngay bên cạnh transcript.",
    ctaPrimary: "Dùng thử miễn phí",
    ctaSecondary: "Đăng nhập",
    note: "3 buổi miễn phí · không cần thẻ · Việt – Nhật – Anh",
  },
  stats: [
    { value: "3", label: "buổi miễn phí, không cần thẻ" },
    { value: "Realtime", label: "gợi ý hiện ngay khi câu hỏi vừa dứt" },
    { value: "3", label: "ngôn ngữ Việt · Nhật · Anh" },
    { value: "90 ngày", label: "dữ liệu tự xoá, bạn kiểm soát" },
  ],
  features: {
    kicker: "CÁCH INTERVIEW HACK GIÚP BẠN",
    heading: "Gợi ý trả lời ngay khi được hỏi",
    sub: "Mô tả buổi phỏng vấn sắp tới — khi người phỏng vấn đặt câu hỏi, gợi ý trả lời dễ hiểu hiện ngay bên cạnh transcript.",
    features: [
      {
        title: "Mô tả buổi làm ngữ cảnh",
        body: "Vài dòng về vị trí, công ty, chủ đề là đủ — mọi gợi ý bám đúng buổi phỏng vấn của bạn, không chung chung.",
      },
      {
        title: "Gợi ý trả lời dễ hiểu",
        body: "Câu hỏi vừa dứt, AI đưa một câu trả lời ngắn gọn, văn nói tự nhiên — đọc lướt rồi tự diễn đạt theo cách của mình.",
      },
      {
        title: "Transcript song ngữ để ôn lại",
        body: "Nghe không kịp câu tiếng Nhật/tiếng Anh? Transcript dịch realtime ngay trong buổi, và còn đó sau buổi để bạn ôn lại.",
      },
    ],
    flow: ["Mô tả buổi phỏng vấn", "Vào buổi online / trực tiếp", "Nhận gợi ý trả lời", "Ôn lại transcript"],
    cta: "Bắt đầu buổi phỏng vấn",
  },
  modes: {
    heading: "DÙNG ĐƯỢC CHO CẢ HAI KIỂU PHỎNG VẤN",
    cards: [
      {
        name: "Phỏng vấn online",
        body: "Chia sẻ tab meeting (Meet/Zoom/Teams) — máy tự tách giọng theo nguồn: mic là bạn, tab là người phỏng vấn. Không cần bot tham gia cuộc họp.",
      },
      {
        name: "Phỏng vấn trực tiếp",
        body: "Một chiếc laptop đặt giữa bàn là đủ — thu cả hai phía qua micro, tự nhận diện ai đang nói.",
      },
    ],
  },
  faq: {
    heading: "CÂU HỎI THƯỜNG GẶP",
    items: [
      {
        q: "Dữ liệu buổi phỏng vấn được xử lý thế nào?",
        a: "Âm thanh được phiên âm qua Soniox và phân tích qua Anthropic Claude; transcript lưu trên hạ tầng Supabase và tự xoá sau 90 ngày (tuỳ chỉnh được). Chúng tôi không lưu file ghi âm. Hãy tuân thủ quy định ghi âm (nếu có) của nơi bạn phỏng vấn.",
      },
      {
        q: "Gợi ý trả lời có phải đọc y nguyên không?",
        a: "Không nên. Gợi ý chỉ là ý chính để bạn tham khảo — đọc lướt rồi tự diễn đạt theo cách nói của mình sẽ tự nhiên hơn nhiều.",
      },
      {
        q: "Dùng thử có mất phí không?",
        a: "Mỗi tài khoản có 3 buổi phỏng vấn miễn phí, không cần thẻ. Buổi dưới 5 phút (thử máy, lỗi kỹ thuật) được tự động hoàn lượt.",
      },
      {
        q: "Người phỏng vấn hỏi tiếng Nhật/tiếng Anh, tôi đọc tiếng Việt được không?",
        a: "Được — transcript hiển thị nguyên văn kèm bản dịch Việt/Nhật/Anh theo lựa chọn của bạn, cả trong buổi lẫn sau buổi.",
      },
    ],
  },
  ctaBlock: {
    title: "Buổi phỏng vấn tới, thử ngay",
    sub: "Tạo tài khoản trong 30 giây — 3 buổi đầu miễn phí, đủ để bạn thấy khác biệt trước buổi phỏng vấn tiếp theo.",
    button: "Bắt đầu miễn phí",
  },
  footer: {
    line1: "GỢI Ý CHỈ MANG TÍNH THAM KHẢO — BẠN LUÔN LÀ NGƯỜI QUYẾT ĐỊNH CÂU TRẢ LỜI.",
    line2: "Dữ liệu buổi phỏng vấn tự xoá sau 90 ngày · Hãy tuân thủ quy định ghi âm của nơi bạn phỏng vấn.",
  },
};
