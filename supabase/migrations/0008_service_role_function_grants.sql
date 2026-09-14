-- 0008_service_role_function_grants.sql — cấp EXECUTE cho `service_role` trên RPC
-- mà code server gọi bằng service-role client.
--
-- VÌ SAO CẦN (phát hiện phase-07 qua E2E spec share-readonly):
-- `0003_functions.sql:188-189` revoke `get_shared_report` khỏi PUBLIC rồi chỉ grant
-- lại cho `anon, authenticated` — KHÔNG có `service_role`. Nhưng
-- `src/app/r/[token]/page.tsx:59` gọi hàm đó qua `createServiceRoleClient()`.
-- Trên DB dựng thuần từ migration: RPC trả "permission denied for function
-- get_shared_report" -> `if (error || !data) notFound()` -> MỌI share link 404.
-- Lỗi bị nuốt hoàn toàn vì notFound() cũng là phản hồi cho token sai (cố ý, chống dò token).
--
-- Đối chiếu ngay bên cạnh: `bump_rate_limit` (0003:192) CÓ grant service_role — cùng
-- trang gọi cả 2 hàm, nên rate-limit chạy còn RPC chính thì chết. Đúng kiểu sót lẻ.
--
-- TRẠNG THÁI PRODUCTION (verify 2026-08-14 qua Management API):
-- prod ĐÃ có `service_role` trong grantee của get_shared_report (kèm anon/authenticated/
-- postgres) — di sản auto-expose legacy, giống chuyện GRANT bảng ở 0007. Nên migration
-- này là **no-op trên prod**, share link prod KHÔNG hỏng. Nó vá đúng chỗ lệch giữa
-- "prod dựng thời legacy" và "DB dựng từ migration" (local, CI, project mới).
--
-- 0007 chỉ grant TABLE + SEQUENCE; EXECUTE trên FUNCTION là mặt phẳng quyền riêng,
-- không nằm trong đó — nên phải có migration này.

grant execute on function public.get_shared_report(text) to service_role;

-- Các RPC còn lại 0003 chỉ grant cho `authenticated`. Hiện chưa route nào gọi chúng
-- bằng service-role client (sweep_abandoned_sessions gọi refund_free_session TRONG
-- security definer nên chạy quyền owner, không đụng grant này), nhưng cấp luôn cho
-- service_role để khỏi tái diễn đúng lớp lỗi trên khi có route mới.
grant execute on function public.debit_free_session(uuid) to service_role;
grant execute on function public.refund_free_session(uuid) to service_role;
grant execute on function public.next_utterance_seq(uuid) to service_role;

-- Hàm tạo về sau tự có EXECUTE cho service_role — chặn tái diễn ở gốc.
alter default privileges in schema public grant execute on functions to service_role;
