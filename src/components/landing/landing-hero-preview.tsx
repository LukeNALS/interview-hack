/**
 * Mock màn live thu nhỏ cho landing — thuần CSS/div (không ảnh, không JS): cột
 * "TRẢ LỜI GỢI Ý" đúng như màn live thật. Nội dung transcript là cảnh demo
 * Việt–Nhật cố định, không dịch theo switcher (mô phỏng buổi thật).
 */

interface PreviewRow {
  who: string;
  text: string;
  trans?: string;
  live?: boolean;
}

interface PreviewScene {
  clock: string;
  rows: PreviewRow[];
  paneLabel: string;
  cards: { text: string; highlight: boolean }[];
}

const SCENE: PreviewScene = {
  clock: "BUỔI PHỎNG VẤN CỦA BẠN · 00:08:12 · ĐANG GHI",
  rows: [
    { who: "Người phỏng vấn", text: "強みは何だと思いますか？", trans: "Bạn nghĩ điểm mạnh của mình là gì?" },
    { who: "Bạn", text: "Em nghĩ là khả năng tối ưu API dưới tải lớn ạ…", live: true },
  ],
  paneLabel: "TRẢ LỜI GỢI Ý",
  cards: [
    {
      text: "Nêu 1 điểm mạnh gắn với vị trí: tối ưu API — kèm ví dụ ngắn (giảm thời gian phản hồi ở dự án gần nhất) rồi dừng, đừng liệt kê tràn lan.",
      highlight: true,
    },
    { text: "Nếu bị hỏi tiếp về điểm yếu: chọn điểm thật + cách bạn đang khắc phục.", highlight: false },
  ],
};

export function LandingPreview() {
  const scene = SCENE;
  return (
    <div className="mt-7 overflow-hidden rounded-btn-lg border border-divider bg-app/80 shadow-cta">
      {/* Thanh cửa sổ giả */}
      <div className="flex items-center gap-1.5 border-b border-divider px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-danger/60" />
        <span className="size-2.5 rounded-full bg-warning/60" />
        <span className="size-2.5 rounded-full bg-success/60" />
        <span className="ml-3 text-[10.5px] tracking-[.08em] text-faint">{scene.clock}</span>
      </div>
      <div className="grid gap-0 sm:grid-cols-[1fr_250px]">
        {/* Transcript */}
        <div className="flex flex-col gap-3 px-5 py-4 text-left">
          {scene.rows.map((row, i) => (
            <div key={i}>
              <div className="text-[10px] font-bold tracking-[.14em] text-label">{row.who.toUpperCase()}</div>
              <div className="mt-0.5 text-[13px] leading-[1.55] text-bright">
                {row.text}
                {row.live ? (
                  <span className="ml-1 inline-block h-[13px] w-[2px] animate-pulse bg-accent align-middle" />
                ) : null}
              </div>
              {row.trans ? (
                <div className="mt-0.5 text-[12px] leading-[1.5] text-secondary">
                  <span className="mr-1.5 rounded-chip border border-control px-1 text-[9.5px] text-muted">VI</span>
                  {row.trans}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {/* Cột gợi ý trả lời */}
        <div className="border-t border-divider px-4 py-4 text-left sm:border-l sm:border-t-0">
          <div className="text-[10px] font-bold tracking-[.14em] text-label">{scene.paneLabel}</div>
          {scene.cards.map((card) => (
            <div
              key={card.text}
              className={`mt-2 rounded-btn px-3 py-2.5 text-[12.5px] leading-[1.55] ${
                card.highlight ? "border border-accent/40 bg-label/10 text-bright" : "border border-divider text-secondary"
              }`}
            >
              {card.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
