-- 0004_cv_fields_down.sql — rollback 0004_cv_fields.sql

delete from storage.buckets where id = 'cv';

alter table public.sessions
  drop column if exists cv_error,
  drop column if exists cv_file_path,
  drop column if exists cv_text,
  drop column if exists cv_status;

drop type if exists cv_status_type;
