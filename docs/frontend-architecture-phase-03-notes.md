# Frontend Architecture — Phase 03 Notes

Nguồn: port 5 màn (prep/setup/live/wait/report) từ file design HTML sang
Next.js, user approved 2026-08-11. 46 file component, 5 hook, 109 test pass.
Đọc trước khi động vào FE ở phase sau.

## Cấu trúc

- `src/app/(app)/sessions/[id]/{prep,setup,live,wait,report}/page.tsx` —
  route thật, `id` hiện fix cứng `"demo"` (mock). `(app)/layout.tsx` chỉ bọc
  `min-h-dvh flex flex-col`, KHÔNG render header chung — mỗi màn tự render
  header riêng (prep 60px, live 62px…).
- `src/components/{common,prep,setup,live,wait,report}/` — 1 thư mục/màn +
  `common/` dùng chung (header, banner, modal, toast, icons…).
- `src/hooks/` — `use-toast`, `use-narrow`, `use-streaming-text` (hiệu ứng
  gõ chữ transcript), `use-auto-scroll`, `use-drag-reorder` (kéo sắp xếp câu
  hỏi).
- `src/stores/session-store.ts` — Zustand, 1 store phẳng cho toàn bộ UI
  state 1 buổi phỏng vấn.
- `src/lib/state-machine.ts` — transitions `prep→setup→live→wait→report` +
  `assertScreenAllowed` theo `SessionStatus` server. **CHƯA wire vào page**
  (P04 sẽ wire — xem mục Lưu ý bên dưới).
- `src/mocks/*` — data giả (session, questions, utterances, report), thay
  bằng TanStack Query hooks ở P04.

## Token layer — cấm hex thô trong .tsx

Mọi màu đi qua `src/styles/tokens.css` (`:root` CSS vars + `@theme inline`
map sang Tailwind class `bg-panel` / `text-muted` / `border-card`…). Thêm
màu mới → thêm vào `tokens.css`, KHÔNG viết hex trực tiếp trong component.
Alpha dùng opacity modifier Tailwind (`border-accent/40`), không thêm biến
alpha riêng. Font 2 family: `font-sans` (Be Vietnam Pro, UI mặc định) và
`font-jp` (Noto Sans JP, dùng ở đoạn transcript gốc tiếng Nhật) — khai báo ở
`layout.tsx` qua `next/font`, subset `vietnamese` bắt buộc cho BVP.

## Breakpoint duy nhất — 1100px qua `use-narrow`

Toàn app chỉ 1 breakpoint (màn live: 3 cột → 1 cột + tab pill), không thêm
breakpoint Tailwind khác. `useNarrow()` (`src/hooks/use-narrow.ts`) dùng
`useSyncExternalStore` + `matchMedia`, SSR trả `false` (mặc định 3 cột) để
tránh hydration mismatch. Đổi ngưỡng → sửa `NARROW_BREAKPOINT_PX`, không
hardcode `1100` nơi khác.

## Store vs local state

`useSessionStore` (Zustand) giữ state cần chia sẻ giữa nhiều component
trong cùng buổi (câu hỏi, utterance, suggestion, toast, cờ UI theo màn…).
State chỉ dùng nội bộ 1 component (vd mở/đóng dropdown riêng) để `useState`
tại chỗ, không đẩy hết lên store. `patch()` là setter chung cho field đơn
giản; action riêng (`toggleMust`, `reorderQuestions`…) cho logic có điều
kiện.

## Mock swap plan cho P04

`src/mocks/{session,questions,utterances,report}.ts` là nguồn data P03.
P04 thay bằng TanStack Query hooks gọi `src/app/api/sessions/[id]/*`
route đã có sẵn (chưa nối FE). Chưa thêm dependency `@tanstack/react-query`
— P04 tự thêm. Giữ nguyên UI/type contract (`src/types/ui.ts`) khi swap,
chỉ đổi nguồn data.

**Cập nhật P04 (done 2026-08-11):** chỉ màn `prep` (`prep-form-screen`,
`prep-results-screen`, `question-list`) đã swap sang hook thật
(`use-session`, `use-cv-upload`, `use-generate-questions`, `use-questions`
— `src/hooks/`) + xóa `mockQuestions` khỏi luồng prep. `setup/live/wait/report`
**vẫn dùng mock** (`MOCK_SESSION`, `mockQuestions`, `mockReport`,
`mockUtterances`…) — chưa đổi ở P04, còn nguyên như P03. Xem
`docs/backend-llm-cv-architecture-phase-04-notes.md` cho API/BE đã có.

## Quy ước test (RTL)

`vitest.config.ts` KHÔNG bật `globals: true` → mọi test tự import
`describe/it/test/expect` từ `vitest`. RTL không tự cleanup giữa các test
(vì không có global `afterEach` do testing-library/react cung cấp sẵn) →
mỗi file test có component phải tự:
```ts
afterEach(() => cleanup());
```
Xem mẫu ở `tests/unit/prep-form.test.tsx`. Bỏ sót → leak DOM giữa test,
lỗi "multiple elements" khó hiểu.

## Gotcha: box-sizing design vs app

File design HTML render `content-box` (mặc định browser); app dùng
Tailwind Preflight → `border-box` toàn cục. Kích thước cố định port từ
design (vd `max-w-[860px]`, `w-[520px]`) vì vậy SAI kích thước thật nếu để
`border-box` (padding/border bị trừ vào trong). Đã bù bằng class
`box-content` ở đúng 8 chỗ: `prep-shell`, `setup-screen`, `tab-guide`,
`wait-screen`, `modal`, `live-suggestion-column`, `pdf-export-menu`,
`report-screen`. Thêm khung mới có width cố định port từ design → kiểm tra
có cần `box-content` không, đừng mặc định bỏ qua.

## Lưu ý cho phase sau

- **P04 (done 2026-08-11)**: `SessionScreenGuard` (bọc `assertScreenAllowed`)
  đã wire vào cả 5 page (`prep/setup/live/wait/report/page.tsx`, xem
  `src/app/(app)/sessions/[id]/session-screen-guard.tsx`). Lúc P04 note này
  viết **vẫn inert** vì `GET /api/sessions/:id` còn stub 501. **Cập nhật:**
  route đã triển khai thật từ P05 (200 full session row, xem
  `docs/live-flow-architecture-phase-05-notes.md`) — guard đã có hiệu lực
  từ đó, không cần sửa gì thêm ở page hay guard.
- **P05**: memo hoá `LiveTranscriptBubble`
  (`src/components/live/live-transcript-bubble.tsx`) — khi nối stream
  Soniox thật, mỗi utterance mới re-render toàn bộ danh sách bubble nếu
  không memo, nặng khi transcript dài.
