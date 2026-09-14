-- 0014 — vá M16 (share token bất tử).
--
-- Đo 2026-08-22 trước khi sửa:
--   · bảng `sessions` chỉ có `share_token text` — KHÔNG cột hạn nào.
--   · `get_shared_report` (bản 0013) chỉ khớp `share_token`, không kiểm hạn.
--   · prod: 0 session, 0 share_token ⇒ migration này KHÔNG chạm dữ liệu khách nào.
--   · ĐÍNH CHÍNH mô tả nợ ở §7 ("không thu hồi được"): `DELETE /api/sessions/:id/share` CÓ
--     tồn tại và thu hồi bằng `share_token = null` + ghi audit. Cái thiếu thật là (a) hạn dùng,
--     và (b) nút thu hồi trên UI — (b) để phiên sau.
--
-- Vá: thêm `share_expires_at`; link hết hạn thì `get_shared_report` trả NULL — GIỮ hợp đồng của
-- 0013 (token không dùng được => NULL, KHÔNG raise; raise làm PostgREST đáp HTTP 500 text thuần).
-- Người dùng vẫn thấy đúng trang 404 như token sai, không phân biệt được hai ca — cố ý, để kẻ dò
-- token không suy ra được token nào từng tồn tại.
--
-- Idempotent: `add column if not exists`, backfill có điều kiện, constraint drop-then-add,
-- `create or replace` hàm.

alter table public.sessions add column if not exists share_expires_at timestamptz;

comment on column public.sessions.share_expires_at is
  'Hạn của share link. NULL khi chưa chia sẻ. Route POST /share đặt now() + 30 ngày và gia hạn mỗi lần gọi lại.';

-- Token cấp trước migration này (nếu có ở dev/local) được gán hạn kể từ thời điểm apply — không
-- để tồn tại token vô hạn nào sau khi cột đã có.
update public.sessions
   set share_expires_at = now() + interval '30 days'
 where share_token is not null and share_expires_at is null;

-- Bất biến: đã có token thì bắt buộc có hạn. Chặn đường tạo token vô hạn ở tầng DB, kể cả khi
-- một caller nào đó quên set hạn.
alter table public.sessions drop constraint if exists sessions_share_token_requires_expiry;
alter table public.sessions add constraint sessions_share_token_requires_expiry
  check (share_token is null or share_expires_at is not null);

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
  -- Hết hạn => coi như không tồn tại (M16). Cùng nhánh với token sai nên caller chỉ thấy NULL.
  select id into v_session_id
    from public.sessions
   where share_token = p_token
     and share_expires_at is not null
     and share_expires_at > now();

  -- Token không khớp / hết hạn => NULL, KHÔNG raise (nợ N3, migration 0013): raise làm PostgREST
  -- đáp HTTP 500 text thuần, bẩn log và không phân biệt được với lỗi phân quyền.
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
