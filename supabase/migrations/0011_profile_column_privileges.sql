-- 0011_profile_column_privileges.sql — bịt BYPASS QUOTA + hàng rào retention.
--
-- VÌ SAO (phát hiện 2026-08-17, phiên trả nợ P07):
-- `0002_rls.sql:105` cấp `grant select, update on public.profiles to authenticated`
-- — quyền UPDATE ở mức BẢNG, tức MỌI CỘT. Policy `profiles_update_self` chỉ giới hạn
-- DÒNG (`id = auth.uid()`), KHÔNG giới hạn cột. Hệ quả: bất kỳ user đã đăng nhập nào
-- cũng tự sửa được profile của chính mình qua PostgREST bằng anon key (vốn public
-- trong client bundle theo thiết kế):
--
--   PATCH /rest/v1/profiles?id=eq.<uid>   {"free_sessions_left": 9999}
--   PATCH /rest/v1/profiles?id=eq.<uid>   {"plan": "enterprise"}
--   PATCH /rest/v1/profiles?id=eq.<uid>   {"retention_days": 0}
--
-- `free_sessions_left` là TRẦN CHI PHÍ THẬT của sản phẩm (3 buổi free × 90 phút
-- Soniox + Claude). Tự nâng được = mọi rate limit dựng ở P07 đều vô nghĩa, hoá đơn
-- không có đáy. Đã verify: quyền này tồn tại trên CẢ local lẫn production.
--
-- `retention_days = 0` (hoặc âm) làm `list_expired_sessions` coi TOÀN BỘ session của
-- user là hết hạn → lần purge kế tiếp xoá sạch, không hàng rào nào chặn [M6].
--
-- Cách vá — 3 lớp độc lập, hỏng 1 lớp vẫn còn 2:
--  1. Quyền: `authenticated` chỉ còn UPDATE đúng cột `name`.
--  2. Ràng buộc: CHECK trên `retention_days` — kể cả service_role lỡ tay cũng bị chặn.
--  3. Chiều sâu: `purge_sessions` tự tính lại điều kiện hết hạn, không tin caller.
--
-- KHÔNG gãy gì: rà toàn `src/` không có đường nào app ghi `profiles` (chỉ select);
-- `free_sessions_left` chỉ bị đụng bởi `debit_free_session`/`refund_free_session`
-- (SECURITY DEFINER → chạy dưới quyền owner, không phụ thuộc grant của authenticated).

-- ===== Lớp 1: quyền theo CỘT =====
-- Thu hồi UPDATE mức bảng rồi cấp lại đúng 1 cột user được phép tự sửa.
revoke update on public.profiles from authenticated;
grant update (name) on public.profiles to authenticated;

-- `anon` chưa từng có quyền ghi — revoke cho chắc, remote hay tự GRANT cho anon
-- (xem docs/ops-runbook.md §7, đã cắn 1 lần với bump_rate_limit).
revoke update on public.profiles from anon;

-- ===== Lớp 2: hàng rào giá trị retention =====
-- Cận dưới 7 ngày: đủ ngắn cho khách muốn xoá sớm, đủ xa 0 để một lần set nhầm
-- không quét sạch dữ liệu. Cận trên 365: chặn giữ vô hạn, hợp hướng APPI.
-- NOT VALID: chỉ áp cho ghi MỚI, không quét lại dữ liệu cũ (mọi row hiện tại đều
-- default 90 nên vẫn hợp lệ; dùng NOT VALID để migration không khoá bảng lâu).
alter table public.profiles
  drop constraint if exists profiles_retention_days_range;
alter table public.profiles
  add constraint profiles_retention_days_range
  check (retention_days between 7 and 365) not valid;
alter table public.profiles validate constraint profiles_retention_days_range;

-- ===== Lớp 3: purge_sessions không tin caller =====
-- Trước: `delete from sessions where id = any(p_ids)` — xoá mù theo id. Bất kỳ ai
-- gọi được hàm (service_role) truyền nhầm id là mất dữ liệu khách VĨNH VIỄN (xoá
-- cứng, không audio, không backup ứng dụng).
-- Nay: tự join `profiles` tính lại `retention_days` — id chưa hết hạn thì bỏ qua,
-- không xoá. Không đổi hợp đồng: Edge Function `purge-expired` vẫn truyền id lấy từ
-- `list_expired_sessions` (đã hết hạn) nên hành vi đường chính giữ nguyên.
create or replace function public.purge_sessions(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.sessions s
  using public.profiles p
  where s.id = any(p_ids)
    and p.id = s.user_id
    and coalesce(s.ended_at, s.created_at) < now() - (p.retention_days * interval '1 day');
$$;

revoke all on function public.purge_sessions(uuid[]) from public;
revoke all on function public.purge_sessions(uuid[]) from anon;
revoke all on function public.purge_sessions(uuid[]) from authenticated;
grant execute on function public.purge_sessions(uuid[]) to service_role;
