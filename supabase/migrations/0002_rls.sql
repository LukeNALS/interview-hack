-- 0002_rls.sql — bật RLS trên mọi bảng, policy theo auth.uid(). KHÔNG có policy cho anon
-- (share link đọc report đi qua RPC security definer get_shared_report, xem 0003).

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.questions enable row level security;
alter table public.utterances enable row level security;
alter table public.suggestions enable row level security;
alter table public.insights enable row level security;
alter table public.reports enable row level security;
alter table public.report_jobs enable row level security;
alter table public.export_jobs enable row level security;
alter table public.audit_log enable row level security;
alter table public.rate_limit_counters enable row level security;

-- ===== profiles: tự đọc/sửa hồ sơ mình =====
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ===== sessions: chủ session toàn quyền CRUD =====
create policy sessions_select_own on public.sessions
  for select using (user_id = auth.uid());
create policy sessions_insert_own on public.sessions
  for insert with check (user_id = auth.uid());
create policy sessions_update_own on public.sessions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sessions_delete_own on public.sessions
  for delete using (user_id = auth.uid());

-- ===== questions =====
create policy questions_select_own on public.questions
  for select using (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = auth.uid()));
create policy questions_insert_own on public.questions
  for insert with check (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = auth.uid()));
create policy questions_update_own on public.questions
  for update using (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = auth.uid()));
create policy questions_delete_own on public.questions
  for delete using (exists (select 1 from public.sessions s where s.id = questions.session_id and s.user_id = auth.uid()));

-- ===== utterances =====
create policy utterances_select_own on public.utterances
  for select using (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = auth.uid()));
create policy utterances_insert_own on public.utterances
  for insert with check (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = auth.uid()));
create policy utterances_update_own on public.utterances
  for update using (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = auth.uid()));
create policy utterances_delete_own on public.utterances
  for delete using (exists (select 1 from public.sessions s where s.id = utterances.session_id and s.user_id = auth.uid()));

-- ===== suggestions =====
create policy suggestions_select_own on public.suggestions
  for select using (exists (select 1 from public.sessions s where s.id = suggestions.session_id and s.user_id = auth.uid()));
create policy suggestions_insert_own on public.suggestions
  for insert with check (exists (select 1 from public.sessions s where s.id = suggestions.session_id and s.user_id = auth.uid()));
create policy suggestions_update_own on public.suggestions
  for update using (exists (select 1 from public.sessions s where s.id = suggestions.session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sessions s where s.id = suggestions.session_id and s.user_id = auth.uid()));
create policy suggestions_delete_own on public.suggestions
  for delete using (exists (select 1 from public.sessions s where s.id = suggestions.session_id and s.user_id = auth.uid()));

-- ===== insights =====
create policy insights_select_own on public.insights
  for select using (exists (select 1 from public.sessions s where s.id = insights.session_id and s.user_id = auth.uid()));
create policy insights_insert_own on public.insights
  for insert with check (exists (select 1 from public.sessions s where s.id = insights.session_id and s.user_id = auth.uid()));
create policy insights_update_own on public.insights
  for update using (exists (select 1 from public.sessions s where s.id = insights.session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sessions s where s.id = insights.session_id and s.user_id = auth.uid()));
create policy insights_delete_own on public.insights
  for delete using (exists (select 1 from public.sessions s where s.id = insights.session_id and s.user_id = auth.uid()));

-- ===== reports (insert/delete chỉ server service-role — không cấp policy) =====
create policy reports_select_own on public.reports
  for select using (exists (select 1 from public.sessions s where s.id = reports.session_id and s.user_id = auth.uid()));
create policy reports_update_own on public.reports
  for update using (exists (select 1 from public.sessions s where s.id = reports.session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.sessions s where s.id = reports.session_id and s.user_id = auth.uid()));

-- ===== report_jobs (chỉ đọc tiến độ; ghi bởi service-role) =====
create policy report_jobs_select_own on public.report_jobs
  for select using (exists (select 1 from public.sessions s where s.id = report_jobs.session_id and s.user_id = auth.uid()));

-- ===== export_jobs =====
create policy export_jobs_select_own on public.export_jobs
  for select using (exists (select 1 from public.sessions s where s.id = export_jobs.session_id and s.user_id = auth.uid()));
create policy export_jobs_insert_own on public.export_jobs
  for insert with check (exists (select 1 from public.sessions s where s.id = export_jobs.session_id and s.user_id = auth.uid()));

-- ===== audit_log (đọc log của chính mình; ghi qua service-role/RPC) =====
create policy audit_log_select_own on public.audit_log
  for select using (user_id = auth.uid());

-- ===== rate_limit_counters: KHÔNG policy nào — chỉ service-role (bypass RLS) truy cập. =====

-- ===== GRANT bảng cho role authenticated =====
-- RLS chỉ lọc ROW; role vẫn cần GRANT cấp bảng mới truy cập được qua PostgREST/data API
-- (cloud default hiện KHÔNG tự expose bảng mới — xem supabase/config.toml [api] comment).
-- service_role đã có full access mặc định (Supabase tự cấu hình lúc tạo project) — không cần grant thêm.
grant usage on schema public to authenticated;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select, insert, update, delete on public.questions to authenticated;
grant select, insert, update, delete on public.utterances to authenticated;
grant select, insert, update, delete on public.suggestions to authenticated;
grant select, insert, update, delete on public.insights to authenticated;
grant select, update on public.reports to authenticated; -- insert/delete chỉ server (service-role)
grant select on public.report_jobs to authenticated; -- ghi bởi service-role
grant select, insert on public.export_jobs to authenticated;
grant select on public.audit_log to authenticated; -- ghi bởi service-role/RPC
-- rate_limit_counters: KHÔNG grant cho authenticated/anon — chỉ service-role.

-- anon: chỉ cần EXECUTE trên get_shared_report (SECURITY DEFINER, cấp ở 0003) — không grant bảng nào.
--
-- QUAN TRỌNG: Supabase platform tự động cấp default privileges (SELECT/INSERT/UPDATE/DELETE...)
-- cho role anon TRÊN MỌI bảng public khi tạo project (phát hiện khi chạy tests/integration/rls.test.ts
-- trên project thật — anon vốn KHÔNG lỗi permission mà rơi vào RLS 0-rows, tức chỉ có 1 lớp phòng thủ).
-- REVOKE tường minh ở đây để anon KHÔNG có bất kỳ quyền bảng nào — chỉ còn đường vào qua RPC
-- SECURITY DEFINER (get_shared_report) — 2 lớp phòng thủ (privilege + RLS) thay vì chỉ RLS.
revoke all on all tables in schema public from anon;
