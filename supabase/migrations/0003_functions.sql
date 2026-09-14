-- 0003_functions.sql — RPC atomic, security definer, search_path=public.

-- ===== debit_free_session: trừ 1 buổi free lúc start, raise khi hết quota =====
create or replace function public.debit_free_session(p_session uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_left int;
  v_already_debited boolean;
begin
  -- Khóa row session TRƯỚC khi check quota_debited — 2 request start song song
  -- thì request sau chờ lock, thấy quota_debited=true và raise (chặn double-debit,
  -- review P02 CRITICAL-2; cùng pattern với refund_free_session).
  select user_id, quota_debited into v_user_id, v_already_debited
    from public.sessions where id = p_session
    for update;

  if v_user_id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  if v_user_id <> auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;
  if v_already_debited then
    raise exception 'session % đã trừ quota rồi', p_session using errcode = 'P0001';
  end if;

  -- khóa row profile tránh race giữa 2 request start song song
  select free_sessions_left into v_left from public.profiles where id = v_user_id for update;

  if v_left is null then
    raise exception 'profile % không tồn tại', v_user_id using errcode = 'P0002';
  end if;
  if v_left <= 0 then
    raise exception 'hết buổi free' using errcode = 'P0001';
  end if;

  update public.profiles set free_sessions_left = free_sessions_left - 1 where id = v_user_id
    returning free_sessions_left into v_left;
  update public.sessions set quota_debited = true where id = p_session;

  return v_left;
end;
$$;

-- ===== refund_free_session: hoàn buổi <5 phút, chỉ 1 lần =====
create or replace function public.refund_free_session(p_session uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_quota_debited boolean;
  v_quota_refunded boolean;
  v_duration int;
  v_left int;
begin
  select user_id, quota_debited, quota_refunded, duration_sec
    into v_user_id, v_quota_debited, v_quota_refunded, v_duration
    from public.sessions where id = p_session for update;

  if v_user_id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  if v_user_id <> auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;
  if not v_quota_debited or v_quota_refunded or coalesce(v_duration, 0) >= 300 then
    raise exception 'session % không đủ điều kiện hoàn buổi free', p_session using errcode = 'P0001';
  end if;

  update public.profiles set free_sessions_left = free_sessions_left + 1 where id = v_user_id
    returning free_sessions_left into v_left;
  update public.sessions set quota_refunded = true where id = p_session;

  return v_left;
end;
$$;

-- ===== next_utterance_seq: cấp seq atomic, tránh race 2 luồng ingest =====
create or replace function public.next_utterance_seq(p_session uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_seq int;
begin
  select user_id into v_user_id from public.sessions where id = p_session;

  if v_user_id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  if v_user_id <> auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;

  update public.sessions set last_seq = last_seq + 1 where id = p_session
    returning last_seq into v_seq;

  return v_seq;
end;
$$;

-- ===== get_shared_report: đọc report + utterances qua share token, không cần đăng nhập =====
create or replace function public.get_shared_report(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_result jsonb;
begin
  select id into v_session_id from public.sessions where share_token = p_token;
  if v_session_id is null then
    raise exception 'share link không hợp lệ' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'session', jsonb_build_object(
      'id', s.id,
      'candidate_name', s.candidate_name,
      'position', s.position,
      'started_at', s.started_at,
      'ended_at', s.ended_at,
      'duration_sec', s.duration_sec
    ),
    'report', to_jsonb(r.*),
    'utterances', coalesce((
      select jsonb_agg(to_jsonb(u.*) order by u.seq)
      from public.utterances u where u.session_id = s.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.sessions s
  left join public.reports r on r.session_id = s.id
  where s.id = v_session_id;

  return v_result;
end;
$$;

-- ===== bump_rate_limit: cửa sổ cố định (fixed window), true nếu chưa vượt limit =====
create or replace function public.bump_rate_limit(p_key text, p_window interval, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count int;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / extract(epoch from p_window)) * extract(epoch from p_window)
  );

  insert into public.rate_limit_counters (key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (key, window_start) do update
    set count = public.rate_limit_counters.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

-- ===== Quyền thực thi: authenticated cho RPC theo user; anon+authenticated cho share =====
revoke all on function public.debit_free_session(uuid) from public;
grant execute on function public.debit_free_session(uuid) to authenticated;

revoke all on function public.refund_free_session(uuid) from public;
grant execute on function public.refund_free_session(uuid) to authenticated;

revoke all on function public.next_utterance_seq(uuid) from public;
grant execute on function public.next_utterance_seq(uuid) to authenticated;

revoke all on function public.get_shared_report(text) from public;
grant execute on function public.get_shared_report(text) to anon, authenticated;

revoke all on function public.bump_rate_limit(text, interval, int) from public;
grant execute on function public.bump_rate_limit(text, interval, int) to authenticated, service_role;
