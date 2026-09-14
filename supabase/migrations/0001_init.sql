-- 0001_init.sql — schema chính (enums + bảng). KHÔNG lưu audio thô (chỉ RAM/stream).

create extension if not exists "pgcrypto";

-- ===== Enums =====
create type session_mode as enum ('online', 'direct');
create type session_status as enum ('prep', 'live', 'processing', 'done', 'failed');
create type ended_reason_type as enum ('user', 'cap', 'error');
create type question_source as enum ('generated', 'manual', 'suggestion');
create type question_status as enum ('pending', 'active', 'done', 'weak');
create type speaker_role as enum ('interviewer', 'candidate');
create type suggestion_status as enum ('shown', 'added', 'skipped');
create type report_status as enum ('pending', 'ready', 'failed');
create type report_job_status as enum ('pending', 'running', 'done', 'failed');
create type export_status as enum ('pending', 'ready', 'failed');

-- ===== profiles (1-1 với auth.users — không dựng bảng users riêng) =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  plan text not null default 'free',
  free_sessions_left int not null default 3,
  retention_days int not null default 90,
  created_at timestamptz not null default now()
);

-- Tự tạo profile khi có user mới (giữ 1-1, tránh 2 nguồn sự thật).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== sessions =====
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_name text,
  position text,
  mode session_mode not null default 'direct',
  status session_status not null default 'prep',
  jd_text text,
  wish_text text,
  cv_file_id text,
  quick_eval jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  recording_started_at timestamptz,
  duration_sec int,
  ended_reason ended_reason_type,
  quota_debited boolean not null default false,
  quota_refunded boolean not null default false,
  last_seq int not null default 0,
  share_token text unique,
  translation_lang text not null default 'vi',
  purge_scheduled_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== questions =====
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  order_idx int not null default 0,
  text text not null,
  must boolean not null default false,
  purpose text,
  good_signal text,
  source question_source not null default 'manual',
  status question_status not null default 'pending',
  selected_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

-- ===== utterances (seq = con số duy nhất cho backfill sau reconnect) =====
create table public.utterances (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  seq int not null,
  client_utt_id text,
  speaker speaker_role not null,
  lang char(2),
  text_orig text not null,
  translations jsonb,
  en_pending boolean not null default false,
  question_id uuid references public.questions(id) on delete set null,
  t_start_ms int,
  t_end_ms int,
  created_at timestamptz not null default now(),
  unique (session_id, client_utt_id),
  unique (session_id, seq)
);

-- ===== suggestions (Phase 1 rỗng — contract-only, engine ở Phase 2) =====
create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  text text not null,
  status suggestion_status not null default 'shown',
  created_at timestamptz not null default now()
);

-- ===== insights (Phase 1 rỗng — contract-only, engine ở Phase 2) =====
create table public.insights (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  at_ms int not null,
  text text not null,
  created_at timestamptz not null default now()
);

-- ===== reports (mọi nội dung lưu đủ 3 ngôn ngữ ngay khi sinh) =====
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.sessions(id) on delete cascade,
  status report_status not null default 'pending',
  scorecard jsonb,
  strengths jsonb,
  cautions jsonb,
  evidence jsonb,
  edited_by_user boolean not null default false,
  generated_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== report_jobs (tiến độ 3 bước; data = output/snapshot từng bước) =====
create table public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  step int not null,
  step_status report_job_status not null default 'pending',
  error text,
  data jsonb,
  updated_at timestamptz not null default now(),
  unique (session_id, step)
);

-- ===== export_jobs =====
create table public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  mode text not null,
  langs text[] not null default '{}',
  status export_status not null default 'pending',
  files jsonb,
  created_at timestamptz not null default now()
);

-- ===== audit_log =====
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete cascade,
  entity text not null,
  entity_id uuid,
  action text not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

-- ===== rate_limit_counters (chỉ service-role đọc/ghi) =====
create table public.rate_limit_counters (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- ===== Indexes =====
create index utterances_session_seq_idx on public.utterances (session_id, seq);
create index utterances_session_question_idx on public.utterances (session_id, question_id);
create index sessions_user_created_idx on public.sessions (user_id, created_at);
create index sessions_share_token_idx on public.sessions (share_token);
create index questions_session_order_idx on public.questions (session_id, order_idx);
create index report_jobs_session_idx on public.report_jobs (session_id);
create index export_jobs_session_idx on public.export_jobs (session_id);
create index audit_log_session_idx on public.audit_log (session_id);
create index audit_log_user_idx on public.audit_log (user_id);
