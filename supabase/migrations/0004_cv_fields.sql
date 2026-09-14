-- 0004_cv_fields.sql — cột parse CV trên sessions + bucket Storage 'cv' private.
-- quick_eval jsonb đã có sẵn từ 0001_init.sql (sessions) — không thêm lại.

create type cv_status_type as enum ('none', 'reading', 'done', 'failed');

alter table public.sessions
  add column cv_status cv_status_type not null default 'none',
  add column cv_text text,
  add column cv_file_path text,
  add column cv_error text;

-- Cột mới trên bảng sessions đã có sẵn (grant select,insert,update,delete on
-- public.sessions to authenticated ở 0002_rls.sql) — table-level grant, không
-- cần grant lại theo cột. RLS policy sessions_* (0002) áp dụng nguyên vẹn.

-- ===== Storage bucket 'cv' — private, ≤10MB, PDF/ảnh/DOCX =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cv',
  'cv',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects đã bật RLS mặc định (Supabase-managed) và KHÔNG có policy
-- nào cho bucket 'cv' ở đây → chỉ service-role (bypass RLS) đọc/ghi được.
-- App luôn upload + tạo signed URL qua service-role client (src/lib/storage/cv.ts),
-- ownership check ở tầng route handler (auth.uid() so với sessions.user_id) —
-- 2 lớp phòng thủ giống pattern rate_limit_counters/audit_log.
