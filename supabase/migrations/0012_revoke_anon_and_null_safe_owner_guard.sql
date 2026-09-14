-- 0012 — bịt nợ N1 (mở rộng): prod tự GRANT `anon` cho 4 hàm mà local không có,
-- và guard chủ sở hữu trong 3 hàm quota THỦNG khi `auth.uid()` là NULL.
--
-- Đo 2026-08-21 (Management API, project prod): `anon` có EXECUTE trên
-- bump_rate_limit · debit_free_session · refund_free_session · next_utterance_seq.
-- Local (migration 0003:191-192) KHÔNG cấp — đúng cái bẫy auto-grant mà ops-runbook §7 cảnh báo.
--
-- Khai thác đã tái hiện trên LOCAL sau khi cố ý grant giống prod:
--   anon -> debit_free_session(<session của người khác>)  => 200, nạn nhân free 3 -> 2
--   anon -> refund_free_session(<session>)                => 200, free 3 -> 4
--   anon -> bump_rate_limit('share-report:1.2.3.4', ...)  => 200 true
-- Session uuid KHÔNG cần đoán: `get_shared_report` trả `'id', s.id` trong payload trang
-- chia sẻ công khai `/r/[token]`, còn anon key thì Next.js inline sẵn vào client bundle.
--
-- HAI lớp hỏng độc lập, vá cả hai:
--   (1) GRANT lệch  -> revoke tường minh bên dưới.
--   (2) `if v_user_id <> auth.uid()` -> với anon, auth.uid() NULL nên biểu thức ra NULL,
--       `if NULL` KHÔNG vào nhánh raise => guard vô hiệu.
--       ⚠️ KHÔNG siết dòng đó thành `is distinct from`: cron `sweep_abandoned_sessions`
--       CỐ Ý dựa vào chính tính chất NULL-không-raise để hoàn quota hộ user
--       (0006_retention_cron.sql:17-21). Siết là gãy sweeper — đã đo, test
--       `test_sweeper_abandoned_live_session_past_cap_...` đỏ ngay.
--       Thay vào đó THÊM một chốt chặn ĐÚNG anon, đọc role từ JWT claims. Đo trên local
--       2026-08-21: anon -> claims.role='anon' · service_role -> 'service_role' ·
--       cron/psql -> claims NULL. Chốt mới chỉ khớp 'anon', các đường hợp lệ đi qua y như cũ.
--
-- Idempotent: revoke/grant chạy lại vô hại; create or replace giữ nguyên owner + ACL.
-- Thân 3 hàm giữ NGUYÊN VĂN từ 0003_functions.sql, chỉ đổi đúng dòng guard.

-- ── (2) guard NULL-safe ───────────────────────────────────────────────────────
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
  -- Chặn ĐÚNG anon (0012). KHÔNG siết dòng `<> auth.uid()` bên dưới: cron
  -- (sweep_abandoned_sessions) cố ý dựa vào việc auth.uid() NULL không raise để hoàn
  -- quota hộ user — hợp đồng ghi ở 0006_retention_cron.sql:17-21.
  -- Đo 2026-08-21 trên local: anon qua PostgREST -> claims.role='anon'; service_role ->
  -- 'service_role'; cron/psql -> claims NULL. Chỉ 'anon' bị chặn.
  if nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' = 'anon' then
    raise exception 'anon không được gọi hàm này' using errcode = '42501';
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
  -- Chặn ĐÚNG anon (0012). KHÔNG siết dòng `<> auth.uid()` bên dưới: cron
  -- (sweep_abandoned_sessions) cố ý dựa vào việc auth.uid() NULL không raise để hoàn
  -- quota hộ user — hợp đồng ghi ở 0006_retention_cron.sql:17-21.
  -- Đo 2026-08-21 trên local: anon qua PostgREST -> claims.role='anon'; service_role ->
  -- 'service_role'; cron/psql -> claims NULL. Chỉ 'anon' bị chặn.
  if nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' = 'anon' then
    raise exception 'anon không được gọi hàm này' using errcode = '42501';
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
  -- Chặn ĐÚNG anon (0012). KHÔNG siết dòng `<> auth.uid()` bên dưới: cron
  -- (sweep_abandoned_sessions) cố ý dựa vào việc auth.uid() NULL không raise để hoàn
  -- quota hộ user — hợp đồng ghi ở 0006_retention_cron.sql:17-21.
  -- Đo 2026-08-21 trên local: anon qua PostgREST -> claims.role='anon'; service_role ->
  -- 'service_role'; cron/psql -> claims NULL. Chỉ 'anon' bị chặn.
  if nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' = 'anon' then
    raise exception 'anon không được gọi hàm này' using errcode = '42501';
  end if;
  if v_user_id <> auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;

  update public.sessions set last_seq = last_seq + 1 where id = p_session
    returning last_seq into v_seq;

  return v_seq;
end;
$$;

-- ── (1) đóng cửa: anon KHÔNG được gọi 4 hàm này ───────────────────────────────
revoke execute on function public.bump_rate_limit(text, interval, int) from anon;
revoke execute on function public.debit_free_session(uuid) from anon;
revoke execute on function public.refund_free_session(uuid) from anon;
revoke execute on function public.next_utterance_seq(uuid) from anon;

-- Khẳng định lại tập role ĐÚNG (idempotent; `create or replace` ở trên giữ ACL cũ,
-- dòng này chỉ để migration tự mô tả trạng thái mong muốn).
grant execute on function public.bump_rate_limit(text, interval, int) to authenticated, service_role;
grant execute on function public.debit_free_session(uuid) to authenticated, service_role;
grant execute on function public.refund_free_session(uuid) to authenticated, service_role;
grant execute on function public.next_utterance_seq(uuid) to authenticated, service_role;
