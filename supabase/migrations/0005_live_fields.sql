-- 0005_live_fields.sql — cap layer field cho live flow (P05).
--
-- VERIFY trước khi viết (bắt buộc theo brief P05-BE): 0001_init.sql đã có sẵn
-- utterances.en_pending, unique(session_id, client_utt_id), unique(session_id, seq),
-- index utterances_session_seq_idx (session_id, seq), và sessions.ended_reason —
-- KHÔNG lặp lại ở đây (xem deviation trong report P05-BE). Cột thật sự còn thiếu
-- so với phase-05 spec CHỈ có sessions.cap_seconds.

alter table public.sessions
  add column cap_seconds int not null default 5400;

-- Cột mới trên bảng sessions đã có sẵn (grant select,insert,update,delete on
-- public.sessions to authenticated ở 0002_rls.sql) — table-level grant, không
-- cần grant lại theo cột (giống pattern 0004_cv_fields.sql).
