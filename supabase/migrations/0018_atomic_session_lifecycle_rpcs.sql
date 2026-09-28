-- 0018 — RPC atomic cho vòng đời session (start/end/cap), chuẩn bị cho lockdown 0019.
--
-- VÌ SAO (audit bảo mật 2026-09-28, port từ interview-copilot fix/session-quota-lockdown
-- 7e1bbc5/af5de5e/956ed41 — 2 audit bug giống hệt tái hiện ở Interview Hack): `authenticated`
-- có GRANT mức BẢNG trên `public.sessions` (INSERT/UPDATE — 0002_rls.sql:106, tái khẳng định
-- ở 0017). Policy `sessions_update_own` CHỈ kiểm `user_id = auth.uid()`, KHÔNG giới hạn CỘT.
-- Qua PostgREST, user tự PATCH được `status`/`started_at`/`cap_seconds`/`quota_debited`/
-- `quota_refunded`/`duration_sec`, hoặc INSERT session với cờ giả mạo sẵn. Khai thác: forge
-- `quota_debited=true, duration_sec=0` -> gọi `refund_free_session` -> tự reset
-- `quota_refunded=false` -> gọi refund lần nữa -> quota free tăng vô hạn (3 -> 5 -> ...).
-- `refund_free_session` (0003) còn nhận cả session ĐANG SỐNG (guard chỉ kiểm
-- `not debited or refunded or duration>=300`, không kiểm `ended_at`/`status`).
--
-- KHÁC VỚI BẢN COPILOT (adapt, không copy nguyên): Interview Hack ĐÃ BỎ report pipeline
-- (chỉ còn chế độ ứng viên — plan candidate-only 2026-09-14/16) nên `end_session` ở đây
-- KHÔNG có tham số `p_skip_report`/nhánh 'processing' chờ report — mọi lần kết thúc từ
-- 'live' chốt THẲNG status='done' (khớp hành vi hiện tại của route /end, xem
-- src/app/api/sessions/[id]/end/route.ts:84-97). Nhánh cap-pending (status='processing',
-- ended_reason='cap', ended_at NULL — do route utterances đánh dấu khi vượt cap) vẫn hoàn
-- tất về 'done'. Hack không có Polar billing/`enforce_interviewer_session_mode` trigger —
-- không port các phần đó (không tồn tại ở base để port).
--
-- Migration này CHỈ THÊM 3 hàm mới + grant — KHÔNG revoke gì trên `sessions` hay
-- `debit_free_session`/`refund_free_session`. App code cũ (update trực tiếp `sessions`,
-- gọi thẳng `debit_free_session`/`refund_free_session`) TIẾP TỤC CHẠY ĐƯỢC sau migration
-- này — khoá thật ở 0019 (lockdown), tách riêng để 2 migration áp lên prod theo 2 bước.
--
-- Cả 3 hàm SECURITY DEFINER + `set search_path = public` + owner guard tường minh
-- (`auth.uid() is null or v_row.user_id is distinct from auth.uid()` — CHẶT hơn 3 hàm quota
-- cũ, vì các hàm NÀY không có hợp đồng nào với cron cần auth.uid() NULL đi qua).

-- ===== start_session: gộp debit + chuyển live, idempotent, xử lý cả session cũ dở dang =====
create or replace function public.start_session(p_session uuid, p_mode session_mode default null)
returns public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sessions%rowtype;
  v_left int;
begin
  select * into v_row from public.sessions where id = p_session for update;

  if v_row.id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  if auth.uid() is null or v_row.user_id is distinct from auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;

  -- Đã live + đã debit: gọi lại (double-submit client, reload giữa buổi) -> trả nguyên
  -- trạng thái hiện tại, KHÔNG debit lần 2.
  if v_row.status = 'live' and v_row.quota_debited then
    return v_row;
  end if;

  -- LEGACY half-started: code cũ (route /start trước 0018) debit rồi update status
  -- KHÔNG cùng transaction — lỗi/crash giữa 2 bước để lại status='prep' nhưng
  -- quota_debited=true. Hoàn tất nốt bước update, KHÔNG debit lại (đã trừ rồi).
  if v_row.status = 'prep' and v_row.quota_debited and not v_row.quota_refunded then
    update public.sessions
      set status = 'live',
          started_at = now(),
          recording_started_at = now(),
          mode = coalesce(p_mode, mode)
      where id = p_session
      returning * into v_row;
    return v_row;
  end if;

  if v_row.status <> 'prep' then
    raise exception 'session % không ở trạng thái có thể bắt đầu buổi', p_session using errcode = 'P0001';
  end if;

  -- Từ đây: status='prep', chưa debit — đường debit bình thường, giữ NGUYÊN VĂN
  -- thông điệp lỗi của debit_free_session (0003) vì route map lỗi theo message.
  select free_sessions_left into v_left from public.profiles where id = v_row.user_id for update;
  if v_left is null then
    raise exception 'profile % không tồn tại', v_row.user_id using errcode = 'P0002';
  end if;
  if v_left <= 0 then
    raise exception 'hết buổi free' using errcode = 'P0001';
  end if;

  update public.profiles set free_sessions_left = free_sessions_left - 1 where id = v_row.user_id;

  update public.sessions
    set status = 'live',
        started_at = now(),
        recording_started_at = now(),
        mode = coalesce(p_mode, mode),
        quota_debited = true
    where id = p_session
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.start_session(uuid, session_mode) from public, anon;
grant execute on function public.start_session(uuid, session_mode) to authenticated, service_role;

-- ===== end_session: chốt ended_at/duration_sec (tính trong DB) thẳng status='done' + refund <5' =====
-- Hack không có report pipeline (khác copilot) — không có `p_skip_report`/nhánh 'processing'
-- chờ report; mọi lần kết thúc hợp lệ (fresh-end HOẶC cap-pending) đều ra 'done'.
create or replace function public.end_session(p_session uuid)
returns public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sessions%rowtype;
  v_duration int;
  v_is_fresh_end boolean;
  v_is_cap_pending_end boolean;
  v_left int;
begin
  select * into v_row from public.sessions where id = p_session for update;

  if v_row.id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  if auth.uid() is null or v_row.user_id is distinct from auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;

  -- Idempotent: đã ended -> trả nguyên trạng thái, KHÔNG refund lần 2 (audit #2).
  if v_row.ended_at is not null and v_row.status in ('processing', 'done') then
    return v_row;
  end if;

  v_is_fresh_end := v_row.status = 'live';
  v_is_cap_pending_end := v_row.status = 'processing' and v_row.ended_reason = 'cap' and v_row.ended_at is null;
  if not v_is_fresh_end and not v_is_cap_pending_end then
    raise exception 'session % không ở trạng thái có thể kết thúc', p_session using errcode = 'P0001';
  end if;
  -- prep / started_at NULL: KHÔNG suy ra duration=0 — reject tường minh (audit #2:
  -- refund_free_session cũ coalesce(duration,0) cho phép refund session CHƯA từng chạy).
  if v_row.started_at is null then
    raise exception 'session % chưa bắt đầu, không thể kết thúc', p_session using errcode = 'P0001';
  end if;

  v_duration := greatest(0, floor(extract(epoch from (now() - v_row.started_at)))::int);

  update public.sessions
    set ended_at = now(),
        duration_sec = v_duration,
        status = 'done',
        ended_reason = (case when v_row.ended_reason = 'cap' then 'cap' else 'user' end)::ended_reason_type
    where id = p_session
    returning * into v_row;

  -- Refund <5' — cùng transaction, tái dùng guard double-refund của quota_refunded.
  if v_row.quota_debited and not v_row.quota_refunded and v_duration < 300 then
    select free_sessions_left into v_left from public.profiles where id = v_row.user_id for update;
    if v_left is not null then
      update public.profiles set free_sessions_left = free_sessions_left + 1 where id = v_row.user_id;
      update public.sessions set quota_refunded = true where id = p_session returning * into v_row;
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.end_session(uuid) from public, anon;
grant execute on function public.end_session(uuid) to authenticated, service_role;

-- ===== mark_session_capped: server tự tính elapsed, không tin client báo đã cap =====
create or replace function public.mark_session_capped(p_session uuid)
returns public.sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sessions%rowtype;
  v_elapsed int;
begin
  select * into v_row from public.sessions where id = p_session for update;

  if v_row.id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  if auth.uid() is null or v_row.user_id is distinct from auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;
  if v_row.status <> 'live' then
    raise exception 'session % không ở trạng thái live', p_session using errcode = 'P0001';
  end if;
  if v_row.started_at is null then
    raise exception 'session % chưa bắt đầu', p_session using errcode = 'P0001';
  end if;

  -- Cùng công thức `computeElapsedSeconds` (src/lib/cap-clock.ts): floor((now-started_at)/1000s).
  v_elapsed := floor(extract(epoch from (now() - v_row.started_at)))::int;
  if v_elapsed <= v_row.cap_seconds then
    raise exception 'session % chưa vượt cap', p_session using errcode = 'P0001';
  end if;

  update public.sessions
    set status = 'processing', ended_reason = 'cap'
    where id = p_session
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.mark_session_capped(uuid) from public, anon;
grant execute on function public.mark_session_capped(uuid) to authenticated, service_role;
