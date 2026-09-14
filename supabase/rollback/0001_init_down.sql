-- 0001_init_down.sql — rollback 0001_init.sql

drop table if exists public.rate_limit_counters;
drop table if exists public.audit_log;
drop table if exists public.export_jobs;
drop table if exists public.report_jobs;
drop table if exists public.reports;
drop table if exists public.insights;
drop table if exists public.suggestions;
drop table if exists public.utterances;
drop table if exists public.questions;
drop table if exists public.sessions;

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.profiles;

drop type if exists export_status;
drop type if exists report_job_status;
drop type if exists report_status;
drop type if exists suggestion_status;
drop type if exists speaker_role;
drop type if exists question_status;
drop type if exists question_source;
drop type if exists ended_reason_type;
drop type if exists session_status;
drop type if exists session_mode;
