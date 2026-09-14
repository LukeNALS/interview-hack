import type { Metadata } from "next";
import { Be_Vietnam_Pro, Noto_Sans_JP } from "next/font/google";
import "./globals.css";

// Toàn bộ UI: Be Vietnam Pro (400–800). Subset "vietnamese" bắt buộc để render
// đủ dấu tiếng Việt (latin-ext không phủ hết dấu tổ hợp).
const beVietnamPro = Be_Vietnam_Pro({
  variable: "--font-bvp",
  subsets: ["latin", "latin-ext", "vietnamese"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

// Text tiếng Nhật: Noto Sans JP (variable font, phủ 400/500/700).
// Glyph JP được Google Fonts phục vụ qua unicode-range — next/font không có
// subset "japanese" cho font này, chỉ cần khai báo latin làm preload.
const notoSansJP = Noto_Sans_JP({
  variable: "--font-nsjp",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Interview Hack",
  description:
    "Trợ lý phỏng vấn Việt–Nhật: transcript song ngữ realtime, gợi ý đào sâu và báo cáo sau buổi.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="vi"
      className={`${beVietnamPro.variable} ${notoSansJP.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
