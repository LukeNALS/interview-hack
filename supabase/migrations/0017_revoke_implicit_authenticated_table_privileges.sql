-- 0017 — thu hồi quyền bảng NGẦM của `authenticated`, chỉ giữ đúng bộ quyền 0002/0011 dự định.
--
-- VÌ SAO (phát hiện 2026-09-15): 0002 chỉ GRANT cho `authenticated`, KHÔNG revoke trước
-- (chỉ `anon` có `revoke all`). Môi trường nào tự cấp default privileges cho `authenticated`
-- (Supabase CLI `latest` trên CI, project cloud tạo sớm) thì role này còn DELETE `reports`,
-- UPDATE/DELETE `report_jobs`/`export_jobs`/`audit_log`, DELETE `profiles`, SELECT
-- `rate_limit_counters` → mất lớp chặn privilege, chỉ còn RLS. CI "DB-backed" đỏ 6 test
-- `rls-matrix` vì đúng lý do này. Ngoài ra `authenticated` còn TRUNCATE/TRIGGER/REFERENCES
-- trên MỌI bảng public (kể cả prod) — TRUNCATE bỏ qua RLS, app không cần tới.
--
-- KHÔNG gãy gì: app ghi các bảng server-only bằng service_role (bypass grant); quyền app
-- cần qua PostgREST được cấp lại y hệt 0002. Idempotent: môi trường đã đúng thì không đổi gì.

-- Bảng chỉ server ghi: thu hồi hết rồi cấp lại đúng quyền app dùng (khớp 0002).
revoke all on public.reports, public.report_jobs, public.export_jobs, public.audit_log,
  public.rate_limit_counters from authenticated;
grant select, update on public.reports to authenticated;
grant select on public.report_jobs to authenticated;
grant select, insert on public.export_jobs to authenticated;
grant select on public.audit_log to authenticated;
-- rate_limit_counters: không cấp gì — chỉ service_role.

-- profiles: KHÔNG `revoke all` (sẽ xoá luôn grant cột `update (name)` của 0011) —
-- chỉ thu hồi các quyền mức bảng nằm ngoài dự định.
revoke insert, delete on public.profiles from authenticated;

-- Quyền không bảng nào cần qua PostgREST; TRUNCATE còn bỏ qua RLS.
revoke truncate, references, trigger on all tables in schema public from authenticated;
