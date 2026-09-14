-- 0005_live_fields_down.sql — rollback 0005_live_fields.sql

alter table public.sessions
  drop column if exists cap_seconds;
