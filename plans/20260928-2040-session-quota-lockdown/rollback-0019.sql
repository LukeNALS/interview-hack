-- ROLLBACK cho 0019_lock_sensitive_session_columns.sql — CHẠY TAY, KHÔNG PHẢI migration.
--
-- Dùng khi cần lùi lockdown 0019 nhưng VẪN GIỮ code app đã chuyển sang gọi
-- start_session/end_session/mark_session_capped (0018) — tức chỉ khôi phục grant mức
-- BẢNG cũ trên `sessions` + định nghĩa/GRANT cũ của `refund_free_session`/`debit_free_session`,
-- KHÔNG đụng gì tới 0018 (0018 additive, không cần rollback riêng — không xoá 3 RPC mới ở đây
-- vì code có thể vẫn đang gọi chúng; muốn gỡ hẳn 0018 thì `drop function` thủ công sau).
--
-- SAU KHI CHẠY: hệ thống trở về đúng bề mặt tấn công đã mô tả trong 0018/0019 (user tự
-- PATCH được status/quota/cap/duration/started/ended qua PostgREST) — CHỈ dùng tạm thời
-- để gỡ rối một lỗi vận hành do 0019 gây ra, KHÔNG để chạy production lâu dài.

-- ===== Khôi phục grant mức BẢNG trên `sessions` (nguyên văn 0017/0002) =====
revoke insert, update on public.sessions from authenticated;
grant select, insert, update, delete on public.sessions to authenticated;

-- ===== Khôi phục refund_free_session về định nghĩa + grant của 0012 =====
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

revoke all on function public.refund_free_session(uuid) from public, anon;
grant execute on function public.refund_free_session(uuid) to authenticated, service_role;

-- ===== Khôi phục debit_free_session về grant của 0003/0012 (thân hàm không đổi ở 0019) =====
revoke all on function public.debit_free_session(uuid) from public, anon;
grant execute on function public.debit_free_session(uuid) to authenticated, service_role;
