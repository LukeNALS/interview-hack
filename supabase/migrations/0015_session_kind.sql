-- 0015 — chế độ Ứng viên (plan 20260905-0820-candidate-mode):
-- sessions.kind phân biệt buổi của NGƯỜI PHỎNG VẤN (mặc định, giữ nguyên mọi hành vi cũ)
-- và buổi của ỨNG VIÊN (mô tả buổi nằm ở jd_text; producer = gợi ý TRẢ LỜI, không report).
-- Bảng suggestions tái dùng cho answer hint — không bảng mới.

alter table public.sessions
  add column kind text not null default 'interviewer'
  constraint sessions_kind_check check (kind in ('interviewer', 'candidate'));
