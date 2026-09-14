-- 0002_rls_down.sql — rollback 0002_rls.sql
--
-- Không hoàn tác "revoke all ... from anon" — đó là hardening (đóng lỗ hổng default
-- privileges platform tự cấp), khôi phục lại là mở lỗ hổng, không phải rollback đúng nghĩa.

revoke select, insert, update, delete on public.export_jobs from authenticated;
revoke select on public.audit_log from authenticated;
revoke select on public.report_jobs from authenticated;
revoke select, update on public.reports from authenticated;
revoke select, insert, update, delete on public.insights from authenticated;
revoke select, insert, update, delete on public.suggestions from authenticated;
revoke select, insert, update, delete on public.utterances from authenticated;
revoke select, insert, update, delete on public.questions from authenticated;
revoke select, insert, update, delete on public.sessions from authenticated;
revoke select, update on public.profiles from authenticated;
revoke usage on schema public from authenticated;

drop policy if exists audit_log_select_own on public.audit_log;
drop policy if exists export_jobs_insert_own on public.export_jobs;
drop policy if exists export_jobs_select_own on public.export_jobs;
drop policy if exists report_jobs_select_own on public.report_jobs;
drop policy if exists reports_update_own on public.reports;
drop policy if exists reports_select_own on public.reports;
drop policy if exists insights_delete_own on public.insights;
drop policy if exists insights_update_own on public.insights;
drop policy if exists insights_insert_own on public.insights;
drop policy if exists insights_select_own on public.insights;
drop policy if exists suggestions_delete_own on public.suggestions;
drop policy if exists suggestions_update_own on public.suggestions;
drop policy if exists suggestions_insert_own on public.suggestions;
drop policy if exists suggestions_select_own on public.suggestions;
drop policy if exists utterances_delete_own on public.utterances;
drop policy if exists utterances_update_own on public.utterances;
drop policy if exists utterances_insert_own on public.utterances;
drop policy if exists utterances_select_own on public.utterances;
drop policy if exists questions_delete_own on public.questions;
drop policy if exists questions_update_own on public.questions;
drop policy if exists questions_insert_own on public.questions;
drop policy if exists questions_select_own on public.questions;
drop policy if exists sessions_delete_own on public.sessions;
drop policy if exists sessions_update_own on public.sessions;
drop policy if exists sessions_insert_own on public.sessions;
drop policy if exists sessions_select_own on public.sessions;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_select_self on public.profiles;

alter table public.rate_limit_counters disable row level security;
alter table public.audit_log disable row level security;
alter table public.export_jobs disable row level security;
alter table public.report_jobs disable row level security;
alter table public.reports disable row level security;
alter table public.insights disable row level security;
alter table public.suggestions disable row level security;
alter table public.utterances disable row level security;
alter table public.questions disable row level security;
alter table public.sessions disable row level security;
alter table public.profiles disable row level security;
