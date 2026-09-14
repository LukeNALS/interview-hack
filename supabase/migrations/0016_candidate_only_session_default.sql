-- 0016 — Interview Hack chỉ còn chế độ Ứng viên: mọi session mới phải tạo
-- kind='candidate' (app-level đã khoá bằng z.literal ở createSessionSchema).
-- Đổi DEFAULT của cột cho khớp - dữ liệu cũ kind='interviewer' GIỮ NGUYÊN
-- (đọc được, không còn đường tạo mới) và constraint check ở 0015 không đổi.

alter table public.sessions
  alter column kind set default 'candidate';
