-- 0006_retention_cron.sql — retention purge + abandoned-session sweeper qua pg_cron/pg_net.
--
-- Contract (đọc kỹ trước khi wave sau đụng vào):
-- - list_expired_sessions(): SELECT-only, KHÔNG xoá gì. storage_paths là text[]
--   mỗi phần tử dạng "<bucket>:<path>" (bucket ∈ {cv, exports}) — Edge Function
--   parse tiền tố trước dấu ':' để biết bucket, phần còn lại là path thật trong
--   storage.objects. Quy ước này CHỈ có ở đây, không có ở nơi khác trong repo.
-- - export_jobs.files lưu SIGNED URL đầy đủ (xem src/lib/storage/export-files.ts
--   + route export-pdf), KHÔNG phải path trần như sessions.cv_file_path — hàm
--   dưới đây tự bóc path ra khỏi URL bằng regexp (đoạn giữa "/object/sign/exports/"
--   và dấu "?").
-- - purge_sessions(ids): xoá cứng bảng sessions, cascade lo phần còn lại (FK từ
--   0001_init.sql). Gọi hàm này SAU KHI đã xoá xong Storage — path DUY NHẤT xoá
--   dữ liệu khách là qua Edge Function purge-expired, KHÔNG gọi RPC xoá trực tiếp
--   từ cron hay bất kỳ đâu khác.
-- - sweep_abandoned_sessions(): auto-end session 'live' bỏ rơi quá (cap_seconds+600)s.
--   Gọi refund_free_session bên trong — dựa vào tính chất auth.uid() trả NULL khi
--   không có JWT context (cron/management API), khiến check "v_user_id <> auth.uid()"
--   trong refund_free_session (0003_functions.sql) không raise (NULL trong IF = false)
--   → cho phép cron gọi hộ dù không phải request của chính user. Đây LÀ hành vi có
--   chủ đích, không phải lỗ hổng mới — refund_free_session vẫn tự guard double-refund
--   qua quota_refunded.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ===== list_expired_sessions: liệt kê session hết hạn lưu trữ theo retention_days =====
create or replace function public.list_expired_sessions()
returns table(session_id uuid, storage_paths text[])
language sql
security definer
set search_path = public
stable
as $$
  select
    s.id as session_id,
    array_remove(
      (
        case when s.cv_file_path is not null then array['cv:' || s.cv_file_path] else array[]::text[] end
        ||
        coalesce(
          (
            select array_agg(distinct 'exports:' || regexp_replace(elem, '^.*/object/sign/exports/([^?]+).*$', '\1'))
            from public.export_jobs ej
            cross join lateral jsonb_array_elements_text(coalesce(ej.files, '[]'::jsonb)) as elem
            where ej.session_id = s.id
              and elem ~ '/object/sign/exports/'
          ),
          array[]::text[]
        )
      ),
      null
    ) as storage_paths
  from public.sessions s
  join public.profiles p on p.id = s.user_id
  where coalesce(s.ended_at, s.created_at) < now() - (p.retention_days * interval '1 day');
$$;

revoke all on function public.list_expired_sessions() from public;
revoke all on function public.list_expired_sessions() from anon;
revoke all on function public.list_expired_sessions() from authenticated;
grant execute on function public.list_expired_sessions() to service_role;

-- ===== purge_sessions: xoá cứng theo id, cascade FK lo bảng con =====
create or replace function public.purge_sessions(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.sessions where id = any(p_ids);
$$;

revoke all on function public.purge_sessions(uuid[]) from public;
revoke all on function public.purge_sessions(uuid[]) from anon;
revoke all on function public.purge_sessions(uuid[]) from authenticated;
grant execute on function public.purge_sessions(uuid[]) to service_role;

-- ===== sweep_abandoned_sessions: auto-end session live bỏ rơi quá cap_seconds+600s =====
create or replace function public.sweep_abandoned_sessions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_last_utt_end_ms int;
  v_duration_sec int;
begin
  for v_row in
    select id, started_at, quota_debited
    from public.sessions
    where status = 'live'
      and started_at is not null
      and now() - started_at > (cap_seconds + 600) * interval '1 second'
    for update skip locked
  loop
    -- Ưu tiên t_end_ms utterance cuối (buổi bỏ rơi sớm vẫn hoàn quota đúng theo
    -- thời lượng thực nói chuyện), fallback elapsed wall-clock khi không có utterance.
    select max(t_end_ms) into v_last_utt_end_ms
      from public.utterances where session_id = v_row.id;

    if v_last_utt_end_ms is not null then
      v_duration_sec := v_last_utt_end_ms / 1000;
    else
      v_duration_sec := greatest(0, extract(epoch from (now() - v_row.started_at))::int);
    end if;

    update public.sessions
      set ended_at = now(),
          duration_sec = v_duration_sec,
          status = 'processing',
          ended_reason = 'cap'
      where id = v_row.id;

    insert into public.report_jobs (session_id, step, step_status)
      values (v_row.id, 0, 'pending')
      on conflict (session_id, step) do nothing;

    if v_duration_sec < 300 and v_row.quota_debited then
      begin
        perform public.refund_free_session(v_row.id);
      exception when others then
        -- Không chặn sweep các session khác nếu hoàn quota lỗi (vd race hiếm với refund thủ công).
        raise notice 'sweep_abandoned_sessions: refund lỗi cho session %: %', v_row.id, sqlerrm;
      end;
    end if;
  end loop;
end;
$$;

revoke all on function public.sweep_abandoned_sessions() from public;
revoke all on function public.sweep_abandoned_sessions() from anon;
revoke all on function public.sweep_abandoned_sessions() from authenticated;
grant execute on function public.sweep_abandoned_sessions() to service_role;

-- ===== cron schedule (idempotent — unschedule trước nếu đã tồn tại) =====
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'sweep-abandoned') then
    perform cron.unschedule('sweep-abandoned');
  end if;
  if exists (select 1 from cron.job where jobname = 'purge-expired') then
    perform cron.unschedule('purge-expired');
  end if;
end;
$do$;

-- Mỗi 15 phút: auto-end session live bỏ rơi.
select cron.schedule(
  'sweep-abandoned',
  '*/15 * * * *',
  $job$select public.sweep_abandoned_sessions();$job$
);

-- 17:00 UTC hàng ngày (= 02:00 JST) — gọi Edge Function purge-expired qua pg_net.
-- Header Authorization đọc từ Vault TẠI THỜI ĐIỂM CHẠY (không hardcode secret nào
-- trong migration) — đường xoá DUY NHẤT là Edge Function, cron KHÔNG gọi thẳng
-- purge_sessions/list_expired_sessions để xoá.
select cron.schedule(
  'purge-expired',
  '0 17 * * *',
  $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/purge-expired',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'purge-fn-key')
    ),
    body := '{}'::jsonb
  );
  $job$
);
