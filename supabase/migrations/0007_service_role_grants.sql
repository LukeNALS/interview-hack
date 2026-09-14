-- 0007_service_role_grants.sql — cấp GRANT bảng tường minh cho `service_role`.
--
-- VÌ SAO CẦN (phát hiện ở phase-07 khi dựng DB test từ migration thuần):
-- `0002_rls.sql` ghi "service_role đã có full access mặc định (Supabase tự cấu
-- hình lúc tạo project) — không cần grant thêm". Ghi chú đó CHỈ đúng với project
-- cloud tạo thời auto-expose legacy. Với DB dựng thuần từ migration (local stack,
-- CI runner, project tạo mới từ 2026), `service_role` chỉ có `Dxtm`
-- (TRUNCATE/REFERENCES/TRIGGER) — KHÔNG có SELECT/INSERT/UPDATE/DELETE.
-- Hậu quả: mọi đường service-role của app (reports, report_jobs, audit_log,
-- export_jobs, Edge Function purge-expired) trả 42501 permission denied.
--
-- TRẠNG THÁI PRODUCTION LÚC VIẾT (verify 2026-08-14 qua Management API):
-- project prod ĐÃ có đủ DELETE/INSERT/SELECT/UPDATE trên cả 11
-- bảng public → migration này là **no-op trên prod**, không đổi hành vi gì. Nó
-- tồn tại để (a) local stack + CI khớp prod, (b) chặn bug tương lai: cờ
-- `auto_expose_new_tables` bị gỡ ngày 2026-10-30 (xem supabase/config.toml:23),
-- sau mốc đó MỌI bảng mới tạo trên prod cũng rơi vào đúng cái hố này.
--
-- `alter default privileges` ở cuối là phần quan trọng nhất: nó lo cho bảng
-- TƯƠNG LAI, để migration sau không phải nhớ grant lại.

grant usage on schema public to service_role;

-- Bảng + sequence hiện có.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

-- Bảng + sequence tạo về sau (bởi cùng role chạy migration này).
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
