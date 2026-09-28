-- 0019 — khoá cột nhạy cảm trên `sessions` + siết `refund_free_session`/`debit_free_session`.
--
-- BẮT BUỘC deploy SAU KHI code app (đã đổi sang gọi start_session/end_session/
-- mark_session_capped — 0018) đã lên production. Trước migration này, `authenticated`
-- có GRANT mức BẢNG trên `sessions` — user tự PATCH thẳng `status`/`quota_debited`/
-- `quota_refunded`/`cap_seconds`/`duration_sec`/`started_at`/`ended_at` qua PostgREST
-- (audit 2026-09-28, port từ interview-copilot 956ed41 — cùng 2 bug audit xác nhận tái
-- hiện ở Interview Hack). Rollback SQL: plans/20260928-2040-session-quota-lockdown/rollback-0019.sql
-- (không phải migration — chạy tay nếu cần lùi mà VẪN giữ code đã chuyển sang RPC).
--
-- KHÁC VỚI BẢN COPILOT (adapt, không copy nguyên): rà toàn bộ `.from("sessions")` trong
-- src/ của Interview Hack (grep 2026-09-28) cho thấy KHÔNG có route/lib nào update cột
-- non-lifecycle bằng client user-scoped — Hack không có route CV (`cv_status`/`cv_text`/
-- `cv_file_path`/`cv_error` — cột tồn tại từ 0004 nhưng không route nào ghi), không có route
-- share (`share_token`/`share_expires_at` — cột tồn tại từ 0010/0014 nhưng không route nào
-- ghi, `get_shared_report` chỉ ĐỌC), không có speaker-roles writer, không có generate-questions
-- ghi `quick_eval`/`candidate_name` sau khi tạo. MỌI `.update()` trên `sessions` trong src/
-- (start/end/utterances routes) đều là cột vòng đời — sau khi 3 route này chuyển sang gọi
-- RPC (đợt code kế tiếp), `authenticated` KHÔNG CẦN quyền UPDATE cột nào trên `sessions` nữa.
-- Vì vậy Lớp 1 ở đây CHỈ revoke UPDATE (không re-grant cột nào) — khác cấu trúc 3-lớp của
-- copilot (revoke rồi grant lại danh sách cột cv/share/speaker). INSERT vẫn cần cột user tự
-- khai lúc tạo session.

-- ===== Lớp 1: cột INSERT/UPDATE của `authenticated` trên `sessions` =====
revoke insert, update on public.sessions from authenticated;

-- INSERT: chỉ cột user tự khai lúc tạo session (POST /api/sessions — src/app/api/sessions/route.ts).
-- KHÔNG có status/quota/cap/duration/started/ended — status default 'prep' (0001_init.sql),
-- kind default 'candidate' (0016), quota_debited/quota_refunded default false (0001), mọi cột
-- thời gian default NULL — INSERT không set các cột này vẫn ra đúng giá trị mặc định.
grant insert (
  user_id, candidate_name, position, mode, jd_text, wish_text, kind
) on public.sessions to authenticated;

-- UPDATE: KHÔNG cấp cột nào. Rà `.from("sessions").update(...)` trong src/ (2026-09-28) chỉ
-- còn 3 chỗ (start/end/utterances routes), cả 3 đều ghi cột vòng đời/quota — chuyển hết sang
-- start_session/end_session/mark_session_capped (SECURITY DEFINER, chạy dưới quyền owner,
-- không phụ thuộc grant này) ở đợt code kế tiếp. Nếu sau này thêm tính năng cần user tự sửa
-- cột khác (vd đổi candidate_name sau khi tạo) — thêm GRANT UPDATE (cột đó) ở migration riêng,
-- KHÔNG mở lại UPDATE mức bảng.

-- ===== Lớp 2: refund_free_session — chỉ service-role, thêm guard vòng đời =====
-- Trước: `authenticated` gọi trực tiếp được (0003) — route /end gọi qua client user.
-- Nay route /end đã chuyển sang `end_session` (0018, tự refund nội bộ dưới quyền owner) —
-- `authenticated` KHÔNG còn cần gọi thẳng hàm này nữa.
revoke all on function public.refund_free_session(uuid) from public, anon, authenticated;
grant execute on function public.refund_free_session(uuid) to service_role;

-- Guard vòng đời BỔ SUNG (audit #2): trước đây `coalesce(duration_sec, 0) >= 300` cho phép
-- refund một session ĐANG SỐNG (duration_sec NULL -> coi như 0 -> < 300 -> refund được dù
-- session chưa hề ended). Nay bắt buộc phải đã kết thúc thật (ended_at NOT NULL, status
-- khác 'live', duration_sec KHÔNG NULL) — không coalesce, thiếu dữ liệu thì từ chối thẳng.
-- Thân hàm giữ nguyên phần còn lại (double-refund guard qua quota_refunded, owner guard
-- NULL-safe cho cron — xem 0012) — sweeper (0006) đã tự set ended_at/duration_sec/status
-- TRƯỚC KHI gọi refund nên guard mới không chặn nhầm đường sweep.
create or replace function public.refund_free_session(p_session uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_status text;
  v_ended_at timestamptz;
  v_quota_debited boolean;
  v_quota_refunded boolean;
  v_duration int;
  v_left int;
begin
  select user_id, status, ended_at, quota_debited, quota_refunded, duration_sec
    into v_user_id, v_status, v_ended_at, v_quota_debited, v_quota_refunded, v_duration
    from public.sessions where id = p_session for update;

  if v_user_id is null then
    raise exception 'session % không tồn tại', p_session using errcode = 'P0002';
  end if;
  -- Giữ NGUYÊN VĂN guard NULL-safe cho anon + hợp đồng cron (0012/0006) — cron gọi hộ
  -- lúc auth.uid() NULL vẫn phải đi qua được, CHỈ chặn đúng anon.
  if nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' = 'anon' then
    raise exception 'anon không được gọi hàm này' using errcode = '42501';
  end if;
  -- NULL tường minh: auth.uid() NULL = cron/service_role gọi hộ (hợp đồng 0006) → đi qua;
  -- có danh tính mà khác chủ → chặn. Không dùng `<>` (NULL làm IF thành false một cách ngầm).
  if auth.uid() is not null and v_user_id is distinct from auth.uid() then
    raise exception 'không có quyền trên session %', p_session using errcode = '42501';
  end if;

  -- Guard vòng đời MỚI (0019): session phải đã kết thúc thật — không suy đoán từ NULL.
  if v_ended_at is null or v_status = 'live' or v_duration is null then
    raise exception 'session % chưa kết thúc, không thể hoàn buổi free', p_session using errcode = 'P0001';
  end if;
  if not v_quota_debited or v_quota_refunded or v_duration >= 300 then
    raise exception 'session % không đủ điều kiện hoàn buổi free', p_session using errcode = 'P0001';
  end if;

  update public.profiles set free_sessions_left = free_sessions_left + 1 where id = v_user_id
    returning free_sessions_left into v_left;
  update public.sessions set quota_refunded = true where id = p_session;

  return v_left;
end;
$$;

-- ===== Lớp 3: debit_free_session — chỉ start_session (nội bộ) mới cần gọi =====
-- Sau lockdown, UPDATE trực tiếp `sessions` đã bị khoá nên "debit rồi tự PATCH status"
-- không còn khai thác được nữa — nhưng thu hồi EXECUTE khỏi `authenticated` luôn cho
-- gọn bề mặt tấn công (route /start không còn gọi thẳng hàm này — đã chuyển sang
-- start_session, tự xử lý debit nội bộ dưới quyền owner, không qua grant này).
revoke all on function public.debit_free_session(uuid) from public, anon, authenticated;
grant execute on function public.debit_free_session(uuid) to service_role;
