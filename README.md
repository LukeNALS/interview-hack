# Interview Hack

Trợ lý AI cho ỨNG VIÊN đi phỏng vấn: mô tả buổi phỏng vấn sắp tới, vào buổi
online (chia sẻ tab meeting) hoặc trực tiếp — màn live hiện transcript song
ngữ realtime (Việt/Nhật/Anh), và mỗi khi người phỏng vấn đặt câu hỏi, AI gợi
ý một câu trả lời ngắn gọn ngay bên cạnh. Không có báo cáo, không có bộ câu
hỏi — chỉ hỗ trợ ngay trong lúc phỏng vấn.

## Stack

- Next.js 16 (App Router, TypeScript strict) + Tailwind CSS 4
- Supabase (Postgres + Auth + Realtime broadcast)
- Soniox (speech-to-text + dịch realtime) · Anthropic Claude (gợi ý trả lời)
- Vitest + Testing Library (unit/integration), Playwright (E2E)

## Setup

```bash
pnpm install
cp .env.example .env.local   # điền giá trị thật (KHÔNG commit .env.local)
```

Biến môi trường cần thiết — xem `.env.example` (Soniox key, Anthropic key,
Supabase URL + anon key + service-role key, APP_BASE_URL).

## Chạy dev

```bash
supabase start      # local stack — xem supabase/config.toml
pnpm dev             # http://localhost:3000
```

## Test

```bash
pnpm typecheck
pnpm lint
pnpm test           # Vitest (unit + integration) — tự skip suite cần hạ tầng nếu thiếu
pnpm test:db        # retention · sweeper · RLS matrix — đối đầu local stack (cần supabase start)
pnpm test:e2e        # Playwright E2E (Soniox + Claude đều mock)
pnpm test:real       # gọi Claude API THẬT, tốn phí — chạy tay khi cần
pnpm check:secrets   # gate secret (cũng chạy trong CI)
```

`pnpm test:db` tự đọc key từ `supabase status -o json`, và **từ chối chạy nếu
URL không phải localhost**. Không có local stack thì các suite cần DB tự skip
trong `pnpm test`.

## Database (Supabase)

Migrations ở `supabase/migrations/*.sql` — schema, RLS, RPC functions, retention
cron, service_role grants. `supabase db reset` apply toàn bộ theo thứ tự (local).

Generate lại types sau khi đổi schema (cần `SUPABASE_ACCESS_TOKEN` ở local):

```bash
pnpm db:types
```

## Thư mục

```text
src/app/              (auth)/login,signup · (app)/candidate,sessions/[id]/{setup,live} · api/*
src/components/live/  màn "Trong buổi phỏng vấn" — transcript + cột gợi ý trả lời
src/components/landing/ trang giới thiệu `/` (VI/EN/JA)
src/lib/supabase/     server.ts (service-role) · browser.ts · middleware.ts
src/lib/              env.ts (zod-validated) · errors.ts · rate-limit.ts · audit.ts
src/types/            db.ts (generated) · events.ts · api.ts · ui.ts
src/schemas/          events.ts · rest.ts (Zod)
supabase/migrations/  0001..0016_*.sql
tests/                unit/ · integration/ · e2e/
```

Không lưu audio thô ở bất kỳ đâu (chỉ RAM/stream); transcript tự xoá theo
retention_days của mỗi user.
