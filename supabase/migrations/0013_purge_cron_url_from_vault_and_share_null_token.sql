-- 0013 — vá M5 (cron nhúng cứng URL prod) + N3 (share token sai đẻ HTTP 500 text thuần).
--
-- ═══ M5 ═══
-- `0006_retention_cron.sql:166` nhúng thẳng URL Edge Function PROD vào job `purge-expired`,
-- nên MỌI database chạy migration đó (local, CI) cũng POST lên production mỗi ngày 17:00 UTC.
-- Không phải lý thuyết — đo 2026-08-21 trên máy local: `net._http_response` có bản ghi
--   id=2 | 401 | {"code":"UNAUTHORIZED_NO_AUTH_HEADER"} | 2026-08-19 17:00:00+00
-- tức request ĐÃ rời máy local và tới Edge Function prod, chỉ bị từ chối vì header
-- Authorization thành NULL (`'Bearer ' || NULL` = NULL) do vault local rỗng. "Fail-safe" cũ là
-- MAY, không phải thiết kế: nó chặn ở phía prod chứ không chặn ở phía người gửi.
--
-- Vá: URL đọc từ vault y như key, và job TỰ THOÁT khi thiếu bất kỳ secret nào ⇒ database không
-- được cấu hình (local/CI) thì KHÔNG gửi gì cả. Hàng rào nằm ở phía người gửi.
--
-- ═══ N3 ═══
-- `get_shared_report` raise `errcode='P0002'` khi token không khớp, nhưng PostgREST 14.16 trả
-- **HTTP 500 + body text thuần "Something went wrong"** (đo 2026-08-21 bằng curl -i), không phải
-- JSON có `code`. Hệ quả: mỗi token sai đẻ 1 dòng 500 trong log, và client không phân biệt nổi
-- "token sai" với "bị từ chối quyền".
-- Vá: token không khớp là chuyện BÌNH THƯỜNG của một endpoint công khai, không phải lỗi hệ thống
-- → trả NULL. PostgREST trả 200 + body `null`. `src/app/r/[token]/page.tsx` đang kiểm
-- `if (error || !data) notFound()` nên không phải sửa app.
--
-- Idempotent: `create or replace` + `cron.schedule` cùng jobname là upsert (pg_cron >= 1.4).

-- ═══ N3: token sai -> NULL, không raise ═══
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
  -- Token không khớp => NULL (caller hiểu là 404). KHÔNG raise: PostgREST biến exception thành
  -- HTTP 500 text thuần, vừa bẩn log vừa không phân biệt được với lỗi phân quyền (nợ N3).
  if v_session_id is null then
    return null;
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
    'report', case
      when r.id is null then null
      else jsonb_build_object(
        'scorecard', r.scorecard,
        'strengths', r.strengths,
        'cautions', r.cautions,
        'evidence', r.evidence
      )
    end,
    'utterances', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'seq', u.seq,
          'speaker', u.speaker,
          'lang', u.lang,
          'text_orig', u.text_orig,
          'translations', u.translations,
          't_start_ms', u.t_start_ms
        )
        order by u.seq
      )
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

-- ═══ M5: URL của Edge Function đọc từ vault, thiếu cấu hình thì KHÔNG gửi ═══
-- Thay job cũ (cùng jobname => upsert). Prod cần secret `purge-fn-url`; local/CI không có
-- secret nào nên job chạy tới `raise notice` rồi thoát, KHÔNG phát sinh request nào.
select cron.schedule(
  'purge-expired',
  '0 17 * * *',
  $job$
  do $purge$
  declare
    v_url text;
    v_key text;
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'purge-fn-url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'purge-fn-key';

    -- Database chưa được cấu hình (local/CI) => im lặng bỏ lượt. Đây là hàng rào CÓ CHỦ ĐÍCH
    -- chặn ở phía người gửi, thay cho việc trước đây gửi thẳng lên prod rồi nhận 401 (nợ M5).
    if v_url is null or v_key is null then
      raise notice 'purge-expired: thiếu vault secret (purge-fn-url/purge-fn-key) — bỏ lượt này';
      return;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := '{}'::jsonb
    );
  end
  $purge$;
  $job$
);
